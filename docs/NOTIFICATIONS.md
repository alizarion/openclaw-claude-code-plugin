# Notification System

The `NotificationRouter` class is the central notification engine for the plugin. It decides **when**, **what**, and **where** to send messages based on session state (foreground vs background) and event type. It is defined in `src/notifications.ts`.

---

## NotificationRouter Class

### Construction

```ts
const router = new NotificationRouter(sendMessage);
```

The constructor takes a single `SendMessageFn` callback:

```ts
type SendMessageFn = (channelId: string, text: string) => void;
```

This callback is the plugin's bridge to whatever messaging transport is in use (Telegram, Discord, etc.). The router wraps the provided function with debug logging (channel ID, text length, and a 120-char preview) before forwarding the call.

### Internal State

| Field | Type | Purpose |
|---|---|---|
| `sendMessage` | `SendMessageFn` | Wrapped message-sending callback |
| `debounceMap` | `Map<string, DebounceEntry>` | Per-session, per-channel debounce buffers for foreground text streaming |
| `longRunningReminded` | `Set<string>` | Session IDs that have already received the 10-minute reminder |
| `reminderInterval` | `setInterval` handle | Fires every 60 seconds to check for long-running sessions |
| `getActiveSessions` | `() => Session[]` | Injected callback that returns all currently active sessions |

### Lifecycle

- **`startReminderCheck(getActiveSessions)`** — Begins a 60-second polling interval that calls `checkLongRunning()`. Must be called after construction with a function that returns the current session list.
- **`stop()`** — Clears the reminder interval, flushes all pending debounce buffers (sending any buffered text immediately), and resets all internal state.

---

## Notification Matrix

| Event | Background session | Foreground session |
|---|---|---|
| Session started | Silent | Silent (streaming begins) |
| Assistant text output | Silent | Streamed to chat (500ms debounce) |
| Tool call | Silent | Compact indicator (e.g. `🔧 Bash — git status`) |
| Tool result | Silent | Silent |
| Session completed (success) | Notify origin channel | Notify foreground + origin channels |
| Session completed (error/fail) | Notify origin channel | Notify foreground + origin channels |
| Budget exhausted | Notify origin channel | Notify foreground + origin channels |
| Session killed | Notify origin channel | Notify foreground + origin channels |
| Session > 10 minutes | One-time reminder to origin | Silent (user already sees output) |
| Waiting for input | `🔔 [name] Claude asks:` + output preview | `💬 Session waiting for input` + respond hint |

---

## Notification Types (Public API)

### `onAssistantText(session, text)`

Called when an assistant text block arrives on a session's streaming output.

- **Foreground channels**: Text is appended to a debounce buffer keyed by `sessionId|channelId`. After 500ms of inactivity, the accumulated buffer is flushed and sent as a single message. This batches rapid token-by-token output into readable chunks.
- **Background channels (no foreground)**: Silently ignored — no text is streamed to background channels.

### `onToolUse(session, toolName, toolInput)`

Called when a `tool_use` content block arrives in an assistant message.

- **Foreground channels only**. First flushes any pending debounced text for the channel (so text appears before the tool indicator), then sends a compact one-line summary:
  ```
  🔧 toolName — inputSummary
  ```
- The `inputSummary` is produced by `summarizeToolInput()`, which extracts a human-readable string from common tool input shapes:
  - `file_path` or `path` → file path (truncated to 60 chars)
  - `command` → bash command (truncated to 80 chars)
  - `pattern` or `glob` → search/glob pattern (truncated to 60 chars)
  - Falls back to the first non-empty string value in the input object
- **Background channels**: Silently ignored.

### `onSessionComplete(session, originChannel?)`

Called when a session finishes (status: `completed`, `failed`, or `killed`).

1. Flushes all pending debounce buffers for foreground channels.
2. Formats a completion notification via `formatCompletionNotification()`:
   - ✅ **Completed**: `✅ Claude Code [id] completed (duration)` + workdir + prompt summary
   - ❌ **Failed**: `❌ Claude Code [id] failed (duration)` + workdir + prompt summary + error detail (from `session.error` or `session.result.subtype`)
   - ⛔ **Killed**: `⛔ Claude Code [id] killed (duration)` + workdir + prompt summary
3. Delivers the notification to **all** foreground channels **plus** the origin channel (if provided). The union ensures both actively-watching users and the original requester are notified.
4. Cleans up all debounce entries and long-running reminder state for the session.

### `onBudgetExhausted(session, originChannel?)`

Called when a session hits its budget limit (`error_max_budget_usd`).

1. Flushes foreground debounce buffers.
2. Sends a distinct message:
   ```
   ⛔ Session limit reached — name [id] (duration)
      📁 /workdir
   ```
3. Delivers to the union of foreground + origin channels.
4. Cleans up session state.

This is exposed separately from `onSessionComplete` for custom formatting, even though budget exhaustion also triggers a result event.

### `onWaitingForInput(session, originChannel?)`

