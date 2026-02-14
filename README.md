# Claude Code Plugin

**An OpenClaw plugin that orchestrates Claude Code sessions as managed background processes.**

Launch, monitor, and interact with multiple Claude Code SDK sessions directly from any OpenClaw channel (Telegram, Discord, etc.). Turn OpenClaw into a control plane for autonomous coding agents — launch tasks, stream output in real time, send follow-up messages, resume previous conversations, and catch up on missed output — all without leaving your chat interface.

[![Demo Video](https://img.youtube.com/vi/vbX1Y0Nx4Tc/maxresdefault.jpg)](https://youtube.com/shorts/vbX1Y0Nx4Tc)

*Orchestrating two parallel Claude Code agents from Telegram — building an X clone and an Instagram clone simultaneously.*

---

## Features

- **Multi-session management** — Run up to N concurrent sessions (configurable), each with a unique ID and human-readable name
- **Foreground / background model** — Sessions run in the background by default; bring any session to the foreground to stream output in real time
- **Foreground catchup** — When foregrounding, missed background output is displayed before live streaming begins
- **Multi-turn conversations** — Sessions are multi-turn by default; send follow-up messages, refine instructions, or have iterative dialogues with a running agent. Set `multi_turn_disabled: true` for fire-and-forget sessions
- **Session resume & fork** — Resume any completed session or fork it into a new branch of conversation
- **Pre-launch safety checks** — Four mandatory guards (autonomy skill, heartbeat config, HEARTBEAT.md, agentChannels mapping) ensure every agent is properly configured before spawning sessions
- **Real-time notifications** — Completion alerts, budget exhaustion warnings, long-running reminders, and live tool-use indicators
- **Background visibility** — See `🔔 Claude asks:` and `↩️ Responded:` in-channel even when sessions run in the background
- **Waiting-for-input wake events** — `openclaw system event` fired when sessions become idle, waking the orchestrator agent
- **Multi-agent support** — Route notifications to the correct agent/chat via `agentChannels` workspace mapping with longest-prefix matching
- **Triple interface** — Every operation available as a chat command, agent tool, and gateway RPC method
- **Automatic cleanup** — Completed sessions garbage-collected after 1 hour; persisted IDs survive for resume

---

## Installation

### From npm

```bash
openclaw plugins install @betrue/openclaw-claude-code-plugin
```

### From source

```bash
git clone git@github.com:alizarion/openclaw-claude-code-plugin.git
openclaw plugins install ./openclaw-claude-code-plugin
```

### For development (symlink)

```bash
git clone git@github.com:alizarion/openclaw-claude-code-plugin.git
openclaw plugins install --link ./openclaw-claude-code-plugin
```

### After installation

Restart the gateway to load the plugin:

```bash
openclaw gateway restart
```

Ensure `openclaw` CLI is available in your PATH — the plugin shells out to `openclaw message send` for notifications and `openclaw system event` for agent triggers.

---

## Pre-Launch Safety Checks

When an agent calls the `claude_launch` tool, four mandatory guards run before any session is spawned. If any check fails, the launch is blocked and an actionable error message is returned telling the agent exactly how to fix the issue. These checks are enforced only on the `claude_launch` tool — the gateway RPC `claude-code.launch` method and `/claude` chat command skip them.

### 1. Autonomy Skill

**Checks for:** `{agentWorkspace}/skills/claude-code-autonomy/SKILL.md`

The autonomy skill defines how the agent handles Claude Code interactions (auto-respond to routine questions, forward architecture decisions to the user, etc.). Without it, the agent is told to ask the user what level of autonomy they want, then create the skill directory with `SKILL.md` and `autonomy.md`.

### 2. Heartbeat Configuration

**Checks for:** `heartbeat` field in `~/.openclaw/openclaw.json` under `agents.list[]` for the current agent (resolved from `ctx.agentId` or `resolveAgentId(workdir)` via the `agentChannels` mapping).

Heartbeat enables automatic "waiting for input" notifications so the agent gets nudged when a Claude Code session needs attention. The expected config:

```json
{ "heartbeat": { "every": "5s", "target": "last" } }
```

### 3. HEARTBEAT.md Content

**Checks for:** `{agentWorkspace}/HEARTBEAT.md` with real content (not just comments, blank lines, or whitespace — validated via regex `/^(\s|#.*)*$/`).

The heartbeat file tells the agent what to do during heartbeat cycles — e.g. check for waiting Claude Code sessions, read their output, and respond or notify the user.

### 4. agentChannels Mapping

**Checks for:** A matching entry in `pluginConfig.agentChannels` for the session's working directory, resolved via `resolveAgentChannel(workdir)`.

The workspace must be mapped to a notification channel so session events (completion, waiting-for-input, etc.) reach the correct agent/chat. Uses longest-prefix matching with trailing slash normalisation.

---

## Configuration

Configuration is defined in `openclaw.plugin.json` and passed to the plugin via `api.getConfig()`. Set values in `~/.openclaw/openclaw.json` under `plugins.config["openclaw-claude-code-plugin"]`.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxSessions` | `number` | `5` | Max concurrently active sessions. |
| `defaultBudgetUsd` | `number` | `5` | Default max budget per session in USD. |
| `defaultModel` | `string` | — | Default model (e.g. `"sonnet"`, `"opus"`). |
| `defaultWorkdir` | `string` | — | Default working directory. Falls back to `process.cwd()`. |
| `idleTimeoutMinutes` | `number` | `30` | Idle timeout for multi-turn sessions before auto-kill. |
| `maxPersistedSessions` | `number` | `50` | Max completed sessions kept for resume. |
| `fallbackChannel` | `string` | — | Fallback notification channel (e.g. `"telegram\|123456789"`). |
| `permissionMode` | `string` | `"bypassPermissions"` | Default permission mode: `"default"`, `"plan"`, `"acceptEdits"`, `"bypassPermissions"`. |
| `agentChannels` | `Record<string, string>` | — | Map workdir paths to notification channels. See [Agent Channels](docs/AGENT_CHANNELS.md). |

```json
{
  "maxSessions": 3,
  "defaultBudgetUsd": 10,
  "defaultModel": "sonnet",
  "defaultWorkdir": "/home/user/projects",
  "permissionMode": "bypassPermissions",
  "fallbackChannel": "telegram|main-bot|123456789",
  "agentChannels": {
    "/home/user/agent-seo": "telegram|seo-bot|123456789",
    "/home/user/agent-main": "telegram|main-bot|123456789"
  }
}
```

---

## Quick Usage

### Chat Commands

```
/claude Fix the authentication bug in src/auth.ts
/claude --name fix-auth Fix the authentication bug
/claude_sessions
/claude_fg fix-auth
/claude_respond fix-auth Also add unit tests
/claude_respond --interrupt fix-auth Stop that and do this instead
/claude_bg fix-auth
/claude_kill fix-auth
/claude_resume fix-auth Add error handling
/claude_resume --fork fix-auth Try a different approach
/claude_resume --list
/claude_stats
```

### Agent Tools

Tools receive the calling agent's context automatically. Channel resolution is handled internally — **no `channel` parameter** is exposed on any tool. The parameter `multi_turn_disabled` (not `multi_turn`) controls single-turn mode.

```
claude_launch(prompt: "Fix auth bug", workdir: "/app", name: "fix-auth")
claude_launch(prompt: "Quick check", multi_turn_disabled: true)
claude_sessions(status: "running")
claude_output(session: "fix-auth", lines: 20)
claude_output(session: "fix-auth", full: true)
claude_fg(session: "fix-auth")
claude_bg(session: "fix-auth")
claude_respond(session: "fix-auth", message: "Also add tests")
claude_respond(session: "fix-auth", message: "Do this instead", interrupt: true)
claude_kill(session: "fix-auth")
claude_stats()
```

### Gateway RPC

```json
{ "method": "claude-code.launch", "params": { "prompt": "Fix auth", "workdir": "/app" } }
{ "method": "claude-code.sessions", "params": { "status": "running" } }
{ "method": "claude-code.output", "params": { "session": "fix-auth", "full": true } }
{ "method": "claude-code.kill", "params": { "session": "fix-auth" } }
{ "method": "claude-code.stats" }
```

For the full API reference (all parameter tables, response schemas), see [docs/API.md](docs/API.md).

---

## Multi-Agent Setup

See [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md) for the complete guide. Quick summary:

Each agent needs three things configured:

1. **agentChannels mapping** — Map the agent's workspace directory to its notification channel in `openclaw.json`:
   ```json
   {
     "plugins": {
       "config": {
         "openclaw-claude-code-plugin": {
           "agentChannels": {
             "/home/user/agent-seo": "telegram|seo-bot|123456789",
             "/home/user/agent-devops": "telegram|devops-bot|123456789"
           }
         }
       }
     }
   }
   ```

2. **Heartbeat** — Enable heartbeat for each agent in `openclaw.json`:
   ```json
   {
     "agents": {
       "list": [
         { "id": "seo-bot", "heartbeat": { "every": "5s", "target": "last" } },
         { "id": "devops-bot", "heartbeat": { "every": "5s", "target": "last" } }
       ]
     }
   }
   ```

3. **Agent files** — Each agent's workspace needs:
   - `HEARTBEAT.md` — Instructions for checking Claude Code sessions during heartbeat cycles
   - `skills/claude-code-autonomy/SKILL.md` — Autonomy rules for handling session interactions

---

## Skill Example

Claude Code Plugin is a **transparent transport layer** — it spawns sessions and delivers notifications, but business logic lives in **OpenClaw skills**. Here's a minimal skill that orchestrates coding agent sessions:

### `coding-agent/SKILL.md`

```markdown
---
name: Coding Agent Orchestrator
description: Orchestrates Claude Code sessions with smart auto-response rules for routine questions and user forwarding for critical decisions.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-claude-code-plugin"]}}}
---

# Coding Agent Orchestrator

You are a coding agent orchestrator. You manage Claude Code sessions via the claude-code plugin tools.

## Auto-response rules

When a Claude Code session asks a question (wake event), analyze it and decide:

### Auto-respond (use `claude_respond` immediately):
- Permission requests for file reads, writes, or bash commands -> "Yes, proceed."
- Confirmation prompts like "Should I continue?" -> "Yes, continue."
- Questions about approach when only one is reasonable -> respond with the obvious choice

### Forward to user:
- Architecture decisions (Redis vs PostgreSQL, REST vs GraphQL...)
- Destructive operations (deleting files, dropping tables...)
- Anything involving credentials, secrets, or production environments
- When in doubt -> always forward to the user

## Workflow

1. User sends a coding task -> `claude_launch(prompt, ...)`
2. Session runs in background. Monitor via wake events.
3. On wake event -> `claude_output` to read the question, then auto-respond or forward.
4. On user reply to a forwarded question -> `claude_respond` with their answer.
5. On completion -> summarize the result and notify the user.
```

A comprehensive orchestration skill is available at [`skills/claude-code-orchestration/SKILL.md`](skills/claude-code-orchestration/SKILL.md).

---

## Documentation

| Document | Description |
|---|---|
| [docs/API.md](docs/API.md) | Full API reference — tools, commands, and RPC methods with parameter tables |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture diagram and component breakdown |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Notification matrix, delivery details, and agent wake events |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Project structure, dependencies, design decisions, and contribution guide |
| [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md) | Multi-agent setup, notification routing, and workspace mapping |

---

## License

See the project repository for license information.
