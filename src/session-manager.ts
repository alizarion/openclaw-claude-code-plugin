import { execFile } from "child_process";
import { Session } from "./session";
import { generateSessionName } from "./shared";
import type { NotificationRouter } from "./notifications";
import type { SessionConfig, SessionStatus } from "./types";

const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Aggregated metrics for all sessions (Task 18: Metrics and observability).
 */
export interface SessionMetrics {
  /** Total cost across all sessions (all time) */
  totalCostUsd: number;
  /** Cost per day: map of ISO date string (YYYY-MM-DD) to cost */
  costPerDay: Map<string, number>;
  /** Count of sessions by terminal state */
  sessionsByStatus: { completed: number; failed: number; killed: number };
  /** Total number of sessions ever launched */
  totalLaunched: number;
  /** Sum of all session durations in ms (for computing average) */
  totalDurationMs: number;
  /** Number of sessions that have a known duration (completed/failed/killed) */
  sessionsWithDuration: number;
  /** The most expensive session ever */
  mostExpensive: {
    id: string;
    name: string;
    costUsd: number;
    prompt: string;
  } | null;
}

/**
 * Persisted session info for resume support (Task 16).
 * Keeps a map of our internal session IDs to their Claude SDK session IDs,
 * so users can resume sessions even after the Session object is garbage-collected.
 */
interface PersistedSessionInfo {
  claudeSessionId: string;
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  completedAt?: number;
  status: SessionStatus;
  costUsd: number;
}

