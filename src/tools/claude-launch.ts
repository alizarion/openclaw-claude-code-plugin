import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, resolveOriginChannel, resolveAgentChannel } from "../shared";

export function registerClaudeLaunchTool(api: any): void {
  api.registerTool(
    {
      name: "claude_launch",
      description:
        "Launch a Claude Code session in background to execute a development task. Supports resuming previous sessions and multi-turn conversations. Returns a session ID and name for tracking.",
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
        multi_turn: Type.Optional(
          Type.Boolean({
            description:
              "Enable multi-turn mode. The session stays open for follow-up messages via claude_respond. Default: false.",
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
              'Origin channel for notifications, in "channel:target" format (e.g. "telegram:123456789"). Pass this when calling from an agent tool context so notifications reach the right channel.',
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

        const workdir = params.workdir || pluginConfig.defaultWorkdir || process.cwd();
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
            multiTurn: params.multi_turn,
            permissionMode: params.permission_mode,
            // _id is the tool call ID (e.g. "toolu_xxx"), not a channel ID.
            // When the agent passes params.channel explicitly, use that;
            // otherwise resolveOriginChannel falls back to config.
            // Priority: explicit params.channel > agentChannels lookup by workdir > resolveOriginChannel fallback.
            originChannel: resolveOriginChannel(
              { id: _id },
              params.channel || resolveAgentChannel(workdir),
            ),
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
          if (params.multi_turn) {
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
    },
    { optional: false },
  );
}
