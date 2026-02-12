import { Type } from "@sinclair/typebox";
import { sessionManager, resolveOriginChannel, resolveAgentChannel } from "../shared";
import type { OpenClawPluginToolContext } from "../types";

export function makeClaudeBgTool(ctx?: OpenClawPluginToolContext) {
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

        let channelId = resolveOriginChannel({ id: _id }, params.channel || fallbackChannel);
        if (channelId === "unknown") {
          const agentChannel = resolveAgentChannel(session.workdir);
          if (agentChannel) {
            channelId = agentChannel;
          }
        }
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
      let resolvedId = resolveOriginChannel({ id: _id }, params.channel || fallbackChannel);
      if (resolvedId === "unknown") {
        // Try each session's workdir to find a matching agent channel
        const allSessionsForLookup = sessionManager.list("all");
        for (const s of allSessionsForLookup) {
          const agentChannel = resolveAgentChannel(s.workdir);
          if (agentChannel && s.foregroundChannels.has(agentChannel)) {
            resolvedId = agentChannel;
            break;
          }
        }
      }
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
