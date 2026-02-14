# Architecture

## Overview

```
┌─────────────────────────────────────────────────────┐
│                    index.ts                         │
│              (Plugin entry point)                   │
│  Registers tools, commands, RPC methods, service    │
└──────────────┬──────────────────────────────────────┘
               │
      ┌────────┼─────────────────┐
      │        │                 │
      ▼        ▼                 ▼
  Tools    Commands          Gateway RPC
  (8)      (8)               (5 methods)
      │        │                 │
      └────────┼─────────────────┘
               │
               ▼
        ┌─────────────┐     ┌────────────────────┐
        │   shared.ts  │────▶│  SessionManager    │
        │  (globals,   │     │  (spawn, resolve,  │
        │   helpers)   │     │   kill, cleanup,   │
        │              │     │   metrics, persist)│
        └─────────────┘     └────────┬───────────┘
                                     │
                            ┌────────┴───────────┐
                            │     Session        │
                            │  (Claude SDK       │
                            │   query() wrapper, │
                            │   message stream,  │
                            │   abort, output)   │
                            └────────────────────┘
                                     │
                            ┌────────┴───────────┐
                            │ NotificationRouter │
                            │  (foreground       │
                            │   streaming,       │
                            │   catchup display, │
                            │   completion,      │
                            │   session-limit,   │
                            │   long-run remind) │
                            └────────────────────┘
```

---

## Key Components

| Component | File | Responsibility |
|---|---|---|
| **Session** | `src/session.ts` | Wraps the Claude Agent SDK `query()` call. Manages the async message stream, output buffering (last 200 blocks), abort control, multi-turn `MessageStream`, idle timeouts, waiting-for-input detection (end-of-turn + 15s safety-net timer with `waitingForInputFired` guard), and event callbacks (`onOutput`, `onToolUse`, `onComplete`, `onBudgetExhausted`, `onWaitingForInput`). |
| **SessionManager** | `src/session-manager.ts` | Manages the pool of active sessions. Enforces `maxSessions`, generates unique names, wires notification callbacks, persists Claude session IDs for resume, records metrics, triggers agent events on completion and waiting-for-input, and runs periodic garbage collection. |
| **NotificationRouter** | `src/notifications.ts` | Routes events to the right chat channels. Debounces foreground text streaming (500ms), shows compact tool-use indicators, sends completion/failure/session-limit notifications, foreground catchup display, and periodically checks for sessions running longer than 10 minutes. |
| **Gateway** | `src/gateway.ts` | Exposes 5 JSON-RPC methods for external/programmatic access. |
| **Shared** | `src/shared.ts` | Global singletons (`sessionManager`, `notificationRouter`, `pluginConfig`), helper functions (name generation, duration formatting, session listing, stats formatting), and channel resolution logic. |
| **Types** | `src/types.ts` | TypeScript interfaces: `SessionConfig`, `ClaudeSession`, `PluginConfig`, `SessionStatus`, `PermissionMode`. |

---

## Session Lifecycle

A session transitions through a strict linear state machine:

```
  ┌──────────┐      init msg       ┌──────────┐
  │ starting │ ──────────────────▶ │ running  │
  └──────────┘                     └────┬─────┘
       │                                │
       │ (query() throws               │  result message
       │  before init)                  │  arrives
       ▼                                ▼
  ┌──────────┐              ┌────────────────────────┐
  │  failed  │              │  result.subtype check  │
  └──────────┘              └────────────┬───────────┘
                                         │
                    ┌────────────────────┬┴──────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
             ┌───────────┐       ┌───────────┐       ┌───────────┐
             │ completed │       │  failed   │       │  killed   │
             │ (success) │       │ (error /  │       │ (abort /  │
             │           │       │  budget)  │       │  idle)    │
             └───────────┘       └───────────┘       └───────────┘
```

### Status Values (`SessionStatus`)