Called when a session is waiting for user input (Claude asked a question, needs a permission decision, or finished a turn in multi-turn mode).

1. Flushes foreground debounce buffers.
2. Retrieves the last 5 lines of session output via `session.getOutput(5)` and builds a preview (capped at 500 characters from the end).
3. Sends **different messages** depending on channel type:

   **Background channels** (origin channel that is not in the foreground set):
   ```
   🔔 [sessionName] Claude asks:
   <preview of last output>
   ```
   This gives the user full context of what Claude is asking, since they haven't been seeing the streamed output.

   **Foreground channels**:
   ```
   💬 Session name [id] is waiting for input (duration)
      Use claude_respond to reply.
   ```
   Compact, because the user has already seen the streamed output.

---

## `emitToChannel(channelId, text)`

A direct passthrough to `sendMessage` that bypasses all debounce and routing logic. Used by tools like `claude_respond` to echo feedback messages (e.g. `↩️ [name] Responded: ...`) directly into a specific channel's conversation thread.

---

## Debouncing Mechanism

Foreground text streaming uses a per-session, per-channel debounce to batch rapid token output into readable messages.

### How It Works

1. **Key**: Each debounce buffer is identified by `"sessionId|channelId"`.
2. **Append**: When `onAssistantText` is called, text is appended to the buffer for each foreground channel. A 500ms timer is (re)started.
3. **Flush**: When 500ms pass with no new text, the buffer is sent as a single message and the entry is deleted.
4. **Forced flush**: `flushDebounced()` is called explicitly before tool indicators (`onToolUse`), completion notifications (`onSessionComplete`, `onBudgetExhausted`), and waiting-for-input notifications (`onWaitingForInput`) to ensure buffered text is delivered before the event message.
5. **Cleanup on stop**: `stop()` flushes all pending buffers immediately (sending any remaining text) and clears the map.
6. **Cleanup on session end**: `cleanupSession()` clears all debounce entries and the long-running reminder flag for a given session ID.

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `DEBOUNCE_MS` | 500 | Milliseconds of inactivity before flushing buffered text |
| `LONG_RUNNING_THRESHOLD_MS` | 600,000 (10 min) | Duration after which a background session triggers a reminder |

---

## Long-Running Session Reminders

A background polling loop detects sessions that have been running for more than 10 minutes without a foreground channel.

### Mechanism

1. `startReminderCheck()` starts a `setInterval` that fires every **60 seconds**.
2. On each tick, `checkLongRunning()` iterates all active sessions.
3. A session triggers a reminder if **all** of these are true:
   - Status is `"running"` or `"starting"`
   - It has **zero** foreground channels (purely background)
   - It has **not** already been reminded (`longRunningReminded` set)
   - Elapsed time exceeds 10 minutes
4. The reminder is sent **once** per session to the `session.originChannel`:
   ```
   ⏱️ Session name [id] running for duration
      📁 /workdir
      Use claude_fg to check on it, or claude_kill to stop it.
   ```
5. The session ID is added to `longRunningReminded` to prevent duplicate reminders.
6. The flag is cleared when the session ends (via `cleanupSession`).

---

## sendMessage Routing

The `SendMessageFn` callback is the plugin's single point of message delivery. The `NotificationRouter` does not resolve channels itself — it receives channel IDs from the `Session` object and passes them through.

### Channel Resolution

- **Foreground channels**: Read from `session.foregroundChannels` (a `Set<string>`). These are channels where a user has explicitly foregrounded the session (e.g. via `claude_fg`).
- **Origin channel**: Passed as the optional `originChannel` parameter to `onSessionComplete`, `onBudgetExhausted`, and `onWaitingForInput`. This is the channel where the session was originally launched.
- **Channel union**: For completion and input-waiting events, both sets are merged (`new Set([...foregroundChannels, originChannel])`) to ensure all interested parties receive the notification.

### Target Selection per Event

| Event | Channels notified |
|---|---|
| `onAssistantText` | Foreground only |
| `onToolUse` | Foreground only |
| `onSessionComplete` | Foreground ∪ Origin |
| `onBudgetExhausted` | Foreground ∪ Origin |
| `onWaitingForInput` | Foreground ∪ Origin (with different message formats) |
| `emitToChannel` | Explicit channel ID (caller decides) |
| Long-running reminder | Origin only |

---

## Helper Functions

### `formatCompletionNotification(session)`

Produces a multi-line completion message based on `session.status`. Includes the session ID, duration, working directory, and a truncated prompt summary (max 60 characters). For failed sessions, appends error details from `session.error` or `session.result.subtype`.

### `summarizeToolInput(input)`

Extracts a short human-readable summary from a tool's input object. Checks fields in priority order: `file_path` → `path` → `command` → `pattern` → `glob` → first string value. Returns an empty string if no suitable field is found.

### `truncate(s, maxLen)`

Truncates a string to `maxLen` characters, appending `...` if truncated.
