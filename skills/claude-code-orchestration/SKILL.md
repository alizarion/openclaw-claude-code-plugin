---
name: Claude Code Orchestration
description: Skill for orchestrating Claude Code sessions from OpenClaw. Covers launching, monitoring, multi-turn interaction, lifecycle management, notifications, and parallel work patterns.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-claude-code-plugin"]}}}
---

# Claude Code Orchestration

You orchestrate Claude Code sessions via the `openclaw-claude-code-plugin`. Each session is an autonomous agent that executes code tasks in the background.

---

## 1. Launching sessions

### Mandatory rules

- **Notifications are routed automatically** via `agentChannels` config. Do NOT pass `channel` manually — it bypasses automatic routing.
- **Always pass `multi_turn: true`** unless the task is a guaranteed one-shot with no possible follow-up.
- **Name the sessions** with `name` in kebab-case, short and descriptive.
- **Set `workdir`** to the target project directory, not the agent's workspace.

### Essential parameters

| Parameter | When to use |
|---|---|
| `prompt` | Always. Clear and complete instruction. |
| `name` | Always. Descriptive kebab-case (`fix-auth-bug`, `add-dark-mode`). |
| `channel` | **Do NOT pass.** Resolved automatically via `agentChannels`. |
| `workdir` | Always when the project is not in the `defaultWorkdir`. |
| `multi_turn` | `true` by default unless explicitly one-shot. |
| `max_budget_usd` | Adjust accordingly: `1-2` for a small fix, `5` for a feature, `10+` for a major refactoring. |
| `model` | When you want to force a specific model (`"sonnet"`, `"opus"`). |
| `system_prompt` | To inject project-specific context. |
| `permission_mode` | `"bypassPermissions"` by default. `"acceptEdits"` for more control. |

### Examples

```
# Simple task
claude_launch(
  prompt: "Fix the null pointer in src/auth.ts line 42",
  name: "fix-null-auth",
  workdir: "/home/user/projects/myapp",
  multi_turn: true,
  max_budget_usd: 2
)

# Full feature
claude_launch(
  prompt: "Implement dark mode toggle in the settings page. Use the existing theme context in src/context/theme.tsx. Add a toggle switch component and persist the preference in localStorage.",
  name: "add-dark-mode",
  workdir: "/home/user/projects/myapp",
  multi_turn: true,
  max_budget_usd: 5
)

# Major refactoring
claude_launch(
  prompt: "Refactor the database layer to use the repository pattern. Migrate all direct Prisma calls in src/services/ to use repositories in src/repositories/.",
  name: "refactor-db-repositories",
  workdir: "/home/user/projects/myapp",
  multi_turn: true,
  max_budget_usd: 10,
  model: "opus"
)
```

### Resume and fork

```
# Resume a completed session
claude_launch(
  prompt: "Continue. Also add error handling for the edge cases we discussed.",
  resume_session_id: "fix-null-auth",
  multi_turn: true
)

# Fork to try an alternative approach
claude_launch(
  prompt: "Try a completely different approach: use middleware instead of decorators.",
  resume_session_id: "refactor-db-repositories",
  fork_session: true,
  name: "refactor-db-middleware-approach",
  multi_turn: true
)
```

---

## 2. Monitoring sessions

### List sessions

```
# All sessions
claude_sessions()

# Only running sessions
claude_sessions(status: "running")

# Completed sessions (for resume)
claude_sessions(status: "completed")
```

### View output

```
# Summary (last 50 lines)
claude_output(session: "fix-null-auth")

# Full output (up to 200 blocks)
claude_output(session: "fix-null-auth", full: true)

# Specific last N lines
claude_output(session: "fix-null-auth", lines: 100)
```

### Real-time streaming

```
# Switch to foreground (displays catchup of missed outputs + live stream)
claude_fg(session: "fix-null-auth")

# Switch back to background (stops the stream, session continues)
claude_bg(session: "fix-null-auth")

# Detach all foreground sessions from a channel
claude_bg()
```

**Note:** `claude_fg` first displays a catchup "Catchup (N missed outputs):" with everything that happened in the background, then starts live streaming.

---

## 3. Multi-turn interaction

### Send a follow-up

```
# Reply to a Claude question
claude_respond(session: "add-dark-mode", message: "Yes, use CSS variables for the theme colors.")

# Redirect a running session (interrupts the current turn)
claude_respond(session: "add-dark-mode", message: "Stop. Use Tailwind dark: classes instead of CSS variables.", interrupt: true)
```

### When to auto-respond vs forward to the user

**Auto-respond immediately with `claude_respond`:**
- Permission requests to read/write files or run bash commands -> `"Yes, proceed."`
- Confirmations like "Should I continue?" -> `"Yes, continue."`
- Questions about the approach when only one is reasonable -> Respond with the obvious choice
- Clarification requests about the codebase -> Respond if you know, otherwise `"Use your best judgment."`

**Forward to the user:**
- Architecture decisions (Redis vs PostgreSQL, REST vs GraphQL...)
- Destructive operations (deleting files, dropping tables...)
- Ambiguous requirements not covered by the initial prompt
- Scope or budget changes ("This will require refactoring 15 files")
- Anything involving credentials, secrets, or production environments
- When in doubt -> always forward to the user

