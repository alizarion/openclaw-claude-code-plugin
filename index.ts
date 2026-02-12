import { makeClaudeLaunchTool } from "./src/tools/claude-launch";
import { makeClaudeSessionsTool } from "./src/tools/claude-sessions";
import { makeClaudeKillTool } from "./src/tools/claude-kill";
import { makeClaudeOutputTool } from "./src/tools/claude-output";
import { makeClaudeFgTool } from "./src/tools/claude-fg";
import { makeClaudeBgTool } from "./src/tools/claude-bg";
import { makeClaudeRespondTool } from "./src/tools/claude-respond";
import { makeClaudeStatsTool } from "./src/tools/claude-stats";
import { registerClaudeCommand } from "./src/commands/claude";
import { registerClaudeSessionsCommand } from "./src/commands/claude-sessions";
import { registerClaudeKillCommand } from "./src/commands/claude-kill";
import { registerClaudeFgCommand } from "./src/commands/claude-fg";
import { registerClaudeBgCommand } from "./src/commands/claude-bg";
import { registerClaudeResumeCommand } from "./src/commands/claude-resume";
import { registerClaudeRespondCommand } from "./src/commands/claude-respond";
import { registerClaudeStatsCommand } from "./src/commands/claude-stats";
import { registerGatewayMethods } from "./src/gateway";
import { SessionManager } from "./src/session-manager";
import { NotificationRouter } from "./src/notifications";
import { setSessionManager, setNotificationRouter, setPluginConfig, pluginConfig } from "./src/shared";
import { execFile } from "child_process";

