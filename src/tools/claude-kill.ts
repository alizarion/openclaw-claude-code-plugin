import { Type } from "@sinclair/typebox";
import { sessionManager } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeKillTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_kill",
    description: "Terminate a running Claude Code session by name or ID.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to terminate" }),
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

      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "killed"
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`,
            },
          ],
        };
      }

      sessionManager.kill(session.id);

      return {
        content: [
          {
            type: "text",
            text: `Session ${session.name} [${session.id}] has been terminated.`,
          },
        ],
      };
    },
  };
}
