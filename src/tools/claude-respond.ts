import { Type } from "@sinclair/typebox";
import { sessionManager, notificationRouter, resolveOriginChannel, resolveAgentChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeRespondTool(ctx?: OpenClawPluginToolContext) {
  // Build channel from factory context if available
  let fallbackChannel: string | undefined;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  } else if (ctx?.messageChannel && ctx.messageChannel.includes("|")) {
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
      channel: Type.Optional(
        Type.String({
          description:
            'Origin channel in "channel|target" format (e.g. "telegram|123456789"). Pass this when calling from an agent tool context.',
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

      try {
        // Optionally interrupt the current turn
        if (params.interrupt) {
          await session.interrupt();
        }

        // Send the message
        await session.sendMessage(params.message);

        // Resolve origin channel with fallback chain
        let originChannel = resolveOriginChannel(
          { id: _id },
          params.channel || fallbackChannel || resolveAgentChannel(session.workdir),
        );
        if (originChannel === "unknown") {
          const agentChannel = resolveAgentChannel(session.workdir);
          if (agentChannel) {
            originChannel = agentChannel;
          }
        }

        // Display the response in the origin channel so the conversation is visible
        const notifyChannel = originChannel !== "unknown" ? originChannel : session.originChannel;
        if (notificationRouter && notifyChannel) {
          const respondMsg = [
            `↩️ [${session.name}] Responded:`,
            params.message,
          ].join("\n");
          notificationRouter.emitToChannel(notifyChannel, respondMsg);
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