| Status | Meaning |
|---|---|
| `starting` | `query()` called but no SDK `init` message received yet. |
| `running` | SDK sent `system/init` — the session ID is known and turns are executing. |
| `completed` | SDK sent a `result` with `subtype: "success"` (and not a multi-turn end-of-turn). |
| `failed` | SDK sent a `result` with an error subtype (e.g. `"error_max_budget_usd"`), or `query()` / `consumeMessages()` threw an exception. |
| `killed` | Externally aborted via `session.kill()` (user action, idle timeout, or `killAll()`). |

### Lifecycle Details

1. **Construction** — `new Session(config, name)` assigns a `nanoid(8)` ID, stores config, sets `status = "starting"`, records `startedAt = Date.now()`, and creates an `AbortController`.

2. **`start()`** — Builds SDK options (cwd, model, budget, permission mode, optional resume/fork). For multi-turn sessions, creates a `MessageStream` and pushes the initial prompt into it; for single-turn, passes the prompt string directly. Calls `query({ prompt, options })` and begins non-blocking consumption of the async message iterator via `consumeMessages()`.

3. **`consumeMessages()`** — Iterates the SDK's async message stream. On every message it resets the safety-net timer. Handles three message types:
   - **`system/init`** → transitions to `"running"`, stores `claudeSessionId`, starts the idle timer.
   - **`assistant`** → processes content blocks: text blocks are pushed to the output buffer (capped at 200) and fire `onOutput`; `tool_use` blocks fire `onToolUse`.
   - **`result`** → see "Result Handling" below.

4. **Result handling** — When a `result` message arrives:
   - **Multi-turn end-of-turn** (`multiTurn && subtype === "success"`): the session stays `"running"`. The idle timer resets, the safety-net timer clears, and `onWaitingForInput` fires (guarded by `waitingForInputFired`). The user can send follow-up messages.
   - **Terminal result** (single-turn success, any error, budget exhaustion): status becomes `"completed"` or `"failed"`, `completedAt` is set, the `MessageStream` is ended, timers are cleared. If `subtype === "error_max_budget_usd"`, `budgetExhausted` is flagged and `onBudgetExhausted` fires. Finally `onComplete` fires.

5. **`kill()`** — Only acts on `"starting"` or `"running"` sessions. Clears all timers, sets `status = "killed"`, records `completedAt`, ends the `MessageStream`, and calls `abortController.abort()` to cancel the SDK stream.

---

## SessionManager

The `SessionManager` is the central coordinator. It owns the pool of live `Session` objects, enforces concurrency limits, wires callbacks, and handles the full post-session lifecycle (persistence, metrics, event routing).

### `spawn(config): Session`

```
1. Guard: count active sessions (starting | running) against maxSessions. Throw if at cap.
2. Generate a unique name (from config.name or generateSessionName(prompt)), de-duped with -2, -3 suffixes.
3. Construct Session(config, name) and register it in the sessions map.
4. Increment totalLaunched metric.
5. Wire notification callbacks (if NotificationRouter is available):
     onOutput       → nr.onAssistantText + markFgOutputSeen for all foreground channels
     onToolUse      → nr.onToolUse
     onBudgetExhausted → nr.onBudgetExhausted
     onWaitingForInput → nr.onWaitingForInput + triggerWaitingForInputEvent
     onComplete     → persistSession + nr.onSessionComplete (unless budget already handled) + triggerAgentEvent
6. Call session.start() (non-blocking).
7. Return the session.
```

### `resolve(idOrName): Session | undefined`

Looks up a live session by exact ID first, then by name. Returns `undefined` if not found.

### `resolveClaudeSessionId(ref): string | undefined`

Three-tier lookup for a Claude SDK session UUID:
1. Active sessions (via `resolve(ref)`).
2. Persisted sessions map (keyed by internal ID, name, or Claude session ID).
3. If `ref` itself looks like a UUID, returns it directly.

### `kill(id): boolean`

1. Calls `session.kill()` to abort the SDK stream.
2. Records metrics (if not already persisted).
3. Persists the session for future resume.
4. Sends a completion notification via `NotificationRouter`.
5. Fires `triggerAgentEvent` so the orchestrator processes the result.

Killed sessions do **not** receive `onComplete` from the SDK, so `kill()` handles notification and persistence explicitly.

### `killAll()`

