import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, resolveOriginChannel, resolveAgentChannel, resolveAgentId } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeLaunchTool(ctx: OpenClawPluginToolContext) {
  console.log(`[claude-launch] Factory ctx: agentId=${ctx.agentId}, workspaceDir=${ctx.workspaceDir}, messageChannel=${ctx.messageChannel}, agentAccountId=${ctx.agentAccountId}`);

  return {
    name: "claude_launch",
    description:
      "Launch a Claude Code session in background to execute a development task. Sessions are multi-turn by default — they stay open for follow-up messages via claude_respond. Set multi_turn_disabled: true for fire-and-forget sessions. Supports resuming previous sessions. Returns a session ID and name for tracking.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task prompt to execute" }),
      name: Type.Optional(
        Type.String({
          description:
            "Short human-readable name for the session (kebab-case, e.g. 'fix-auth'). Auto-generated from prompt if omitted.",
        }),
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to cwd)" }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model name to use" }),
      ),
      max_budget_usd: Type.Optional(
        Type.Number({
          description: "Maximum budget in USD (default 5)",
        }),
      ),
      system_prompt: Type.Optional(
        Type.String({ description: "Additional system prompt" }),
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "List of allowed tools",
        }),
      ),
      resume_session_id: Type.Optional(
        Type.String({
          description:
            "Claude session ID to resume (from a previous session's claudeSessionId). Continues the conversation from where it left off.",
        }),
      ),
      fork_session: Type.Optional(
        Type.Boolean({
          description:
            "When resuming, fork to a new session instead of continuing the existing one. Use with resume_session_id.",
        }),
      ),
      multi_turn_disabled: Type.Optional(
        Type.Boolean({
          description:
            "Disable multi-turn mode. By default sessions stay open for follow-up messages. Set to true for fire-and-forget sessions.",
        }),
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("default"),
            Type.Literal("plan"),
            Type.Literal("acceptEdits"),
            Type.Literal("bypassPermissions"),
          ],
          {
            description:
              "Permission mode for the session. Defaults to plugin config or 'bypassPermissions'.",
          },
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running.",
            },
          ],
        };
      }

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const maxBudgetUsd = params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5;

      try {
        // Resolve resume_session_id: accept name, internal ID, or Claude UUID
        let resolvedResumeId = params.resume_session_id;
        if (resolvedResumeId) {
          const resolved = sessionManager.resolveClaudeSessionId(resolvedResumeId);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Could not resolve resume_session_id "${resolvedResumeId}" to a Claude session ID. Use claude_sessions to list available sessions.`,
                },
              ],
            };
          }
          resolvedResumeId = resolved;
        }

        // Build channel from ctx if available.
        // Priority: 1) ctx.messageChannel with injected accountId (if multi-segment)
        //           2) resolveAgentChannel(ctx.workspaceDir) from agentChannels config
        //           3) resolveAgentChannel(workdir) as secondary workspace lookup
        //           4) ctx.messageChannel as-is (if it already has |)
        let ctxChannel: string | undefined;
        if (ctx.messageChannel && ctx.agentAccountId) {
          const parts = ctx.messageChannel.split("|");
          if (parts.length >= 2) {
            ctxChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
          }
        }
        // If messageChannel was bare (e.g. "telegram"), fall back to workspace-based lookup
        if (!ctxChannel && ctx.workspaceDir) {
          ctxChannel = resolveAgentChannel(ctx.workspaceDir);
        }
        if (!ctxChannel && ctx.messageChannel && ctx.messageChannel.includes("|")) {
          ctxChannel = ctx.messageChannel;
        }

        // Resolve origin channel with fallback chain:
        // 1. ctx-based channel (from above)
        // 2. resolveAgentChannel(workdir) — workdir may differ from ctx.workspaceDir
        // 3. resolveOriginChannel falls back to pluginConfig.fallbackChannel
        let originChannel = resolveOriginChannel(
          { id: _id },
          ctxChannel || resolveAgentChannel(workdir),
        );
        if (originChannel === "unknown") {
          const agentChannel = resolveAgentChannel(workdir);
          if (agentChannel) {
            originChannel = agentChannel;
          }
        }

        // Guard: require autonomy skill in the agent's workspace before spawning.
        // The skill defines how the agent should handle Claude Code interactions
        // (auto-respond, ask user, etc.). Without it, prompt the agent to set it up.
        const agentWorkspace = ctx.workspaceDir || workdir;
        const autonomySkillPath = join(agentWorkspace, "skills", "claude-code-autonomy", "SKILL.md");
        if (!existsSync(autonomySkillPath)) {
          console.log(`[claude-launch] Autonomy skill not found at ${autonomySkillPath} — blocking launch`);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: [
                  `ERROR: Launch blocked — no autonomy skill found.`,
                  ``,
                  `No autonomy skill found. You MUST ask the user what level of autonomy they want to give Claude Code sessions. Then create the skill at skills/claude-code-autonomy/ with their preferences. Only then can you launch sessions.`,
                  ``,
                  `Do NOT create the skill without asking the user first. Ask them how they want you to handle Claude Code interactions. For example:`,
                  `- "Respond to everything automatically except architecture choices"`,
                  `- "Always ask me before responding"`,
                  `- "Handle everything yourself, just notify me when done"`,
                  ``,
                  `After the user responds, create the skill:`,
                  `1. Create directory: skills/claude-code-autonomy/`,
                  `2. Create SKILL.md with structured rules based on the user's response`,
                  `3. Create autonomy.md with the user's raw preferences`,
                  `4. Then re-call claude_launch to start the session.`,
                ].join("\n"),
              },
            ],
          };
        }

        // Guard: require heartbeat configuration for the agent before spawning.
        // Heartbeat enables automatic "waiting for input" notifications so the
        // agent gets nudged when a Claude Code session needs attention.
        const agentId = ctx.agentId || resolveAgentId(agentWorkspace);
        if (agentId) {
          const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");
          let heartbeatConfigured = false;
          try {
            if (existsSync(openclawConfigPath)) {
              const raw = readFileSync(openclawConfigPath, "utf-8");
              const openclawConfig = JSON.parse(raw);
              const agentsList = openclawConfig?.agents?.list;
              if (Array.isArray(agentsList)) {
                const agentEntry = agentsList.find((a: any) => a.id === agentId);
                if (agentEntry && agentEntry.heartbeat != null) {
                  heartbeatConfigured = true;
                }
              }
            }
          } catch (err: any) {
            console.log(`[claude-launch] Failed to read openclaw config at ${openclawConfigPath}: ${err.message}`);
          }

          if (!heartbeatConfigured) {
            console.log(`[claude-launch] Heartbeat not configured for agent "${agentId}" — blocking launch`);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: [
                    `ERROR: Launch blocked — no heartbeat configured for this agent.`,
                    ``,
                    `Claude Code sessions require heartbeat to be enabled for automatic "waiting for input" notifications.`,
                    ``,
                    `You must configure the heartbeat FIRST. Here's what to do:`,
                    ``,
                    `1. Edit ~/.openclaw/openclaw.json and add heartbeat config for agent "${agentId}":`,
                    ``,
                    `   jq '.agents.list |= map(if .id == "${agentId}" then . + {"heartbeat": {"every": "5s", "target": "last"}} else . end)' ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json`,
                    ``,
                    `2. Verify the config was applied:`,
                    ``,
                    `   cat ~/.openclaw/openclaw.json | jq '.agents.list[] | select(.id == "${agentId}") | .heartbeat'`,
                    ``,
                    `3. Launch a Claude Code session to restart the Gateway and wake you back:`,
                    ``,
                    `   claude_launch(`,
                    `     prompt="STEP 1: Restart Gateway to activate heartbeat: openclaw gateway restart`,
                    `             STEP 2: Wait 5 seconds`,
                    `             STEP 3: Wake the agent: openclaw system event --text 'Heartbeat configured, continuing task' --mode now`,
                    `             STEP 4: Continue the original task: [USER_TASK]",`,
                    `     name="setup-heartbeat"`,
                    `   )`,
                  ].join("\n"),
                },
              ],
            };
          }
        }

        // Guard: require HEARTBEAT.md with real content in the agent's workspace.
        // The heartbeat file tells the agent what to do during heartbeat cycles
        // (e.g. check for waiting Claude Code sessions). Without real content,
        // the agent won't know how to handle waiting sessions.
        const heartbeatMdPath = join(agentWorkspace, "HEARTBEAT.md");
        let heartbeatMdValid = false;
        try {
          if (existsSync(heartbeatMdPath)) {
            const heartbeatContent = readFileSync(heartbeatMdPath, "utf-8");
            // Check if file has real content (not just comments, blank lines, or whitespace)
            const effectivelyEmpty = /^(\s|#.*)*$/.test(heartbeatContent);
            if (!effectivelyEmpty) {
              heartbeatMdValid = true;
            }
          }
        } catch (err: any) {
          console.log(`[claude-launch] Failed to read HEARTBEAT.md at ${heartbeatMdPath}: ${err.message}`);
        }

        if (!heartbeatMdValid) {
          console.log(`[claude-launch] HEARTBEAT.md missing or empty at ${heartbeatMdPath} — blocking launch`);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: [
                  `ERROR: Launch blocked — no HEARTBEAT.md file found or file is effectively empty.`,
                  ``,
                  `Claude Code sessions require a HEARTBEAT.md with real content so the agent can check for waiting sessions.`,
                  ``,
                  `You must create HEARTBEAT.md FIRST. Here's what to do:`,
                  ``,
                  `1. Create ${agentWorkspace}/HEARTBEAT.md with this content:`,
                  ``,
                  `cat > ${agentWorkspace}/HEARTBEAT.md << 'EOF'`,
                  `# Heartbeat ${agentId} Agent`,
                  ``,
                  `## Check Claude Code sessions`,
                  `Si des sessions Claude Code sont en attente (waiting for input) :`,
                  `1. \`claude_sessions\` pour lister les sessions actives`,
                  `2. Si session waiting → \`claude_output(session)\` pour voir la question`,
                  `3. Traiter ou notifier l'utilisateur`,
                  ``,
                  `Sinon → HEARTBEAT_OK`,
                  `EOF`,
                  ``,
                  `2. Verify the heartbeat frequency is set to 30s for fast response:`,
                  ``,
                  `cat ~/.openclaw/openclaw.json | jq '.agents.list[] | select(.id == "${agentId}") | .heartbeat.every'`,
                  ``,
                  `If NOT "30s", update it:`,
                  ``,
                  `jq '.agents.list |= map(if .id == "${agentId}" then .heartbeat.every = "30s" else . end)' ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json`,
                  ``,
                  `3. Launch Claude Code to restart Gateway:`,
                  ``,
                  `   claude_launch(`,
                  `     prompt="STEP 1: Restart Gateway: openclaw gateway restart`,
                  `             STEP 2: Wait 5s`,
                  `             STEP 3: Wake agent: openclaw system event --text 'HEARTBEAT.md configured' --mode now`,
                  `             STEP 4: Continue task: [USER_TASK]",`,
                  `     name="setup-heartbeat-md"`,
                  `   )`,
                ].join("\n"),
              },
            ],
          };
        }

        const session = sessionManager.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: params.model || pluginConfig.defaultModel,
          maxBudgetUsd,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId: resolvedResumeId,
          forkSession: params.fork_session,
          multiTurn: !params.multi_turn_disabled,
          permissionMode: params.permission_mode,
          originChannel,
        });

        const promptSummary =
          params.prompt.length > 80
            ? params.prompt.slice(0, 80) + "..."
            : params.prompt;

        const details = [
          `Session launched successfully.`,
          `  Name: ${session.name}`,
          `  ID: ${session.id}`,
          `  Dir: ${workdir}`,
          `  Model: ${session.model ?? "default"}`,
          `  Prompt: "${promptSummary}"`,
        ];

        if (params.resume_session_id) {
          details.push(`  Resume: ${params.resume_session_id}${params.fork_session ? " (forked)" : ""}`);
        }
        if (params.multi_turn_disabled) {
          details.push(`  Mode: single-turn (fire-and-forget)`);
        } else {
          details.push(`  Mode: multi-turn (use claude_respond to send follow-up messages)`);
        }

        details.push(``);
        details.push(`Use claude_sessions to check status, claude_output to see output.`);

        return {
          content: [
            {
              type: "text",
              text: details.join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching session: ${err.message}`,
            },
          ],
        };
      }
    },
  };
}
