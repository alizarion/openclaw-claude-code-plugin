import type { Session } from "./session";
import type { SessionManager, SessionMetrics } from "./session-manager";
import type { NotificationRouter } from "./notifications";
import type { PluginConfig } from "./types";

export let sessionManager: SessionManager | null = null;
export let notificationRouter: NotificationRouter | null = null;

/**
 * Plugin config — populated at service start from api.getConfig().
 * All modules should read from this instead of using hardcoded constants.
 */
export let pluginConfig: PluginConfig = {
  maxSessions: 5,
  defaultBudgetUsd: 5,
  idleTimeoutMinutes: 30,
  maxPersistedSessions: 50,
};

export function setPluginConfig(config: Partial<PluginConfig>): void {
  pluginConfig = {
    maxSessions: config.maxSessions ?? 5,
    defaultBudgetUsd: config.defaultBudgetUsd ?? 5,
    defaultModel: config.defaultModel,
    defaultWorkdir: config.defaultWorkdir,
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 30,
    maxPersistedSessions: config.maxPersistedSessions ?? 50,
    fallbackChannel: config.fallbackChannel,
    agentChannels: config.agentChannels,
  };
}

export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

export function setNotificationRouter(nr: NotificationRouter | null): void {
  notificationRouter = nr;
}

/**
 * Resolve origin channel from an OpenClaw command/tool context.
 *
 * Attempts to build a "channel|target" string from context properties.
 * Command context has: ctx.channel, ctx.senderId, ctx.chatId, ctx.id
 * Tool execute receives just an _id (tool call ID like "toolu_xxx").
 *
 * Falls back to config.fallbackChannel when the real channel info
 * is not available. If no fallbackChannel is configured, returns
 * "unknown" as a safe default.
 */

export function resolveOriginChannel(ctx: any, explicitChannel?: string): string {
  // Highest priority: explicit channel passed by caller (e.g. from tool params)
  if (explicitChannel && String(explicitChannel).includes("|")) {
    return String(explicitChannel);
  }
  // Try structured channel info from command context
  if (ctx?.channel && ctx?.chatId) {
    return `${ctx.channel}|${ctx.chatId}`;
  }
  if (ctx?.channel && ctx?.senderId) {
    return `${ctx.channel}|${ctx.senderId}`;
  }
  // If the context id looks like a numeric telegram chat id
  if (ctx?.id && /^-?\d+$/.test(String(ctx.id))) {
    return `telegram|${ctx.id}`;
  }
  // If channelId is already in "channel|target" format, pass through
  if (ctx?.channelId && String(ctx.channelId).includes("|")) {
    return String(ctx.channelId);
  }
  // Log what we got for debugging
  const fallback = pluginConfig.fallbackChannel ?? "unknown";
  console.log(`[resolveOriginChannel] Could not resolve channel from ctx keys: ${ctx ? Object.keys(ctx).join(", ") : "null"}, using fallback=${fallback}`);
  return fallback;
}

/**
 * Look up the notification channel for a given workdir from the agentChannels config.
 * Normalises trailing slashes before comparison.
 * Returns undefined if no match is found.
 */
export function resolveAgentChannel(workdir: string): string | undefined {
  console.log(`[resolveAgentChannel] workdir=${workdir}, agentChannels=${JSON.stringify(pluginConfig.agentChannels)}`);
  const mapping = pluginConfig.agentChannels;
  if (!mapping) return undefined;

  const normalise = (p: string) => p.replace(/\/+$/, "");
  const normWorkdir = normalise(workdir);

  // Sort entries by path length descending so the most specific (longest) prefix wins
  const entries = Object.entries(mapping).sort(
    (a, b) => b[0].length - a[0].length,
  );

  // Prefix match: workdir is under (or equal to) the configured dir
  for (const [dir, channel] of entries) {
    if (normWorkdir === normalise(dir) || normWorkdir.startsWith(normalise(dir) + "/")) {
      return channel;
    }
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

// Stop words filtered out when generating session names from prompts
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "he", "she",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "about", "that", "this", "these", "those",
  "and", "or", "but", "if", "then", "so", "not", "no",
  "please", "just", "also", "very", "all", "some", "any", "each",
  "make", "write", "create", "build", "implement", "add", "update",
]);

/**
 * Generate a short kebab-case name from a prompt.
 * Extracts 2-3 meaningful keywords.
 */
export function generateSessionName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const keywords = words.slice(0, 3);
  if (keywords.length === 0) return "session";
  return keywords.join("-");
}

const STATUS_ICONS: Record<string, string> = {
  starting: "🟡",
  running: "🟢",
  completed: "✅",
  failed: "❌",
  killed: "⛔",
};

export function formatSessionListing(session: Session): string {
  const icon = STATUS_ICONS[session.status] ?? "❓";
  const duration = formatDuration(session.duration);
  const fg = session.foregroundChannels.size > 0 ? "foreground" : "background";
  const mode = session.multiTurn ? "multi-turn" : "single";
  const promptSummary =
    session.prompt.length > 80
      ? session.prompt.slice(0, 80) + "..."
      : session.prompt;

  const lines = [
    `${icon} ${session.name} [${session.id}] (${duration}) — ${fg}, ${mode}`,
    `   📁 ${session.workdir}`,
    `   📝 "${promptSummary}"`,
  ];

  // Show Claude session ID for resume support
  if (session.claudeSessionId) {
    lines.push(`   🔗 Claude ID: ${session.claudeSessionId}`);
  }

  // Show resume info if this session was resumed
  if (session.resumeSessionId) {
    lines.push(`   ↩️  Resumed from: ${session.resumeSessionId}${session.forkSession ? " (forked)" : ""}`);
  }

  return lines.join("\n");
}

/**
 * Format aggregated metrics into a human-readable stats report (Task 18).
 */
export function formatStats(metrics: SessionMetrics): string {
  // Average duration
  const avgDurationMs =
    metrics.sessionsWithDuration > 0
      ? metrics.totalDurationMs / metrics.sessionsWithDuration
      : 0;

  // Currently running sessions (live count from sessionManager)
  const running = sessionManager
    ? sessionManager.list("running").length
    : 0;

  const { completed, failed, killed } = metrics.sessionsByStatus;
  const totalFinished = completed + failed + killed;

  const lines = [
    `📊 Claude Code Plugin Stats`,
    ``,
    `📋 Sessions`,
    `   Launched:   ${metrics.totalLaunched}`,
    `   Running:    ${running}`,
    `   Completed:  ${completed}`,
    `   Failed:     ${failed}`,
    `   Killed:     ${killed}`,
    ``,
    `⏱️  Average duration: ${avgDurationMs > 0 ? formatDuration(avgDurationMs) : "n/a"}`,
  ];

  if (metrics.mostExpensive) {
    const me = metrics.mostExpensive;
    lines.push(
      ``,
      `🏆 Notable session`,
      `   ${me.name} [${me.id}]`,
      `   📝 "${me.prompt}"`,
    );
  }

  return lines.join("\n");
}
