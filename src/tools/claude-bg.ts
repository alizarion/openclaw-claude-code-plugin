import { Type } from "@sinclair/typebox";
import { sessionManager, resolveOriginChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeBgTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "claude_bg",
    description:
      "Send a Claude Code session back to background (stop streaming). If no session specified, detaches whichever session is currently in foreground.",
    parameters: Type.Object({
      session: Type.Optional(
        Type.String({
          description:
            "Session name or ID to send to background. If omitted, detaches the current foreground session.",
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

      // If a specific session is given, detach it
      if (params.session) {
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

        const channelId = resolveOriginChannel({ id: _id }, params.channel);
        session.saveFgOutputOffset(channelId);
        session.foregroundChannels.delete(channelId);
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] moved to background.`,
            },
          ],
        };
      }

      // No session specified — find any session that has this channel in foreground
      const resolvedId = resolveOriginChannel({ id: _id }, params.channel);
      const allSessions = sessionManager.list("all");
      const fgSessions = allSessions.filter((s) =>
        s.foregroundChannels.has(resolvedId),
      );

      if (fgSessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No session is currently in foreground.",
            },
          ],
        };
      }

      const names: string[] = [];
      for (const s of fgSessions) {
        s.saveFgOutputOffset(resolvedId);
        s.foregroundChannels.delete(resolvedId);
        names.push(`${s.name} [${s.id}]`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Moved to background: ${names.join(", ")}`,
          },
        ],
      };
    },
  };
}