Iterates all sessions with status `"starting"` or `"running"` and calls `session.kill()` on each. Does not trigger agent events or notifications (fire-and-forget shutdown).

### `cleanup()`

Garbage-collects stale sessions on two levels:

1. **Live sessions**: Deletes any session from the `sessions` map that has been in a terminal state (`completed` / `failed` / `killed`) for longer than `CLEANUP_MAX_AGE_MS` (1 hour). Persists before deleting.
2. **Persisted sessions**: If the deduplicated count exceeds `maxPersistedSessions` (default 50), evicts the oldest entries. Each persisted session is stored under up to 3 keys (internal ID, name, Claude session ID), so eviction removes all keys for a given session.

### Metrics (`getMetrics()`)

Aggregated metrics recorded once per session when it finishes:

| Metric | Description |
|---|---|
| `totalCostUsd` | Cumulative cost across all sessions. |
| `costPerDay` | `Map<string, number>` keyed by ISO date (`YYYY-MM-DD`). |
| `sessionsByStatus` | Count of `completed`, `failed`, `killed` sessions. |
| `totalLaunched` | Total sessions ever spawned. |
| `totalDurationMs` / `sessionsWithDuration` | For computing average duration. |
| `mostExpensive` | ID, name, cost, and prompt snippet of the costliest session. |

### Persisted Sessions

When a session completes (or is killed), `persistSession()` saves a `PersistedSessionInfo` record containing the Claude SDK session UUID, name, prompt, workdir, model, status, cost, and completion time. The record is stored under **three keys** — internal ID, session name, and Claude session ID — so `resolveClaudeSessionId()` can find it via any identifier.

This allows `claude_resume` to resume sessions even after the `Session` object has been garbage-collected.

---

## Session Class Internals

### Multi-Turn MessageStream

The `MessageStream` class is a hand-rolled async iterable (implements `[Symbol.asyncIterator]`). It has:

- An internal `queue` of SDK-formatted user messages.
- A `resolve` callback for the currently-pending `await` in the iterator.
- A `done` flag to signal stream termination.

**Flow:**
1. On session start, a `MessageStream` is created and the initial prompt is pushed in.
2. The stream is passed as the `prompt` to `query()`. The SDK pulls from it via `for await`.
3. When the SDK finishes a turn (sends a `result` with `subtype: "success"`) the session stays `"running"`.
4. `sendMessage(text)` pushes a new user message into the stream; the SDK picks it up and starts a new turn.
5. `end()` sets `done = true`, unblocking the iterator, which causes `consumeMessages()` to finish gracefully.

For non-multi-turn sessions, `sendMessage()` falls back to `queryHandle.streamInput()` if available.

### Output Buffer

- `outputBuffer: string[]` stores the last `OUTPUT_BUFFER_MAX` (200) text blocks from assistant messages.
- When the buffer overflows, the oldest entries are spliced off.
- `getOutput(lines?)` returns a copy of the buffer (or the last N entries).
- `getCatchupOutput(channelId)` returns only the entries since the channel last saw output (used for foreground catchup).

### Foreground Channels

- `foregroundChannels: Set<string>` — the set of channel IDs currently watching this session in real-time.
- `fgOutputOffsets: Map<string, number>` — per-channel bookmark into `outputBuffer`, tracking the last-seen position.
- `markFgOutputSeen(channelId)` — advances the bookmark to the current buffer end (called after each `onOutput` for all foreground channels).
- `saveFgOutputOffset(channelId)` — saves the current position when a channel backgrounds the session.
- `getCatchupOutput(channelId)` — returns all output produced since the channel's bookmark, enabling "catchup" when re-foregrounding.

### Idle Timer

For multi-turn sessions, an idle timer auto-kills the session if no `sendMessage()` call arrives within `pluginConfig.idleTimeoutMinutes` (default 30 minutes). The timer is:
- Started on `system/init`.
- Reset on every `sendMessage()` and on every multi-turn end-of-turn.
- Cleared on `kill()`, terminal results, and session completion.

### Safety-Net Timer

