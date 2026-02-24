# Safety & Pre-Launch Checks

When an agent calls the `claude_launch` tool, **4 mandatory guards** run before any session is spawned. If any check fails, the launch is blocked with a clear, actionable error message — and the agent either fixes it automatically or gives you a one-liner to run.

These checks are enforced only on the `claude_launch` **tool** (agent callers). The gateway RPC method (`claude-code.launch`) and chat command (`/claude`) skip them — those callers are assumed to be properly configured.

> **Source of truth:** `src/tools/claude-launch.ts` (lines 143-399)

### Skipping Safety Checks

Set `skipSafetyChecks: true` in the plugin config to bypass **all** pre-launch guards. When enabled, the plugin logs `[claude-launch] Safety checks skipped (skipSafetyChecks=true)` and proceeds directly to session launch.

```json
{
  "skipSafetyChecks": true
}
```

> **Warning:** This disables all safety guards — autonomy skill, heartbeat config, HEARTBEAT.md, and agentChannels mapping. Use only for development or testing environments where you understand the risks.

---

## Guard Summary

| # | Guard | What It Checks | Auto-Fixable? |
|---|-------|---------------|---------------|
| 1 | Autonomy Skill | `{workspace}/skills/claude-code-autonomy/SKILL.md` exists | Agent creates after asking user |
| 2 | Heartbeat Config | `heartbeat` field in `openclaw.json` for current agent | User runs `jq` command |
| 3 | HEARTBEAT.md Content | `HEARTBEAT.md` exists with non-empty content | Agent creates automatically |
| 4 | agentChannels Mapping | Workspace directory mapped in `agentChannels` config | User runs `jq` command |

---

## Guard 1: Autonomy Skill

### What It Checks

The plugin looks for `{agentWorkspace}/skills/claude-code-autonomy/SKILL.md`. This skill defines how the agent handles Claude Code interactions — when to auto-respond, when to ask the user, and how to format notifications.

### Why It Matters

Without autonomy rules, the agent doesn't know whether to auto-respond to Claude Code questions or escalate to the user. This could lead to sessions stalling indefinitely (if the agent never responds) or the agent making decisions the user wanted to approve (if it responds to everything blindly).

The skill also defines notification formats:
- `👋 [session-name]` — forwarding a question that needs the user's decision
- `🤖 [session-name] finished` — summarizing what a completed session did

### How to Fix

Let the agent ask you. When launch is blocked, the agent prompts you for your autonomy preferences in plain language:

- *"Auto-respond to everything except architecture decisions"*
- *"Always ask me before responding"*
- *"Handle everything yourself, just notify me when done"*

The agent then creates:
1. `skills/claude-code-autonomy/SKILL.md` — structured rules based on your answer
2. `skills/claude-code-autonomy/autonomy.md` — your raw preferences

**Do not** create the skill manually — let the agent ask you first so it captures your actual preferences.

---

## Guard 2: Heartbeat Configuration

### What It Checks

The plugin reads `~/.openclaw/openclaw.json` and verifies that the current agent has a `heartbeat` field configured in the `agents.list` array. The agent ID is resolved from context (`ctx.agentId`), falling back to `resolveAgentId()` which extracts it from the `agentChannels` mapping.

### Why It Matters

The heartbeat is a safety-net fallback for the wake system. The plugin's primary wake mechanism sends targeted agent messages instantly when a session needs attention. But if that message is lost (network issue, agent restart), the heartbeat ensures the agent eventually wakes up and checks for waiting sessions.

Without heartbeat configured, a session could be stuck in "waiting for input" with no mechanism to nudge the agent.

### How to Fix

Run the `jq` command the agent provides:

```bash
jq '.agents.list |= map(if .id == "YOUR_AGENT" then . + {"heartbeat": {"every": "60m", "target": "last"}} else . end)' \
  ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json
```

Then restart the gateway: `openclaw gateway restart`

**Recommended interval:** `60m`. Targeted agent messages provide instant wake-up, so the heartbeat is just a backup — short intervals waste tokens.

---

## Guard 3: HEARTBEAT.md Content

### What It Checks

The plugin verifies that `{agentWorkspace}/HEARTBEAT.md` exists and contains **real content** — not just whitespace, blank lines, or Markdown headings. The check uses the regex `/^(\s|#.*)*$/` to detect effectively empty files.

### Why It Matters

