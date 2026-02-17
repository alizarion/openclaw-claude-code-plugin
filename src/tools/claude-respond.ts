import { Type } from "@sinclair/typebox";
import { sessionManager, pluginConfig, resolveAgentChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeRespondTool(ctx?: OpenClawPluginToolContext) {
  // Build channel from factory context if available.
  // Priority: 1) ctx.messageChannel with injected accountId
  //           2) resolveAgentChannel(ctx.workspaceDir) from agentChannels config
  //           3) ctx.messageChannel as-is (if it already has |)
  let fallbackChannel: string | undefined;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  }
  if (!fallbackChannel && ctx?.workspaceDir) {
    fallbackChannel = resolveAgentChannel(ctx.workspaceDir);
  }
  if (!fallbackChannel && ctx?.messageChannel && ctx.messageChannel.includes("|")) {
    fallbackChannel = ctx.messageChannel;
  }

  return {
    name: "claude_respond",
    description:
      "Send a follow-up message to a running Claude Code session. The session must be running. Sessions are multi-turn by default, so this works with any session unless it was launched with multi_turn_disabled: true.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session name or ID to respond to",
      }),
      message: Type.String({
        description: "The message to send to the session",
      }),
      interrupt: Type.Optional(
        Type.Boolean({
          description:
            "If true, interrupt the current turn before sending the message. Useful to redirect the session mid-response.",
        }),
      ),
      userInitiated: Type.Optional(
        Type.Boolean({
          description:
            "Set to true when the message comes from the user (not auto-generated). Resets the auto-respond counter and bypasses the auto-respond limit.",
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

      const session = sessionManager.resolve(params.session);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session "${params.session}" not found.`,
            },
          ],
        };
      }

      if (session.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}). Cannot send a message to a non-running session.`,
            },
          ],
        };
      }

      // Auto-respond safety cap
      const maxAutoResponds = pluginConfig.maxAutoResponds ?? 10;
      if (params.userInitiated) {
        // User-initiated: reset counter and allow through
        session.resetAutoRespond();
      } else if (session.autoRespondCount >= maxAutoResponds) {
        // Agent auto-respond but limit reached: return warning, do NOT send
        return {
          content: [
            {
              type: "text",
              text: `⚠️ Auto-respond limit reached (${session.autoRespondCount}/${maxAutoResponds}). Ask the user to provide the answer for session ${session.name}. Then call claude_respond with their answer and set userInitiated: true to reset the counter.`,
            },
          ],
        };
      }

      try {
        // Optionally interrupt the current turn
        if (params.interrupt) {
          await session.interrupt();
        }

        // Send the message
        await session.sendMessage(params.message);

        // Increment auto-respond counter (only for agent-initiated)
        if (!params.userInitiated) {
          session.incrementAutoRespond();
        }

        // Level 1: Send ↩️ Responded notification to Telegram
        if (sessionManager) {
          const respondMsg = [
            `↩️ [${session.name}] Responded:`,
            params.message.length > 200 ? params.message.slice(0, 200) + "..." : params.message,
          ].join("\n");
          sessionManager.deliverToTelegram(session, respondMsg, "responded");
        }

        const msgSummary =
          params.message.length > 80
            ? params.message.slice(0, 80) + "..."
            : params.message;

        return {
          content: [
            {
              type: "text",
              text: [
                `Message sent to session ${session.name} [${session.id}].`,
                params.interrupt ? `  (interrupted current turn first)` : "",
                `  Message: "${msgSummary}"`,
                ``,
                `Use claude_output to see the response.`,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error sending message: ${err.message}`,
            },
          ],
        };
      }
    },
  };
}
