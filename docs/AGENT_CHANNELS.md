# Agent Channels — Multi-Agent Notification Routing

## What is `agentChannels`?

`agentChannels` is a configuration map that binds **workspace directories** to **notification channels**. When a Claude Code session finishes, encounters an error, or needs user input, the plugin must know _where_ to send the notification. In a single-agent setup a hardcoded fallback is enough, but the moment you run **multiple agents** — each with its own Telegram bot, its own chat, and its own project directory — you need a way to route notifications to the right place.

`agentChannels` solves this: it maps each agent's working directory to a `channel|accountId|chatId` string so the plugin can automatically route every notification to the correct bot and chat **without the agent ever passing a channel parameter**.

### Why is it needed?

Without `agentChannels`, the plugin has no way to know which Telegram bot or chat should receive notifications for a given session. The `claude_launch` tool will **block the launch entirely** if no mapping is found for the session's `workdir`. This is intentional — launching a session whose notifications disappear into the void is worse than refusing to start.

---

## Configuration

`agentChannels` lives in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-claude-code-plugin"].config`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code-plugin": {
        "enabled": true,
        "config": {
          "agentChannels": {
            "/home/user/agent-seo":  "telegram|seo-bot|123456789",
            "/home/user/agent-main": "telegram|main-bot|9876543210",
            "/home/user/shared":     "telegram|ops-bot|5555555555"
          },
          "fallbackChannel": "telegram|default-bot|123456789"
        }
      }
    }
  }
}
```

### Keys — workspace directory paths

Each key is an **absolute directory path** representing an agent's workspace (or any project directory). Trailing slashes are stripped before comparison, so `/home/user/agent-seo` and `/home/user/agent-seo/` are equivalent.

### Values — channel strings

The value is a pipe-separated string with 2 or 3 segments:

| Format | Example | Meaning |
|---|---|---|
| `channel\|accountId\|target` | `telegram\|seo-bot\|123456789` | Route via the `seo-bot` Telegram bot account to chat `123456789` |
| `channel\|target` | `telegram\|123456789` | Route via the default bot to chat `123456789` (no specific account) |

The 3-segment format is required for multi-agent setups where each agent uses a different bot account.

### TypeScript type

```ts
agentChannels?: Record<string, string>;
// key:   absolute workspace directory path
// value: "channel|accountId|chatId" or "channel|chatId"
```

---

## `resolveAgentChannel` — Longest-Prefix Matching

The function `resolveAgentChannel(workdir)` in `src/shared.ts` resolves which channel string a given working directory maps to.

### Algorithm

1. **Normalise** the input `workdir` by stripping trailing slashes.
2. **Sort** all `agentChannels` entries by key (path) length in **descending** order — longest paths first.
3. **Iterate** through sorted entries and return the first match where:
   - `workdir === entry.path` (exact match), **or**
   - `workdir.startsWith(entry.path + "/")` (prefix match — workdir is a subdirectory).
4. If no entry matches, return `undefined`.

### Why longest-prefix?

Given this config:

```json
{
  "/home/user/projects":         "telegram|general-bot|111",
  "/home/user/projects/seo-app": "telegram|seo-bot|222"
}
```

A session launched in `/home/user/projects/seo-app/backend` matches **both** entries. The longest-prefix rule ensures it resolves to `telegram|seo-bot|222` (the more specific match), not the general `/home/user/projects` catch-all.

### Example resolutions

| `workdir` | Resolved channel |
|---|---|
| `/home/user/projects/seo-app` | `telegram\|seo-bot\|222` (exact match) |
| `/home/user/projects/seo-app/backend` | `telegram\|seo-bot\|222` (prefix match) |
| `/home/user/projects/other-app` | `telegram\|general-bot\|111` (prefix match) |
| `/tmp/scratch` | `undefined` (no match) |

---

## `fallbackChannel`

`fallbackChannel` is a separate field under `plugins.entries["openclaw-claude-code-plugin"].config` used by `resolveOriginChannel()` — **not** by `resolveAgentChannel()`.

When the plugin cannot determine the origin channel from the command/tool context (no `ctx.channel`, no `ctx.chatId`, etc.) and no explicit channel was provided, it falls back to `pluginConfig.fallbackChannel`. If that is also unset, it returns `"unknown"`.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code-plugin": {
        "enabled": true,
        "config": {
          "fallbackChannel": "telegram|default-bot|123456789"
        }
      }
    }
  }
}
```

