import { Type } from "@sinclair/typebox";
import { sessionManager, formatSessionListing } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeSessionsTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_sessions",
    description:
      "List all Claude Code sessions with their status and progress.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("failed"),
          ],
          { description: 'Filter by status (default "all")' },
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

      const filter = params.status || "all";
      const sessions = sessionManager.list(filter);

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sessions found.",
            },
          ],
        };
      }

      const lines = sessions.map(formatSessionListing);

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n\n"),
          },
        ],
      };
    },
  };
}