A 15-second watchdog timer that fires `onWaitingForInput` if **no SDK messages at all** (text, tool_use, result) arrive for 15 consecutive seconds. This catches edge cases where Claude is stuck waiting (e.g. a permission prompt that doesn't produce a `result` event).

- Reset on **every** incoming message in `consumeMessages()`.
- Guarded by `waitingForInputFired` to prevent duplicate notifications.
- Cleared on terminal results and `kill()`.

The primary waiting-for-input signal is the end-of-turn `result` handler; the safety-net timer is a rare fallback.

---

## Event Routing: `triggerAgentEvent` and `triggerWaitingForInputEvent`

Both methods notify the OpenClaw orchestrator agent about session state changes. They use different routing strategies.

### `triggerAgentEvent(session)` — Session Completion

Fired when a session completes (via `onComplete`) or is killed (via `kill()`).

1. **Build event text**: session name, ID, status, last 5 lines of output (capped at 500 chars), and a `claude_output()` call hint.
2. **Route via `routeEventMessage()`** (see below) to the origin channel.
3. **Also fire a system event**: `openclaw system event --text "Session completed" --mode now` as a heartbeat to ensure the orchestrator wakes immediately.

### `triggerWaitingForInputEvent(session)` — Waiting for Input

Fired when a multi-turn (or single-turn) session is waiting for user input.

1. **Debounce**: skips if a waiting event was sent for this session within the last `WAITING_EVENT_DEBOUNCE_MS` (5 seconds). Tracked per-session in `lastWaitingEventTimestamps`.
2. **Build event text**: session type (multi-turn or regular), name, ID, last 5 lines of output (capped at 500 chars), and `claude_respond()` / `claude_output()` call hints.
3. **Route via `openclaw system event --text ... --mode now`** directly (always uses system event, not channel routing).

### `routeEventMessage(session, eventText, label)` — Origin Channel Routing

The shared routing logic used by `triggerAgentEvent`:

```
Parse session.originChannel by splitting on "|":

  ┌─────────────────────────┐
  │ 3+ segments?            │──▶ channel|account|target format
  │ e.g. "telegram|acct|id" │    execFile("openclaw", ["message", "send",
  └─────────────────────────┘      "--channel", parts[0],
                                   "--account", parts[1],
                                   "--target",  parts[2..]])
  ┌─────────────────────────┐
  │ 2 segments?             │──▶ channel|target format
  │ e.g. "telegram|12345"   │    execFile("openclaw", ["message", "send",
  └─────────────────────────┘      "--channel", parts[0],
                                   "--target",  parts[1]])
  ┌─────────────────────────┐
  │ 1 segment / unknown /   │──▶ Fallback: POST to Gateway webhook
  │ missing / empty parts   │    http://127.0.0.1:18789/hooks/wake
  └─────────────────────────┘    { text: eventText, mode: "now" }
```

The fallback webhook wakes the orchestrator agent immediately so it can process the event even when no specific channel is available.

---

## Origin Channel Resolution

The `originChannel` is a string set on `SessionConfig` at spawn time. It identifies the chat channel (e.g. Telegram conversation) that launched the session so that background notifications and completion events are routed back to the right user.

**Format**: `"channel|target"` (2-segment) or `"channel|account|target"` (3-segment), where:
- `channel` — the platform name (e.g. `"telegram"`)
- `account` — optional account identifier
- `target` — the conversation/user ID

**Resolution order** (at tool call time, in `shared.ts`):
1. Explicit `originChannel` from the tool call arguments.
2. `messageChannel` from the `OpenClawPluginToolContext` (the calling agent's current channel).
3. `pluginConfig.agentChannels[workdir]` — a configured map of working directories to channels.
4. `pluginConfig.fallbackChannel` — a global fallback.
5. `"unknown"` — if nothing resolves, routing falls through to the webhook fallback in `routeEventMessage`.

Once set on the session, `originChannel` is used by:
- `NotificationRouter` — for background completion/failure/budget notifications.
- `triggerAgentEvent` — to route the completion event back to the originating channel.
- `triggerWaitingForInputEvent` — included in the event text so the orchestrator knows the source.
