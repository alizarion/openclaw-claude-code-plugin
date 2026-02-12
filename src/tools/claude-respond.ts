import { Type } from "@sinclair/typebox";
import { sessionManager, notificationRouter } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeRespondTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_respond",
    description:
      "Send a follow-up message to a running Claude Code session. The session must be running. Works with multi-turn sessions (launched with multi_turn: true) or any running session via SDK streamInput.",
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

        // Display the response in the origin channel so the conversation is visible
        if (notificationRouter && session.originChannel) {
          const respondMsg = [
            `↩️ [${session.name}] Responded:`,
            params.message,
          ].join("\n");
          notificationRouter.emitToChannel(session.originChannel, respondMsg);
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
