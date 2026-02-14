# API Reference

Complete reference for all Claude Code Plugin interfaces: tools (for the OpenClaw AI agent), chat commands (for humans), and gateway RPC methods (for external systems).

---

## Tools

Tools are invoked by the OpenClaw AI agent programmatically. They follow the MCP tool calling convention. All tools are registered as factory functions — each invocation receives the calling agent's context (`agentId`, `workspaceDir`, `messageChannel`, `agentAccountId`, `sessionKey`, `sandboxed`). Channel resolution for notifications is automatic (from context and `agentChannels` config), so tools do not expose a `channel` parameter.

### `claude_launch`

Launch a new Claude Code session in background. Sessions are **multi-turn by default** — they stay open for follow-up messages via `claude_respond`. Four pre-launch safety checks run before any session is spawned (see [README — Pre-Launch Safety Checks](../README.md#pre-launch-safety-checks)).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | Yes | The task prompt to execute. |
| `name` | `string` | No | Human-readable name (kebab-case). Auto-generated from prompt if omitted. |
| `workdir` | `string` | No | Working directory. Defaults to ctx `workspaceDir`, config `defaultWorkdir`, or `cwd`. |
| `model` | `string` | No | Model name (e.g. `"sonnet"`, `"opus"`). |
| `max_budget_usd` | `number` | No | Maximum budget in USD. Default: `5`. |
| `system_prompt` | `string` | No | Additional system prompt appended to the session. |
| `allowed_tools` | `string[]` | No | Explicit list of allowed tools. |
| `resume_session_id` | `string` | No | Claude session ID (or name/internal ID) to resume from. Resolved via active sessions, persisted sessions, or raw UUID. |
| `fork_session` | `boolean` | No | Fork instead of continuing when resuming. Creates a new branch from the session. |
| `multi_turn_disabled` | `boolean` | No | Disable multi-turn mode. By default sessions stay open for follow-up messages. Set to `true` for fire-and-forget sessions. |
| `permission_mode` | `string` | No | One of `"default"`, `"plan"`, `"acceptEdits"`, `"bypassPermissions"`. Defaults to plugin config or `"bypassPermissions"`. |

**Channel resolution priority** (automatic, no parameter needed):
1. `ctx.messageChannel` + `ctx.agentAccountId` (3-segment format)
2. `resolveAgentChannel(ctx.workspaceDir)` from `agentChannels` config
3. `resolveAgentChannel(workdir)` as secondary workspace lookup
4. `ctx.messageChannel` as-is (if it already contains `|`)
5. `pluginConfig.fallbackChannel`

### `claude_sessions`

List all sessions with status and progress. When the calling agent has a workspace mapped in `agentChannels`, results are filtered to show only that agent's sessions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | `string` | No | Filter: `"all"` (default), `"running"`, `"completed"`, `"failed"`. |

### `claude_output`

Show output from a session's circular buffer (last 200 text blocks).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `string` | Yes | Session name or ID. |
| `lines` | `number` | No | Number of recent lines to show (default 50). |
| `full` | `boolean` | No | Show all available output (up to 200 buffered blocks). |

### `claude_fg`

Bring a session to foreground — displays any missed background output under a "Catchup (N missed outputs):" header, then starts streaming new output to the current channel in real time. Channel is resolved automatically from the tool factory context.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `string` | Yes | Session name or ID. |
| `lines` | `number` | No | Number of recent buffered lines to show if no catchup available (default 30). |

### `claude_bg`

Send a session back to background (stop streaming). Saves the output offset so the next `claude_fg` can show catchup from where the channel left off.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `string` | No | Session name or ID. If omitted, detaches all foreground sessions for the current channel. |

### `claude_kill`

Terminate a running session. Killed sessions are persisted for resume and trigger completion notifications.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `string` | Yes | Session name or ID. |

### `claude_respond`

Send a follow-up message to a running multi-turn session. Also emits a `↩️ Responded:` notification to the origin channel so the conversation is visible in-chat.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `string` | Yes | Session name or ID. |
| `message` | `string` | Yes | The message to send. |
| `interrupt` | `boolean` | No | Interrupt the current turn before sending. Useful to redirect mid-response. |

### `claude_stats`

Show usage metrics. Takes no parameters.

Returns: session counts by status, average duration, total launched, and notable session (most expensive). Cost data is tracked internally for metrics but not exposed in user-facing output.

---

## Commands

All commands require authentication (`requireAuth: true`).

| Command | Arguments | Description |
|---|---|---|
| `/claude [--name <name>] <prompt>` | Required: prompt | Launch a new session (multi-turn by default). |
| `/claude_sessions` | None | List all sessions with status, duration, mode, workdir. |
| `/claude_kill <name-or-id>` | Required: session ref | Terminate a session. |
| `/claude_fg <name-or-id>` | Required: session ref | Bring a session to foreground with catchup. |
| `/claude_bg [name-or-id]` | Optional: session ref | Detach foreground session(s). No arg = detach all. |
| `/claude_resume <ref> [prompt]` | Required: session ref | Resume a completed session with an optional new prompt. |
| `/claude_resume --list` | Flag | List all resumable sessions with Claude IDs. |
| `/claude_resume --fork <ref> [prompt]` | Required: session ref | Fork a completed session into a new branch. |
| `/claude_respond <ref> <message>` | Required: session ref + message | Send a follow-up message. |
| `/claude_respond --interrupt <ref> <msg>` | Flag + session ref + message | Interrupt current turn, then send. |
| `/claude_stats` | None | Show usage metrics (launched, running, completed, failed, killed, avg duration). |

---

## RPC Methods

Gateway RPC methods allow external clients (dashboards, APIs, other plugins) to control sessions programmatically. All methods return `respond(true, data)` on success or `respond(false, { error })` on failure. All methods accept both camelCase and snake_case parameter names.

### `claude-code.sessions`

| Parameter | Type | Description |
|---|---|---|
| `status` | `string` | Filter: `"all"`, `"running"`, `"completed"`, `"failed"`. |

**Response:** `{ sessions: [...], count: number }`

Each session object includes: `id`, `name`, `status`, `prompt`, `workdir`, `model`, `costUsd`, `startedAt`, `completedAt`, `durationMs`, `claudeSessionId`, `foreground`, `multiTurn`, `display`.

### `claude-code.launch`

| Parameter | Type | Description |
|---|---|---|
| `prompt` | `string` | **(required)** Task prompt. |
| `name` | `string` | Session name. |
| `workdir` | `string` | Working directory. |
| `model` | `string` | Model name. |
| `maxBudgetUsd` / `max_budget_usd` | `number` | Budget cap. |
| `systemPrompt` / `system_prompt` | `string` | System prompt. |
| `allowedTools` / `allowed_tools` | `string[]` | Allowed tools. |
| `resumeSessionId` / `resume_session_id` | `string` | Session ID to resume. |
| `forkSession` / `fork_session` | `boolean` | Fork on resume. |
| `multiTurnDisabled` / `multi_turn_disabled` | `boolean` | Set `true` for fire-and-forget. Default: multi-turn enabled. |
| `originChannel` | `string` | Origin channel for notifications. Defaults to `"gateway"`. |

**Response:** `{ id, name, status, workdir, model }`

**Note:** The gateway `launch` method does **not** run the four pre-launch safety checks (those are enforced only in the `claude_launch` tool for agent callers). Gateway callers are assumed to be properly configured external systems.

### `claude-code.kill`

| Parameter | Type | Description |
|---|---|---|
| `session` / `id` | `string` | **(required)** Session name or ID. |

**Response:** `{ id, name, status, message }`

### `claude-code.output`

| Parameter | Type | Description |
|---|---|---|
| `session` / `id` | `string` | **(required)** Session name or ID. |
| `lines` | `number` | Number of lines (default 50). |
| `full` | `boolean` | Return all buffered output. |

**Response:** `{ id, name, status, costUsd, durationMs, duration, lines, lineCount, result }`

### `claude-code.stats`

No parameters.

**Response:**
```json
{
  "totalCostUsd": 1.23,
  "costPerDay": { "2025-01-15": 0.50, "2025-01-16": 0.73 },
  "sessionsByStatus": { "completed": 10, "failed": 2, "killed": 1, "running": 1 },
  "totalLaunched": 14,
  "averageDurationMs": 45000,
  "mostExpensive": { "id": "abc123", "name": "refactor-db", "costUsd": 0.42, "prompt": "..." },
  "display": "Claude Code Plugin Stats\n..."
}
```