Even with heartbeat configured (Guard 2), the agent needs instructions on *what to do* during heartbeat cycles. The `HEARTBEAT.md` file tells the agent to check for waiting Claude Code sessions and handle them.

An empty or heading-only `HEARTBEAT.md` means the heartbeat fires but the agent has no instructions to check sessions — defeating the purpose of the safety net.

### How to Fix

The agent typically creates this file automatically. If it fails, create it manually with session-monitoring instructions:

```markdown
# Heartbeat

## Check Claude Code sessions (safety-net fallback)
Note: The plugin sends targeted wake messages instantly when sessions need attention.
This heartbeat is a 60m backup in case a wake message was lost.

If Claude Code sessions are waiting (waiting for input):
1. `claude_sessions` to list active sessions
2. If session waiting -> `claude_output(session)` to see the question
3. Handle or notify the user

Otherwise -> HEARTBEAT_OK
```

---

## Guard 4: agentChannels Mapping

### What It Checks

The plugin looks up the session's working directory in the `agentChannels` config (under `plugins.entries["openclaw-claude-code-plugin"].config.agentChannels` in `~/.openclaw/openclaw.json`). It uses **longest-prefix matching** with trailing-slash normalization — so a mapping for `/home/user/projects` covers `/home/user/projects/my-app`.

### Why It Matters

The `agentChannels` mapping tells the plugin which notification channel (agent + chat) to route session events to. Without a mapping:
- Completion notifications can't reach the right agent
- Wake messages have no destination
- `claude_sessions` can't filter sessions per agent

### How to Fix

Add the workspace mapping using the `jq` command the agent provides:

```bash
jq '.plugins.entries["openclaw-claude-code-plugin"].config.agentChannels["/path/to/workspace"] = "channel|accountId|chatId"' \
  ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json
```

Replace the values:
- `/path/to/workspace` — the agent's working directory
- `channel|accountId|chatId` — the notification target (e.g. `telegram|my-agent|123456789`)

Then restart the gateway: `openclaw gateway restart`

---

## First Launch Walkthrough

**You don't need to create anything manually.** Install the plugin and ask your agent to run a task. The guards walk you through setup:

1. **Install the plugin**
   ```bash
   openclaw plugins install @betrue/openclaw-claude-code-plugin
   openclaw gateway restart
   ```

2. **Ask your agent to launch a session** — e.g. *"Fix the bug in auth.ts"*

3. **Guards fire sequentially** — each blocked guard gives an actionable error:
   - Guard 1: Agent asks your autonomy preferences, creates the skill
   - Guard 2: Agent provides a `jq` command for heartbeat config
   - Guard 3: Agent creates `HEARTBEAT.md` automatically
   - Guard 4: Agent provides a `jq` command for channel mapping

4. **All checks pass** — session launches. Future launches skip setup entirely.

### What You Do (Once)

| Step | Action | Who |
|------|--------|-----|
| 1 | Answer the autonomy question | You tell the agent your preferences |
| 2 | Run the heartbeat config `jq` command | You paste the one-liner |
| 3 | Run the agentChannels `jq` command | You paste the one-liner |
| 4 | Restart the gateway | You run `openclaw gateway restart` |

### What Gets Created Automatically

| File | Created By | Purpose |
|------|-----------|---------|
| `skills/claude-code-autonomy/SKILL.md` | Agent (after asking you) | Autonomy rules for auto-respond vs escalate |
| `skills/claude-code-autonomy/autonomy.md` | Agent (after asking you) | Your raw autonomy preferences |
| `HEARTBEAT.md` | Agent (automatically) | Heartbeat checklist for monitoring sessions |

---

## Troubleshooting

### "Launch blocked — no autonomy skill found"
Let the agent ask you the autonomy question and create the skill. Don't create it manually.

### "Launch blocked — no heartbeat configured"
Run the `jq` command the agent provides, then restart the gateway.

### "Launch blocked — HEARTBEAT.md missing or empty"
Let the agent create it. If it already exists but is empty or contains only headings, add real content describing what to do during heartbeat cycles.

### "Launch blocked — no agentChannels mapping"
Add the workspace-to-channel mapping using the provided `jq` command, then restart the gateway.

### Gateway restart required
The agent will **never** restart the gateway itself — this is by design. When config changes require a restart, the agent asks you to run `openclaw gateway restart`. This prevents agents from disrupting other running agents or services.