> **Note:** `fallbackChannel` does **not** rescue a missing `agentChannels` mapping. The `claude_launch` pre-launch guard checks `resolveAgentChannel(workdir)` independently — if it returns `undefined`, launch is blocked regardless of `fallbackChannel`.

---

## Related helper functions

### `extractAgentId(channelStr)`

Extracts the **middle segment** (account/agent ID) from a 3-segment channel string.

```
"telegram|seo-bot|123456789"  →  "seo-bot"
"telegram|123456789"          →  undefined  (only 2 segments)
```

### `resolveAgentId(workdir)`

Combines `resolveAgentChannel` and `extractAgentId` to get the agent account ID for a given workspace:

```
resolveAgentId("/home/user/agent-seo")  →  "seo-bot"
```

This is used by the heartbeat guard to look up the agent's entry in `openclaw.json → agents.list`.

---

## Pre-Launch Guards in `claude_launch`

The `claude_launch` tool runs **four sequential guards** before spawning a session. If any guard fails, the launch is blocked with an error and instructions for the agent to fix the issue.

### Guard 1 — Autonomy Skill

Checks that `<agentWorkspace>/skills/claude-code-autonomy/SKILL.md` exists. This file defines how the agent handles Claude Code interactions (auto-respond, ask user, etc.).

**Blocked?** The agent must ask the user for their autonomy preferences and create the skill directory.

### Guard 2 — Heartbeat Configuration

Uses `resolveAgentId(workdir)` to find the agent ID, then checks `~/.openclaw/openclaw.json → agents.list` for a matching entry with a `heartbeat` property. Heartbeat enables automatic "waiting for input" notifications.

**Blocked?** The agent must add `"heartbeat": {"every": "5s", "target": "last"}` to its agent entry in `openclaw.json` and restart the Gateway.

### Guard 3 — HEARTBEAT.md

Checks that `<agentWorkspace>/HEARTBEAT.md` exists and contains real content (not just comments, blank lines, or whitespace). This file tells the agent what to do during heartbeat cycles.

**Blocked?** The agent must create `HEARTBEAT.md` with instructions for checking waiting Claude Code sessions.

### Guard 4 — Agent Channels Mapping

Calls `resolveAgentChannel(workdir)`. If it returns `undefined`, the session's workspace has no channel mapping and notifications would be undeliverable.

**Blocked?** The agent must add the workspace to `agentChannels` in `openclaw.json`:

```bash
jq '.plugins.entries["openclaw-claude-code-plugin"].config.agentChannels["/path/to/workspace"] = "telegram|my-agent|123456789"' \
  ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && \
  mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json
```

Then restart the Gateway (`openclaw gateway restart`).

---

## Channel Resolution Priority in `claude_launch`

When `claude_launch` determines the `originChannel` for a new session, it uses this priority chain:

```
1. ctx.messageChannel + ctx.agentAccountId  (injected by factory, 3-segment build)
2. resolveAgentChannel(ctx.workspaceDir)    (workspace-based lookup from factory context)
3. ctx.messageChannel as-is                 (if already pipe-delimited)
4. resolveAgentChannel(workdir)             (workdir from params, may differ from factory)
5. pluginConfig.fallbackChannel             (last resort, via resolveOriginChannel)
6. "unknown"                                (absolute fallback)
```

In practice, for most multi-agent setups, step 2 or 4 is what resolves — the `agentChannels` config does the heavy lifting.

---

## Multi-Agent Setup — Step by Step

This guide walks through setting up two agents (`seo-bot` and `dev-bot`) that each launch Claude Code sessions and receive notifications in separate Telegram chats.

### Prerequisites

- OpenClaw Gateway running
- `openclaw-claude-code-plugin` installed
- Two Telegram bot accounts configured in OpenClaw (`seo-bot`, `dev-bot`)
- Two Telegram chat IDs (one per agent)

### Step 1 — Create agent workspaces

```bash
mkdir -p /home/user/agent-seo
mkdir -p /home/user/agent-dev
```

### Step 2 — Configure `agentChannels` in `openclaw.json`

Edit `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code-plugin": {
        "enabled": true,
        "config": {
          "maxSessions": 5,
          "defaultBudgetUsd": 5,
          "agentChannels": {
            "/home/user/agent-seo": "telegram|seo-bot|1111111111",
            "/home/user/agent-dev": "telegram|dev-bot|2222222222"
          },
          "fallbackChannel": "telegram|seo-bot|1111111111"
        }
      }
    }
  }
}
```

