import { Type } from "@sinclair/typebox";
import { sessionManager, formatDuration } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeOutputTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_output",
    description: "Show recent output from a Claude Code session (by name or ID).",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to get output from" }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of recent lines to show (default 50)",
        }),
      ),
      full: Type.Optional(
        Type.Boolean({
          description: "Show all available output",
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

      const outputLines = params.full
        ? session.getOutput()
        : session.getOutput(params.lines ?? 50);

      const duration = formatDuration(session.duration);
      const header = [
        `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"─".repeat(60)}`,
      ].join("\n");

      if (outputLines.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${header}\n(no output yet)`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${header}\n${outputLines.join("\n")}`,
          },
        ],
      };
    },
  };
}