### Interaction cycle

1. Session launches -> runs in background
2. Wake event `openclaw system event` arrives when the session is waiting for input
3. Read the question with `claude_output(session, full: true)`
4. Decide: auto-respond or forward
5. If auto-respond: `claude_respond(session, answer)`
6. If forward: relay the question to the user, wait for their response, then `claude_respond`

---

## 4. Lifecycle management

### Stop a session

```
claude_kill(session: "fix-null-auth")
```

Use when:
- The session is stuck or looping
- Budget is being wasted on the wrong approach
- The user requests a stop

### Timeouts

- Idle multi-turn sessions are automatically killed after `idleTimeoutMinutes` (default: 30 min)
- Completed sessions are garbage-collected after 1h but remain resumable via persisted IDs

### Check the result after completion

When a session completes (completion wake event):

1. `claude_output(session: "xxx", full: true)` to read the result
2. Summarize the result to the user
3. If failed, analyze the error and decide: relaunch, fork, or escalate

---

## 5. Notifications

### Routing

Notifications are routed automatically based on the session's `workdir` using the `agentChannels` plugin config. Each workspace directory maps to a specific channel (e.g., `telegram:seo-bot:123456789`). See [Agent Channels](../../docs/AGENT_CHANNELS.md) for setup.

### Events

| Event | What happens |
|---|---|
| Session starts | Silent |
| Session in foreground | Real-time stream (text debounced 500ms + tool indicators) |
| Session completed | Notification to the originating channel |
| Session failed | Error notification to the originating channel |
| Waiting for input | `openclaw system event` to wake the orchestrator + `"Claude asks:"` in the channel |
| Response sent | `"Responded:"` echo in the channel |
| Session > 10 min | One-shot reminder |
| Session limit reached | Notification to the channel |

### Background visibility

Even without foreground, the user sees in their chat:
- **`Claude asks:`** when Claude asks a question
- **`Responded:`** when a follow-up is sent

This makes the conversation transparent without needing foregrounding.

---

## 6. Best practices

### Launch checklist

1. `agentChannels` is configured for this workdir -> notifications arrive
2. `multi_turn: true` -> interaction is possible after launch
3. `name` is descriptive -> easy to identify in `claude_sessions`
4. `workdir` points to the correct project -> Claude Code works in the right directory
5. `max_budget_usd` is calibrated -> no waste

### Parallel tasks

```
# Launch multiple sessions on independent tasks
claude_launch(prompt: "Build the frontend auth page", name: "frontend-auth", workdir: "/app/frontend", multi_turn: true, max_budget_usd: 5)
claude_launch(prompt: "Build the backend auth API", name: "backend-auth", workdir: "/app/backend", multi_turn: true, max_budget_usd: 5)
```

- Respect the `maxSessions` limit (default: 5)
- Each session must have a unique `name`
- Monitor each session individually via wake events
- Don't launch too many sessions in parallel: each session consumes resources and budget

### Error handling

- If a session fails, read the full output to understand why
- Relaunch with a corrected prompt if the error is in the instruction
- Fork (`fork_session: true`) if you want to try a different approach without losing context
- Escalate to the user if the error is outside your control (permissions, network, missing dependencies)

### Reporting results

When a session completes:
1. Read the full result with `claude_output(session, full: true)`
2. Summarize the changes made to the user
3. Mention the files modified/created
4. Flag any issues encountered or remaining TODOs

---

## 7. Anti-patterns

| Anti-pattern | Consequence | Fix |
|---|---|---|
| Passing `channel` explicitly | Bypasses automatic routing, notifications may go to wrong bot | Let `agentChannels` handle routing automatically |
| Forgetting `multi_turn: true` | Unable to send follow-ups with `claude_respond` | Enable `multi_turn` except for explicit one-shots |
| Not checking the result of a completed session | The user doesn't know what happened | Always read `claude_output` and summarize |
| Launching too many sessions in parallel | `maxSessions` limit reached, sessions rejected, diluted attention | Respect the limit, prioritize, sequence if necessary |
| Using the agent's `workdir` instead of the project's | Claude Code works in the wrong directory | Always point to the target project directory |
| Not naming sessions | Hard to identify them in `claude_sessions` | Always use `name` in kebab-case |
| Auto-responding to critical questions | Decisions made without the user's approval | When in doubt, forward to the user |
| Ignoring wake events | Sessions stuck waiting indefinitely | Handle each wake event promptly |
| Not adjusting the budget | Waste (too high) or interruption (too low) | Calibrate `max_budget_usd` based on complexity |

---

## 8. Quick tool reference

| Tool | Usage | Key parameters |
|---|---|---|
| `claude_launch` | Launch a session | `prompt`, `name`, `workdir`, `multi_turn`, `max_budget_usd` |
| `claude_sessions` | List sessions | `status` (all/running/completed/failed) |
| `claude_output` | Read the output | `session`, `full`, `lines` |
| `claude_fg` | Foreground + live stream | `session` |
| `claude_bg` | Switch back to background | `session` |
| `claude_kill` | Kill a session | `session` |
| `claude_respond` | Send a follow-up | `session`, `message`, `interrupt` |
| `claude_stats` | Usage metrics | none |