### Step 3 — Configure heartbeat for each agent

In the same `openclaw.json`, ensure each agent has a heartbeat entry:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "seo-bot",
        "heartbeat": { "every": "5s", "target": "last" }
      },
      {
        "id": "dev-bot",
        "heartbeat": { "every": "5s", "target": "last" }
      }
    ]
  }
}
```

### Step 4 — Create autonomy skills

For each agent, create the autonomy skill directory and files:

```bash
# SEO agent
mkdir -p /home/user/agent-seo/skills/claude-code-autonomy
cat > /home/user/agent-seo/skills/claude-code-autonomy/SKILL.md << 'EOF'
# Claude Code Autonomy
Handle all Claude Code interactions automatically.
Respond to questions, approve edits, and notify user on completion.
EOF

# Dev agent
mkdir -p /home/user/agent-dev/skills/claude-code-autonomy
cat > /home/user/agent-dev/skills/claude-code-autonomy/SKILL.md << 'EOF'
# Claude Code Autonomy
Ask the user before approving architecture changes.
Auto-respond to routine questions. Notify on completion and errors.
EOF
```

### Step 5 — Create HEARTBEAT.md for each agent

```bash
cat > /home/user/agent-seo/HEARTBEAT.md << 'EOF'
# Heartbeat — SEO Agent

## Check Claude Code Sessions
1. Run `claude_sessions` to list active sessions
2. If any session is waiting for input → `claude_output(session)` to read the question
3. Respond or escalate to user
4. If no sessions are waiting → HEARTBEAT_OK
EOF

cat > /home/user/agent-dev/HEARTBEAT.md << 'EOF'
# Heartbeat — Dev Agent

## Check Claude Code Sessions
1. Run `claude_sessions` to list active sessions
2. If any session is waiting for input → `claude_output(session)` to read the question
3. Respond or escalate to user
4. If no sessions are waiting → HEARTBEAT_OK
EOF
```

### Step 6 — Restart the Gateway

```bash
openclaw gateway restart
```

### Step 7 — Test

From the SEO agent's Telegram chat, send a task. The agent calls:

```
claude_launch(prompt="Audit meta tags on example.com", name="meta-audit")
```

The plugin resolves `/home/user/agent-seo` → `telegram|seo-bot|1111111111` and routes all session notifications back to the SEO chat.

Meanwhile, from the Dev agent's chat:

```
claude_launch(prompt="Fix the auth middleware bug", name="fix-auth")
```

This resolves `/home/user/agent-dev` → `telegram|dev-bot|2222222222` — notifications go to the Dev chat.

Neither agent needs to specify a channel — `agentChannels` handles routing automatically.

---

## Examples

### Single agent with multiple projects

```json
{
  "agentChannels": {
    "/home/user/project-alpha": "telegram|my-bot|9999999999",
    "/home/user/project-beta":  "telegram|my-bot|9999999999"
  }
}
```

Both projects route to the same bot and chat. Useful when one agent manages multiple repos.

### Three agents, dedicated bots

```json
{
  "agentChannels": {
    "/home/user/agent-seo":      "telegram|seo-bot|1111111111",
    "/home/user/agent-backend":  "telegram|backend-bot|2222222222",
    "/home/user/agent-frontend": "telegram|frontend-bot|3333333333"
  }
}
```

Each agent has its own bot account and chat. Sessions launched from `/home/user/agent-backend/services/auth` resolve to `telegram|backend-bot|2222222222` via prefix matching.

### Catch-all with specific overrides

```json
{
  "agentChannels": {
    "/home/user":                "telegram|default-bot|1111111111",
    "/home/user/critical-app":   "telegram|ops-bot|4444444444"
  }
}
```

Any workspace under `/home/user` routes to `default-bot`, **except** `/home/user/critical-app` (and its subdirectories) which route to `ops-bot`. Longest-prefix matching ensures the override takes precedence.

### Two-segment values (no account binding)

```json
{
  "agentChannels": {
    "/home/user/solo-project": "telegram|9999999999"
  }
}
```

Uses the 2-segment format — the notification goes to chat `9999999999` via whichever Telegram bot is the default. `extractAgentId` returns `undefined` for this format, so heartbeat agent-ID lookup won't apply.
