import type { Session } from "./session";
import { formatDuration } from "./shared";

/**
 * NotificationRouter — Phase 2
 *
 * Decides when and what to notify on active channels.
 * Implements the notification matrix from the plan (section 7.2):
 *
 * | Event                      | Background            | Foreground        |
 * |----------------------------|-----------------------|-------------------|
 * | Session started            | silent                | silent (stream)   |
 * | Assistant output (text)    | silent                | stream to chat    |
 * | Tool call (name + params)  | silent                | compact indicator |
 * | Tool result                | silent                | silent (verbose)  |
 * | Waiting for input          | 🔔 to origin channel  | compact indicator |
 * | Session completed (success)| silent (agent event)  | notify            |
 * | Session completed (error)  | silent (agent event)  | notify            |
 * | Budget exhausted           | silent (agent event)  | notify            |
 * | Session > 10min            | reminder (once)       | silent (user sees)|
 */

// Callback type: the plugin must provide a way to send messages to a channel
export type SendMessageFn = (channelId: string, text: string) => void;

// Debounce state per channel per session
interface DebounceEntry {
  buffer: string;
  timer: ReturnType<typeof setTimeout>;
}

const DEBOUNCE_MS = 500;
const LONG_RUNNING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class NotificationRouter {
  private sendMessage: SendMessageFn;

  // Track debounced foreground streaming: key = `${sessionId}|${channelId}`
  private debounceMap: Map<string, DebounceEntry> = new Map();

  // Track which sessions have already sent the 10min reminder
  private longRunningReminded: Set<string> = new Set();

  // Interval for checking long-running sessions
  private reminderInterval: ReturnType<typeof setInterval> | null = null;

  // Reference to get all sessions for reminder checks
  private getActiveSessions: (() => Session[]) | null = null;

  constructor(sendMessage: SendMessageFn) {
    this.sendMessage = (channelId: string, text: string) => {
      console.log(`[NotificationRouter] sendMessage -> channel=${channelId}, textLen=${text.length}, preview=${text.slice(0, 120)}`);
      sendMessage(channelId, text);
    };
    console.log("[NotificationRouter] Initialized");
  }

  /**
   * Start the reminder check interval.
   * Pass a function that returns currently active sessions.
   */
  startReminderCheck(getActiveSessions: () => Session[]): void {
    this.getActiveSessions = getActiveSessions;
    // Check every 60 seconds for long-running sessions
    this.reminderInterval = setInterval(() => this.checkLongRunning(), 60_000);
  }

  /**
   * Stop the reminder check interval and flush all debounce timers.
   */
  stop(): void {
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    // Flush all pending debounce buffers
    for (const [key, entry] of this.debounceMap) {
      clearTimeout(entry.timer);
      if (entry.buffer) {
        const [_sessionId, channelId] = key.split("|", 2);
        this.sendMessage(channelId, entry.buffer);
      }
    }
    this.debounceMap.clear();
    this.longRunningReminded.clear();
  }

  // ─── Foreground streaming ──────────────────────────────────────────

  /**
   * Called when an assistant text block arrives on a session.
   * If the session has foreground channels, debounce and stream to them.
   */
  onAssistantText(session: Session, text: string): void {
    console.log(`[NotificationRouter] onAssistantText session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}, textLen=${text.length}`);
    if (session.foregroundChannels.size === 0) {
      console.log(`[NotificationRouter] onAssistantText SKIPPED — no foreground channels`);
      return;
    }

    for (const channelId of session.foregroundChannels) {
      console.log(`[NotificationRouter] appendDebounced -> session=${session.id}, channel=${channelId}`);
      this.appendDebounced(session.id, channelId, text);
    }
  }

  /**
   * Called when a tool_use block arrives on an assistant message.
   * Shows a compact one-line indicator on foreground channels.
   */
  onToolUse(session: Session, toolName: string, toolInput: any): void {
    console.log(`[NotificationRouter] onToolUse session=${session.id}, tool=${toolName}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    if (session.foregroundChannels.size === 0) return;

    const inputSummary = summarizeToolInput(toolInput);
    const line = `🔧 ${toolName}${inputSummary ? ` — ${inputSummary}` : ""}`;

    for (const channelId of session.foregroundChannels) {
      // Flush any pending text first, then send tool indicator immediately
      this.flushDebounced(session.id, channelId);
      this.sendMessage(channelId, line);
    }
  }

  // ─── Completion notifications ──────────────────────────────────────

  /**
   * Called when a session completes (success or failure).
   * Notifies ALL channels that have ever been associated with this session:
   * - Foreground channels get a notification
   * - If no foreground channels, notify via a "last known" channel if available
   *
   * For background sessions, we store the originating channel in session metadata.
   */
  onSessionComplete(session: Session): void {
    console.log(`[NotificationRouter] onSessionComplete session=${session.id} (${session.name}), status=${session.status}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    // Flush any pending foreground output first
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }

    const msg = formatCompletionNotification(session);

    // Notify foreground channels only — background sessions are handled by wakeAgent()
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }

    // Clean up debounce state for this session
    this.cleanupSession(session.id);
  }

  /**
   * Called when budget is exhausted (subtype: "error_max_budget_usd").
   * This is effectively handled by onSessionComplete since it's a result event,
   * but we expose it separately for clarity and custom formatting.
   */
  onBudgetExhausted(session: Session): void {
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }

    const duration = formatDuration(session.duration);
    const msg = [
      `⛔ Session limit reached — ${session.name} [${session.id}] (${duration})`,
      `   📁 ${session.workdir}`,
    ].join("\n");

    // Notify foreground channels only — background sessions are handled by wakeAgent()
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }

    this.cleanupSession(session.id);
  }

  // ─── Waiting for input (all session types) ─────────────────────────

  /**
   * Called when any session is waiting for user input (e.g. Claude asked a question,
   * needs a permission decision, or finished a turn in multi-turn mode).
   * Notifies foreground and origin channels so the user knows Claude needs a response.
   */
  onWaitingForInput(session: Session): void {
    console.log(`[NotificationRouter] onWaitingForInput session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}`);

    // Flush any pending foreground output first
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }

    // Notify foreground channels only — background notification is handled by wakeAgent()
    for (const channelId of session.foregroundChannels) {
      const duration = formatDuration(session.duration);
      const msg = [
        `💬 Session ${session.name} [${session.id}] is waiting for input (${duration})`,
        `   Use claude_respond to reply.`,
      ].join("\n");
      this.sendMessage(channelId, msg);
    }
  }

  // ─── Public message passthrough ─────────────────────────────────────

  /**
   * Emit a message to a specific channel. Used by tools (e.g. claude_respond)
   * to display messages in the conversation thread without going through
   * the foreground streaming / debounce logic.
   */
  emitToChannel(channelId: string, text: string): void {
    this.sendMessage(channelId, text);
  }

  // ─── Long-running reminder ─────────────────────────────────────────

  /**
   * Periodic check: notify if a background session (no foreground channels)
   * has been running for more than 10 minutes. Only once per session.
   */
  private checkLongRunning(): void {
    if (!this.getActiveSessions) return;

    const sessions = this.getActiveSessions();
    const now = Date.now();

    for (const session of sessions) {
      if (
        (session.status === "running" || session.status === "starting") &&
        session.foregroundChannels.size === 0 &&
        !this.longRunningReminded.has(session.id) &&
        now - session.startedAt > LONG_RUNNING_THRESHOLD_MS
      ) {
        this.longRunningReminded.add(session.id);

        const duration = formatDuration(now - session.startedAt);
        const msg = [
          `⏱️ Session ${session.name} [${session.id}] running for ${duration}`,
          `   📁 ${session.workdir}`,
          `   Use claude_fg to check on it, or claude_kill to stop it.`,
        ].join("\n");

        // Try to notify the origin channel if available
        if (session.originChannel) {
          this.sendMessage(session.originChannel, msg);
        }
      }
    }
  }

  // ─── Debounce internals ────────────────────────────────────────────

  private debounceKey(sessionId: string, channelId: string): string {
    return `${sessionId}|${channelId}`;
  }

  private appendDebounced(
    sessionId: string,
    channelId: string,
    text: string,
  ): void {
    const key = this.debounceKey(sessionId, channelId);
    const existing = this.debounceMap.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.buffer += text;
      existing.timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
      this.debounceMap.set(key, { buffer: text, timer });
    }
  }

  private flushDebounced(sessionId: string, channelId: string): void {
    const key = this.debounceKey(sessionId, channelId);
    const entry = this.debounceMap.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    if (entry.buffer) {
      console.log(`[NotificationRouter] flushDebounced -> session=${sessionId}, channel=${channelId}, bufferLen=${entry.buffer.length}`);
      this.sendMessage(channelId, entry.buffer);
    }
    this.debounceMap.delete(key);
  }

  private cleanupSession(sessionId: string): void {
    // Remove all debounce entries for this session
    for (const key of this.debounceMap.keys()) {
      if (key.startsWith(`${sessionId}|`)) {
        const entry = this.debounceMap.get(key)!;
        clearTimeout(entry.timer);
        this.debounceMap.delete(key);
      }
    }
    this.longRunningReminded.delete(sessionId);
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────

function formatCompletionNotification(session: Session): string {
  const duration = formatDuration(session.duration);
  const promptSummary =
    session.prompt.length > 60
      ? session.prompt.slice(0, 60) + "..."
      : session.prompt;

  if (session.status === "completed") {
    return [
      `✅ Claude Code [${session.id}] completed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
    ].join("\n");
  }

  if (session.status === "failed") {
    const errorDetail = session.error
      ? `   ⚠️ ${session.error}`
      : session.result?.subtype
        ? `   ⚠️ ${session.result.subtype}`
        : "";
    return [
      `❌ Claude Code [${session.id}] failed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
      ...(errorDetail ? [errorDetail] : []),
    ].join("\n");
  }

  if (session.status === "killed") {
    return [
      `⛔ Claude Code [${session.id}] killed (${duration})`,
      `   📁 ${session.workdir}`,
      `   📝 "${promptSummary}"`,
    ].join("\n");
  }

  // Fallback
  return `Session [${session.id}] finished with status: ${session.status}`;
}

/**
 * Summarize tool input into a short string for compact display.
 * Handles common Claude Code tools.
 */
function summarizeToolInput(input: any): string {
  if (!input || typeof input !== "object") return "";

  // File operations: show the path
  if (input.file_path) return truncate(input.file_path, 60);
  if (input.path) return truncate(input.path, 60);

  // Bash: show the command
  if (input.command) return truncate(input.command, 80);

  // Search: show the pattern
  if (input.pattern) return truncate(input.pattern, 60);

  // Glob
  if (input.glob) return truncate(input.glob, 60);

  // Generic: show first string value
  const firstValue = Object.values(input).find(
    (v) => typeof v === "string" && v.length > 0,
  );
  if (firstValue) return truncate(String(firstValue), 60);

  return "";
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}