/** Debounce interval for waiting-for-input events (ms) */
const WAITING_EVENT_DEBOUNCE_MS = 5_000;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  maxSessions: number;
  maxPersistedSessions: number;
  notificationRouter: NotificationRouter | null = null;

  /** Debounce tracker: session ID → last waiting-for-input event timestamp */
  private lastWaitingEventTimestamps: Map<string, number> = new Map();

  /**
   * Persisted Claude session IDs — survives session cleanup/GC.
   * Key: our internal session ID (nanoid) or session name.
   * Allows resume even after the Session object has been garbage-collected.
   */
  private persistedSessions: Map<string, PersistedSessionInfo> = new Map();

  /** Aggregated metrics (Task 18) */
  private _metrics: SessionMetrics = {
    totalCostUsd: 0,
    costPerDay: new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: 0,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null,
  };

  constructor(maxSessions: number = 5, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
  }

  /**
   * Ensure name is unique among existing sessions.
   * If collision, append -2, -3, etc.
   */
  private uniqueName(baseName: string): string {
    const existing = new Set(
      [...this.sessions.values()].map((s) => s.name),
    );
    if (!existing.has(baseName)) return baseName;
    let i = 2;
    while (existing.has(`${baseName}-${i}`)) i++;
    return `${baseName}-${i}`;
  }

  spawn(config: SessionConfig): Session {
    const activeCount = [...this.sessions.values()].filter(
      (s) => s.status === "starting" || s.status === "running",
    ).length;
    if (activeCount >= this.maxSessions) {
      throw new Error(
        `Max sessions reached (${this.maxSessions}). Kill a session first.`,
      );
    }

    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);

    const session = new Session(config, name);
    this.sessions.set(session.id, session);
    this._metrics.totalLaunched++;

    // Wire up notification callbacks if NotificationRouter is available
    if (this.notificationRouter) {
      const nr = this.notificationRouter;
      console.log(`[SessionManager] Wiring notification callbacks for session=${session.id} (${session.name}), originChannel=${session.originChannel}`);

      session.onOutput = (text: string) => {
        console.log(`[SessionManager] session.onOutput fired for session=${session.id}, textLen=${text.length}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
        nr.onAssistantText(session, text);
        // Advance the output offset for all foreground channels so they don't
        // see this output again as "catchup" when re-foregrounding later.
        for (const ch of session.foregroundChannels) {
          session.markFgOutputSeen(ch);
        }
      };

      session.onToolUse = (toolName: string, toolInput: any) => {
        console.log(`[SessionManager] session.onToolUse fired for session=${session.id}, tool=${toolName}`);
        nr.onToolUse(session, toolName, toolInput);
      };

      session.onBudgetExhausted = () => {
        console.log(`[SessionManager] session.onBudgetExhausted fired for session=${session.id}`);
        nr.onBudgetExhausted(session, session.originChannel);
      };

      session.onWaitingForInput = () => {
        console.log(`[SessionManager] session.onWaitingForInput fired for session=${session.id}`);
        nr.onWaitingForInput(session, session.originChannel);

        // Wake the orchestrator agent so it can forward the question to the user
        this.triggerWaitingForInputEvent(session);
      };

      session.onComplete = () => {
        console.log(`[SessionManager] session.onComplete fired for session=${session.id}, budgetExhausted=${session.budgetExhausted}`);

        // Persist the Claude session ID for future resume
        this.persistSession(session);

        // Don't double-notify if budget exhaustion already handled
        if (!session.budgetExhausted) {
          nr.onSessionComplete(session, session.originChannel);
        }

        // Auto-trigger OpenClaw agent to process the completed session
        this.triggerAgentEvent(session);
      };
    } else {
      console.warn(`[SessionManager] No NotificationRouter available when spawning session=${session.id} (${session.name})`);
    }

    session.start();
    return session;
  }

  /**
   * Persist a session's Claude session ID for future resume.
   * Called when a session completes so its ID is available after GC.
   */
  private persistSession(session: Session): void {
    // Record metrics (only once per session — guard via persistedSessions check)
    const alreadyPersisted = this.persistedSessions.has(session.id);
    if (!alreadyPersisted) {
      this.recordSessionMetrics(session);
    }

    if (!session.claudeSessionId) return;

    const info: PersistedSessionInfo = {
      claudeSessionId: session.claudeSessionId,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      completedAt: session.completedAt,
      status: session.status,
      costUsd: session.costUsd,
    };

    // Store by internal ID
    this.persistedSessions.set(session.id, info);
    // Also store by name for easy lookup
    this.persistedSessions.set(session.name, info);
    // Also store by Claude session ID itself
    this.persistedSessions.set(session.claudeSessionId, info);

    console.log(`[SessionManager] Persisted session ${session.name} [${session.id}] -> claudeSessionId=${session.claudeSessionId}`);
  }

  /**
   * Record metrics for a completed session (Task 18).
   * Called once per session when it finishes (completed/failed/killed).
   */
  private recordSessionMetrics(session: Session): void {
    const cost = session.costUsd ?? 0;
    const status = session.status;

    // Total cost
    this._metrics.totalCostUsd += cost;

    // Cost per day — use the completion date (or start date as fallback)
    const dateKey = new Date(session.completedAt ?? session.startedAt)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD
    this._metrics.costPerDay.set(
      dateKey,
      (this._metrics.costPerDay.get(dateKey) ?? 0) + cost,
    );

    // Sessions by status
    if (status === "completed" || status === "failed" || status === "killed") {
      this._metrics.sessionsByStatus[status]++;
    }

    // Duration
    if (session.completedAt) {
      const durationMs = session.completedAt - session.startedAt;
      this._metrics.totalDurationMs += durationMs;
      this._metrics.sessionsWithDuration++;
    }

    // Most expensive
    if (
      !this._metrics.mostExpensive ||
      cost > this._metrics.mostExpensive.costUsd
    ) {
      this._metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        costUsd: cost,
        prompt:
          session.prompt.length > 80
            ? session.prompt.slice(0, 80) + "..."
            : session.prompt,
      };
    }
  }

  /**
   * Public accessor for aggregated metrics (Task 18).
   * Returns a snapshot of the current metrics.
   */
  getMetrics(): SessionMetrics {
    return this._metrics;
  }

  /**
   * Route an event message to the correct channel for a session.
   * Supports "channel:account:target" (3-segment), "channel:target" (2-segment),
   * and falls back to `openclaw system event` for unknown/1-segment origins.
   */
  private routeEventMessage(session: Session, eventText: string, label: string): void {
    console.log(`[SessionManager] Triggering ${label} for session=${session.id}, originChannel=${session.originChannel}`);

    if (session.originChannel && session.originChannel !== "unknown") {
      const parts = session.originChannel.split(":");

      // Guard: 1-segment strings (e.g. "gateway") have no target — fall through to system event
      if (parts.length < 2) {
        console.log(`[SessionManager] originChannel="${session.originChannel}" is 1-segment, falling through to system event`);
      } else {
        let args: string[];
        if (parts.length >= 3) {
          // channel:account:target format
          args = ["message", "send", "--channel", parts[0], "--account", parts[1], "--target", parts.slice(2).join(":"), "-m", eventText];
        } else if (parts[0] && parts[1]) {
          // channel:target format (2 segments) — guard both parts are non-empty
          args = ["message", "send", "--channel", parts[0], "--target", parts[1], "-m", eventText];
        } else {
          // Malformed 2-segment (empty channel or target) — fall through
          console.log(`[SessionManager] originChannel="${session.originChannel}" has empty segment(s), falling through to system event`);
          args = [];
        }

        if (args.length > 0) {
          execFile(
            "openclaw",
            args,
            (err, _stdout, stderr) => {
              if (err) {
                console.error(
                  `[SessionManager] Failed to send ${label} via channel for session=${session.id}: ${err.message}`,
                );
                if (stderr) console.error(`[SessionManager] stderr: ${stderr}`);
              } else {
                console.log(
                  `[SessionManager] ${label} sent via channel=${parts[0]} target=${parts.length >= 3 ? parts.slice(2).join(":") : parts[1]} for session=${session.id}`,
                );
              }
            },
          );
          return;
        }
      }
    }

    // Fallback: wake main agent via system event
    execFile(
      "openclaw",
      ["system", "event", "--text", eventText, "--mode", "now"],
      (err, _stdout, stderr) => {
        if (err) {
          console.error(
            `[SessionManager] Failed to trigger ${label} for session=${session.id}: ${err.message}`,
          );
          if (stderr) console.error(`[SessionManager] stderr: ${stderr}`);
        } else {
          console.log(
            `[SessionManager] ${label} triggered via system event for session=${session.id}`,
          );
        }
      },
    );
  }

  /**
   * Trigger an OpenClaw agent event when a Claude Code session completes.
   * Fires `openclaw system event` with session details so the agent can
   * immediately process the result.
   */
  private triggerAgentEvent(session: Session): void {
    const status = session.status;

    // Build an output preview: last 5 lines, capped at 500 chars
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) {
      preview = preview.slice(-500);
    }

    const eventText = [
      `Claude Code session completed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${status}`,
      ``,
      `Output preview:`,
      preview,
      ``,
      `Use claude_output(session='${session.id}', full=true) to get the full result and transmit the analysis to the user.`,
    ].join("\n");

    this.routeEventMessage(session, eventText, "agent event");
  }

  /**
   * Trigger an OpenClaw agent event when a session is waiting for user input.
   * Works for ALL session types (single-turn and multi-turn).
   * Fires `openclaw system event --mode now` so the orchestrator agent
   * wakes up immediately and can forward the question to the user.
   */
  private triggerWaitingForInputEvent(session: Session): void {
    // Debounce: skip if a waiting-for-input event was sent recently for this session
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(session.id);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) {
      console.log(`[SessionManager] Debounced waiting-for-input event for session=${session.id} (last sent ${now - lastTs}ms ago)`);
      return;
    }
    this.lastWaitingEventTimestamps.set(session.id, now);

    // Build an output preview: last 5 lines, capped at 500 chars
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) {
      preview = preview.slice(-500);
    }

    const sessionType = session.multiTurn ? "Multi-turn session" : "Session";

    const eventText = [
      `${sessionType} is waiting for input.`,
      `Name: ${session.name} | ID: ${session.id}`,
      ``,
      `Last output:`,
      preview,
      ``,
      `Use claude_respond(session='${session.id}', message='...') to send a reply, or claude_output(session='${session.id}') to see full context.`,
    ].join("\n");

    this.routeEventMessage(session, eventText, "waiting-for-input event");
  }

  /**
   * Resolve a Claude session ID from our internal ID, name, or Claude session ID.
   * Looks in both active sessions and persisted (completed/GC'd) sessions.
   */
  resolveClaudeSessionId(ref: string): string | undefined {
    // 1. Check active sessions
    const active = this.resolve(ref);
    if (active?.claudeSessionId) return active.claudeSessionId;

    // 2. Check persisted sessions
    const persisted = this.persistedSessions.get(ref);
    if (persisted?.claudeSessionId) return persisted.claudeSessionId;

    // 3. If the ref itself is a valid UUID, return it directly
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;

    return undefined;
  }

  /**
   * Get persisted session info by any identifier.
   */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.persistedSessions.get(ref);
  }

  /**
   * List all persisted sessions (for /claude_resume listing).
   */
  listPersistedSessions(): PersistedSessionInfo[] {
    // Deduplicate (same session stored under id, name, and claudeSessionId)
    const seen = new Set<string>();
    const result: PersistedSessionInfo[] = [];
    for (const info of this.persistedSessions.values()) {
      if (!seen.has(info.claudeSessionId)) {
        seen.add(info.claudeSessionId);
        result.push(info);
      }
    }
    return result.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  /**
   * Resolve a session by ID or name.
   */
  resolve(idOrName: string): Session | undefined {
    // Try ID first (exact match)
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;

    // Try name match
    for (const session of this.sessions.values()) {
      if (session.name === idOrName) return session;
    }
    return undefined;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(filter?: SessionStatus | "all"): Session[] {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.kill();
    // Record metrics immediately for killed sessions (they don't get onComplete)
    if (!this.persistedSessions.has(session.id)) {
      this.recordSessionMetrics(session);
    }
    // Persist and notify — killed sessions don't trigger onComplete
    this.persistSession(session);
    if (this.notificationRouter) {
      this.notificationRouter.onSessionComplete(session, session.originChannel);
    }
    this.triggerAgentEvent(session);
    return true;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.status === "starting" || session.status === "running") {
        session.kill();
      }
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (
        session.completedAt &&
        (session.status === "completed" ||
          session.status === "failed" ||
          session.status === "killed") &&
        now - session.completedAt > CLEANUP_MAX_AGE_MS
      ) {
        // Persist before deleting (in case onComplete wasn't called)
        this.persistSession(session);
        this.sessions.delete(id);
      }
    }

    // Evict oldest persisted sessions when over the cap.
    // Each session is stored under up to 3 keys (id, name, claudeSessionId),
    // so we deduplicate first, then remove the oldest entries.
    const unique = this.listPersistedSessions(); // already sorted newest-first
    if (unique.length > this.maxPersistedSessions) {
      const toEvict = unique.slice(this.maxPersistedSessions);
      for (const info of toEvict) {
        // Remove all keys that point to this session
        for (const [key, val] of this.persistedSessions) {
          if (val.claudeSessionId === info.claudeSessionId) {
            this.persistedSessions.delete(key);
          }
        }
      }
      console.log(`[SessionManager] Evicted ${toEvict.length} oldest persisted sessions (cap=${this.maxPersistedSessions})`);
    }
  }
}
