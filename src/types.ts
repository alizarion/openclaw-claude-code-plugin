// SDK types are imported from "@anthropic-ai/claude-agent-sdk"
// We define our own types for the plugin's internal state

/**
 * Context provided by OpenClaw's tool factory pattern.
 * When registerTool receives a factory function instead of a static tool object,
 * it calls the factory with this context, giving each tool access to the
 * calling agent's runtime information.
 */
export interface OpenClawPluginToolContext {
  config?: Record<string, any>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

export type SessionStatus = "starting" | "running" | "completed" | "failed" | "killed";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface SessionConfig {
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  maxBudgetUsd: number;
  foreground?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;  // Channel that spawned this session (for background notifications)
  permissionMode?: PermissionMode;

  // Resume/fork support (Task 16)
  resumeSessionId?: string;  // Claude session ID to resume
  forkSession?: boolean;     // Fork instead of continuing when resuming

  // Multi-turn support (Task 15)
  multiTurn?: boolean;  // If true, use AsyncIterable prompt for multi-turn conversations
}

export interface ClaudeSession {
  id: string;                    // nanoid(8)
  name: string;                  // human-readable kebab-case name
  claudeSessionId?: string;      // UUID from SDK init message

  // Configuration
  prompt: string;
  workdir: string;
  model?: string;
  maxBudgetUsd: number;

  // State
  status: SessionStatus;
  error?: string;

  // Timing
  startedAt: number;
  completedAt?: number;

  // Output
  outputBuffer: string[];        // Last N lines of assistant text

  // Result from SDK
  result?: {
    subtype: string;
    duration_ms: number;
    total_cost_usd: number;
    num_turns: number;
    result?: string;
    is_error: boolean;
    session_id: string;
  };

  // Cost tracking
  costUsd: number;

  // Foreground channels
  foregroundChannels: Set<string>;
}

export interface PluginConfig {
  maxSessions: number;
  defaultBudgetUsd: number;
  defaultModel?: string;
  defaultWorkdir?: string;
  idleTimeoutMinutes: number;
  maxPersistedSessions: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;

  /**
   * Map of agent working directories to notification channels.
   * When a tool call (e.g. claude_launch) cannot resolve the origin channel
   * from context, it checks whether the session workdir matches a key here
   * and uses the mapped channel for notifications.
   *
   * Example: { "/home/user/my-seo-agent": "telegram:123456789" }
   */
  agentChannels?: Record<string, string>;
}
