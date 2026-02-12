import { Type } from "@sinclair/typebox";
import { sessionManager, formatDuration, resolveOriginChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeFgTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_fg",
    description:
      "Bring a Claude Code session to foreground (by name or ID). Shows buffered output and streams new output.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session name or ID to bring to foreground",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of recent buffered lines to show (default 30)",
        }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            'Origin channel in "channel:target" format (e.g. "telegram:123456789"). Pass this when calling from an agent tool context.',
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

      // Mark this conversation as a foreground channel
      // _id is tool call ID; use explicit params.channel when available
      const channelId = resolveOriginChannel({ id: _id }, params.channel);

      // Get catchup output (produced while this channel was backgrounded)
      const catchupLines = session.getCatchupOutput(channelId);

      session.foregroundChannels.add(channelId);

      const duration = formatDuration(session.duration);

      const header = [
        `Session ${session.name} [${session.id}] now in foreground.`,
        `Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"─".repeat(60)}`,
      ].join("\n");

      // Build catchup section if there's missed output
      let catchupSection = "";
      if (catchupLines.length > 0) {
        catchupSection = [
          `📋 Catchup (${catchupLines.length} missed output${catchupLines.length === 1 ? "" : "s"}):`,
          catchupLines.join("\n"),
          `${"─".repeat(60)}`,
        ].join("\n");
      }

      // If no catchup, fall back to showing recent lines
      const body =
        catchupLines.length > 0
          ? catchupSection
          : (session.getOutput(params.lines ?? 30).length > 0
              ? session.getOutput(params.lines ?? 30).join("\n")
              : "(no output yet)");

      const footer =
        session.status === "running" || session.status === "starting"
          ? `\n${"─".repeat(60)}\nStreaming new output... Use claude_bg to detach.`
          : `\n${"─".repeat(60)}\nSession is ${session.status}. No more output expected.`;

      // Mark that this channel has now seen all output up to this point
      session.markFgOutputSeen(channelId);

      return {
        content: [
          {
            type: "text",
            text: `${header}\n${body}${footer}`,
          },
        ],
      };
    },
  };
}