// Plugin register function - called by OpenClaw when loading the plugin
export function register(api: any) {
  // Local references for service lifecycle
  let sm: SessionManager | null = null;
  let nr: NotificationRouter | null = null;
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Tools — registered as factory functions so each invocation receives
  // the calling agent's context (agentId, workspaceDir, messageChannel, etc.)
  api.registerTool((ctx: any) => makeClaudeLaunchTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeSessionsTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeKillTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeOutputTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeFgTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeBgTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeRespondTool(ctx), { optional: false });
  api.registerTool((ctx: any) => makeClaudeStatsTool(ctx), { optional: false });

  // Commands
  registerClaudeCommand(api);
  registerClaudeSessionsCommand(api);
  registerClaudeKillCommand(api);
  registerClaudeFgCommand(api);
  registerClaudeBgCommand(api);
  registerClaudeResumeCommand(api);
  registerClaudeRespondCommand(api);
  registerClaudeStatsCommand(api);

  // Gateway RPC methods (Task 17)
  registerGatewayMethods(api);

  // Service
  api.registerService({
    id: "openclaw-claude-code-plugin",
    start: () => {
      const config = api.getConfig?.() ?? {};

      // Store config globally for all modules (Task 20)
      setPluginConfig(config);

      // Create SessionManager — uses config for maxSessions and maxPersistedSessions
      sm = new SessionManager(
        pluginConfig.maxSessions,
        pluginConfig.maxPersistedSessions,
      );
      setSessionManager(sm);

      // Create NotificationRouter with OpenClaw's outbound message pipeline.
      // Uses `openclaw message send` CLI since the plugin API does not expose
      // a runtime.sendMessage method for proactive outbound messages.
      //
      // channelId format: "channel:target" (e.g. "telegram:123456789"),
      //   "channel:account:target" (e.g. "telegram:my-agent:123456789"),
      //   or just a bare chat ID.
      // Fallback channel comes from config.fallbackChannel (e.g. "telegram:123456789").

      const sendMessage = (channelId: string, text: string) => {
        // Resolve channel and target from channelId
        // Expected formats:
        //   "telegram:123456789" → channel=telegram, target=123456789
        //   "discord:987654321" → channel=discord, target=987654321
        //   "123456789"         → channel=telegram (fallback), target=123456789
        //   "toolu_xxxx"        → not a real channel, use fallback

        // Parse fallbackChannel from config
        // Supports both "channel:target" and "channel:account:target" formats
        let fallbackChannel = "telegram";
        let fallbackTarget = "";
        let fallbackAccount: string | undefined;
        if (pluginConfig.fallbackChannel?.includes(":")) {
          const fbParts = pluginConfig.fallbackChannel.split(":");
          if (fbParts.length >= 3 && fbParts[0] && fbParts[1]) {
            // channel:account:target format (e.g. "telegram:my-agent:123456789")
            fallbackChannel = fbParts[0];
            fallbackAccount = fbParts[1];
            fallbackTarget = fbParts.slice(2).join(":");
          } else if (fbParts[0] && fbParts[1]) {
            // channel:target format (e.g. "telegram:123456789")
            fallbackChannel = fbParts[0];
            fallbackTarget = fbParts[1];
          }
        }

        let channel = fallbackChannel;
        let target = fallbackTarget;
        let account: string | undefined = fallbackAccount;

        if (channelId === "unknown" || !channelId) {
          // Tool-launched sessions have originChannel="unknown" — always use fallback
          if (fallbackTarget) {
            console.log(`[claude-code] sendMessage: channelId="${channelId}", using fallback ${fallbackChannel}:${fallbackTarget}${fallbackAccount ? ` (account=${fallbackAccount})` : ""}`);
          } else {
            console.warn(`[claude-code] sendMessage: channelId="${channelId}" and no fallbackChannel configured — message will not be sent`);
            return;
          }
        } else if (channelId.includes(":")) {
          const parts = channelId.split(":");
          if (parts.length >= 3) {
            // channel:account:target format (e.g. "telegram:my-agent:123456789")
            channel = parts[0];
            account = parts[1];
            target = parts.slice(2).join(":");
          } else if (parts[0] && parts[1]) {
            // channel:target format (e.g. "telegram:123456789")
            channel = parts[0];
            target = parts[1];
          }
        } else if (/^-?\d+$/.test(channelId)) {
          // Bare numeric ID — assume Telegram chat ID
          channel = "telegram";
          target = channelId;
        } else if (fallbackTarget) {
          // Non-numeric, non-structured ID (e.g. "toolu_xxx", "command")
          // Use fallback from config
          console.log(`[claude-code] sendMessage: unrecognized channelId="${channelId}", using fallback ${fallbackChannel}:${fallbackTarget}`);
        } else {
          console.warn(`[claude-code] sendMessage: unrecognized channelId="${channelId}" and no fallbackChannel configured — message will not be sent`);
          return;
        }

        console.log(`[claude-code] sendMessage -> channel=${channel}, target=${target}${account ? `, account=${account}` : ""}, textLen=${text.length}`);

        // Build CLI args, including --account when a 3-segment channel format is used
        const cliArgs = ["message", "send", "--channel", channel];
        if (account) {
          cliArgs.push("--account", account);
        }
        cliArgs.push("--target", target, "-m", text);

        execFile("openclaw", cliArgs, { timeout: 15_000 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[claude-code] sendMessage CLI ERROR: ${err.message}`);
            if (stderr) console.error(`[claude-code] sendMessage CLI STDERR: ${stderr}`);
          } else {
            console.log(`[claude-code] sendMessage CLI OK -> channel=${channel}, target=${target}${account ? `, account=${account}` : ""}`);
            if (stdout.trim()) console.log(`[claude-code] sendMessage CLI STDOUT: ${stdout.trim()}`);
          }
        });
      };

      nr = new NotificationRouter(sendMessage);
      setNotificationRouter(nr);

      // Wire NotificationRouter into SessionManager
      sm.notificationRouter = nr;

      // Start the long-running session reminder check
      nr.startReminderCheck(() => sm?.list("running") ?? []);

      // GC interval
      cleanupInterval = setInterval(() => sm!.cleanup(), 5 * 60 * 1000);
    },
    stop: () => {
      if (nr) nr.stop();
      if (sm) sm.killAll();
      if (cleanupInterval) clearInterval(cleanupInterval);
      cleanupInterval = null;
      sm = null;
      nr = null;
      setSessionManager(null);
      setNotificationRouter(null);
    },
  });
}
