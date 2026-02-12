import { existsSync } from "fs";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, resolveOriginChannel, resolveAgentChannel } from "../shared";
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
      channel: Type.Optional(
        Type.String({
          description:
            'Origin channel for notifications, in "channel|target" format (e.g. "telegram|123456789"). Pass this when calling from an agent tool context so notifications reach the right channel.',
        }),
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

        // Build channel from ctx if available
        let ctxChannel: string | undefined;
        if (ctx.messageChannel && ctx.agentAccountId) {
          // messageChannel might be "telegram|123456789" — inject account
          const parts = ctx.messageChannel.split("|");
          if (parts.length >= 2) {
            ctxChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
          }
        } else if (ctx.messageChannel && ctx.messageChannel.includes("|")) {
          ctxChannel = ctx.messageChannel;
        }

        // Resolve origin channel with fallback chain:
        // 1. explicit params.channel > ctx-based channel > agentChannels lookup
        // 2. resolveOriginChannel from tool context
        // 3. If still "unknown", fall back to resolveAgentChannel(workdir)
        let originChannel = resolveOriginChannel(
          { id: _id },
          params.channel || ctxChannel || resolveAgentChannel(workdir),
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
