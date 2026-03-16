import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfig, SessionStatus, PermissionMode } from "./types";
import { pluginConfig } from "./shared";
import { nanoid } from "nanoid";

const OUTPUT_BUFFER_MAX = 200;

/**
 * AsyncIterable controller for multi-turn conversations.
 * Allows pushing SDKUserMessage objects into the query() prompt stream.
 */
class MessageStream {
  private queue: Array<{ type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; session_id: string }> = [];
  private resolve: (() => void) | null = null;
  private done: boolean = false;

  push(text: string, sessionId: string): void {
    const msg = {
      type: "user" as const,
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    this.queue.push(msg);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  end(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any, void, undefined> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
}

export class Session {
  readonly id: string;
  name: string;
  claudeSessionId?: string;

  // Config
  readonly prompt: string;
  readonly workdir: string;
  readonly model?: string;
  readonly maxBudgetUsd: number;
  private readonly systemPrompt?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode: PermissionMode;
  private readonly env?: Record<string, string>;

  // Resume/fork config (Task 16)
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;

  // Multi-turn config (Task 15)
  readonly multiTurn: boolean;
  private messageStream?: MessageStream;
  private queryHandle?: ReturnType<typeof query>;
  private idleTimer?: ReturnType<typeof setTimeout>;

  // Safety-net idle timer: fires only if NO messages (text, tool_use, result) arrive
  // for 15 seconds. The primary "waiting for input" signal is the multi-turn
  // end-of-turn result handler — this timer is a rare fallback for edge cases
  // (e.g. Claude stuck waiting for permission/clarification without a result event).
  private safetyNetTimer?: ReturnType<typeof setTimeout>;
  private static readonly SAFETY_NET_IDLE_MS = 15_000;

  // State
  status: SessionStatus = "starting";
  error?: string;
  startedAt: number;
  completedAt?: number;

  // SDK handles
  private abortController: AbortController;

  // Output
  outputBuffer: string[] = [];

  // Result
  result?: {
    subtype: string;
    duration_ms: number;
    total_cost_usd: number;
    num_turns: number;
    result?: string;
    is_error: boolean;
    session_id: string;
  };

  // Cost
  costUsd: number = 0;

  // Foreground
  foregroundChannels: Set<string> = new Set();

  // Per-channel output offset: tracks the outputBuffer index last seen while foregrounded.
  // Used by claude_fg to send "catchup" of missed output when re-foregrounding.
  private fgOutputOffsets: Map<string, number> = new Map();

  // Origin channel -- the channel that launched this session (for background notifications)
  originChannel?: string;

  // Origin agent ID -- the agent that launched this session (for targeted wake events)
  readonly originAgentId?: string;

  // Flags
  budgetExhausted: boolean = false;
  private waitingForInputFired: boolean = false;

  // Auto-respond safety cap: tracks consecutive agent-initiated responds
  autoRespondCount: number = 0;

  // Event callbacks
  onOutput?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: any) => void;
  onBudgetExhausted?: (session: Session) => void;
  onComplete?: (session: Session) => void;
  onWaitingForInput?: (session: Session) => void;

  constructor(config: SessionConfig, name: string) {
    this.id = nanoid(8);
    this.name = name;
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = config.model;
    this.maxBudgetUsd = config.maxBudgetUsd;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode ?? "bypassPermissions";
    this.env = config.env;
    this.originChannel = config.originChannel;
    this.originAgentId = config.originAgentId;
    this.resumeSessionId = config.resumeSessionId;
    this.forkSession = config.forkSession;
    this.multiTurn = config.multiTurn ?? true;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
  }

  async start(): Promise<void> {
    let q;
    try {
      // Build SDK options
      const options: any = {
        cwd: this.workdir,
        model: this.model,
        maxBudgetUsd: this.maxBudgetUsd,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: this.permissionMode === "bypassPermissions",
        allowedTools: this.allowedTools,
        includePartialMessages: true,
        abortController: this.abortController,
        ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),
        ...(this.env ? { env: this.env } : {}),
      };

      // Resume support (Task 16): pass resume + forkSession to SDK
      if (this.resumeSessionId) {
        options.resume = this.resumeSessionId;
        if (this.forkSession) {
          options.forkSession = true;
        }
      }

      // Determine prompt: multi-turn uses AsyncIterable, otherwise string
      let prompt: string | AsyncIterable<any>;
      if (this.multiTurn) {
        // Create a message stream for multi-turn conversations
        this.messageStream = new MessageStream();
        // Push the initial prompt as the first message
        // The session_id will be set once we receive the init message
        // For now use a placeholder — the SDK handles this
        this.messageStream.push(this.prompt, "");
        prompt = this.messageStream;
      } else {
        prompt = this.prompt;
      }

      q = query({
        prompt,
        options,
      });

      // Store the query handle for multi-turn control (interrupt, streamInput)
      this.queryHandle = q;
    } catch (err: any) {
      this.status = "failed";
      this.error = err?.message ?? String(err);
      this.completedAt = Date.now();
      return;
    }

    // Run the async iteration in background (non-blocking)
    this.consumeMessages(q).catch((err) => {
      if (this.status === "starting" || this.status === "running") {
        this.status = "failed";
        this.error = err?.message ?? String(err);
        this.completedAt = Date.now();
      }
    });
  }

  /**
   * Reset the safety-net idle timer. Called on EVERY incoming message
   * (text, tool_use, result). If no message of any kind arrives for
   * SAFETY_NET_IDLE_MS (15s), we assume the session is stuck waiting
   * for user input (e.g. a permission prompt without a result event).
   *
   * The primary "waiting for input" signal is the multi-turn end-of-turn
   * result handler — this timer is a rare fallback for edge cases only.
   */
  private resetSafetyNetTimer(): void {
    this.clearSafetyNetTimer();
    this.safetyNetTimer = setTimeout(() => {
      this.safetyNetTimer = undefined;
      if (this.status === "running" && this.onWaitingForInput && !this.waitingForInputFired) {
        console.log(`[Session] ${this.id} no messages for ${Session.SAFETY_NET_IDLE_MS / 1000}s — firing onWaitingForInput (safety-net)`);
        this.waitingForInputFired = true;
        this.onWaitingForInput(this);
      }
    }, Session.SAFETY_NET_IDLE_MS);
  }

  /**
   * Cancel the safety-net idle timer.
   */
  private clearSafetyNetTimer(): void {
    if (this.safetyNetTimer) {
      clearTimeout(this.safetyNetTimer);
      this.safetyNetTimer = undefined;
    }
  }

  /**
   * Reset (or start) the idle timer for multi-turn sessions.
   * If no sendMessage() call arrives within the configured idle timeout, the
   * session is automatically killed to avoid zombie sessions stuck in "running"
   * forever. Timeout is read from pluginConfig.idleTimeoutMinutes (default 30).
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 30) * 60 * 1000;
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") {
        console.log(`[Session] ${this.id} idle timeout reached (${pluginConfig.idleTimeoutMinutes ?? 30}min), auto-killing`);
        this.kill();
      }
    }, idleTimeoutMs);
  }

  /**
   * Send a follow-up message to a running multi-turn session.
   * Uses the SDK's streamInput() method to push a new user message.
   */
  async sendMessage(text: string): Promise<void> {
    if (this.status !== "running") {
      throw new Error(`Session is not running (status: ${this.status})`);
    }

    this.resetIdleTimer();
    this.waitingForInputFired = false;

    if (this.multiTurn && this.messageStream) {
      // Push into the AsyncIterable prompt stream
      this.messageStream.push(text, this.claudeSessionId ?? "");
    } else if (this.queryHandle && typeof (this.queryHandle as any).streamInput === "function") {
      // For non-multi-turn sessions, use streamInput() to inject messages
      const userMsg = {
        type: "user" as const,
        message: { role: "user" as const, content: text },
        parent_tool_use_id: null,
        session_id: this.claudeSessionId ?? "",
      };
      // Create a one-shot async iterable
      async function* oneMessage() { yield userMsg; }
      await (this.queryHandle as any).streamInput(oneMessage());
    } else {
      throw new Error("Session does not support multi-turn messaging. Launch with multiTurn: true or use the SDK streamInput.");
    }
  }

  /**
   * Interrupt the current turn (e.g. to send a new message mid-response).
   */
  async interrupt(): Promise<void> {
    if (this.queryHandle && typeof (this.queryHandle as any).interrupt === "function") {
      await (this.queryHandle as any).interrupt();
    }
  }

  private async consumeMessages(q: AsyncIterable<any>): Promise<void> {
    for await (const msg of q) {
      // Reset the safety-net timer on every incoming message.
      // This ensures it only fires when there is truly no activity for 15s.
      this.resetSafetyNetTimer();

      if (
        msg.type === "system" &&
        msg.subtype === "init"
      ) {
        this.claudeSessionId = msg.session_id;
        this.status = "running";
        this.resetIdleTimer();
      } else if (msg.type === "assistant") {
        this.waitingForInputFired = false;
        const contentBlocks = msg.message?.content ?? [];
        console.log(`[Session] ${this.id} assistant message received, blocks=${contentBlocks.length}, fgChannels=${JSON.stringify([...this.foregroundChannels])}`);
        for (const block of contentBlocks) {
          if (block.type === "text") {
            const text: string = block.text;
            this.outputBuffer.push(text);
            if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
              this.outputBuffer.splice(
                0,
                this.outputBuffer.length - OUTPUT_BUFFER_MAX
              );
            }
            if (this.onOutput) {
              console.log(`[Session] ${this.id} calling onOutput, textLen=${text.length}`);
              this.onOutput(text);
            } else {
              console.log(`[Session] ${this.id} onOutput callback NOT set`);
            }
          } else if (block.type === "tool_use") {
            // Emit tool_use event for compact foreground display
            if (this.onToolUse) {
              console.log(`[Session] ${this.id} calling onToolUse, tool=${block.name}`);
              this.onToolUse(block.name, block.input);
            } else {
              console.log(`[Session] ${this.id} onToolUse callback NOT set`);
            }
          }
        }
      } else if (msg.type === "result") {
        this.result = {
          subtype: msg.subtype,
          duration_ms: msg.duration_ms,
          total_cost_usd: msg.total_cost_usd,
          num_turns: msg.num_turns,
          result: msg.result,
          is_error: msg.is_error,
          session_id: msg.session_id,
        };
        this.costUsd = msg.total_cost_usd;

        // In multi-turn mode, a "success" result means end-of-turn, not end-of-session.
        // The session stays running so the user can send follow-up messages.
        // Only close on errors (budget exhaustion, actual failures, etc.).
        const isMultiTurnEndOfTurn = this.multiTurn && this.messageStream && msg.subtype === "success";

        if (isMultiTurnEndOfTurn) {
          // Keep session alive — just update cost and result, stay in "running" status
          console.log(`[Session] ${this.id} multi-turn end-of-turn (turn ${msg.num_turns}), staying open`);
          this.clearSafetyNetTimer();
          this.resetIdleTimer();

          // Notify that the session is now waiting for user input
          if (this.onWaitingForInput && !this.waitingForInputFired) {
            console.log(`[Session] ${this.id} calling onWaitingForInput`);
            this.waitingForInputFired = true;
            this.onWaitingForInput(this);
          }
        } else {
          // Session is truly done — either single-turn, or multi-turn with error/budget
          this.clearSafetyNetTimer();
          if (this.idleTimer) clearTimeout(this.idleTimer);
          this.status = msg.subtype === "success" ? "completed" : "failed";
          this.completedAt = Date.now();

          // End the message stream if multi-turn
          if (this.messageStream) {
            this.messageStream.end();
          }

          // Detect budget exhaustion
          if (msg.subtype === "error_max_budget_usd") {
            this.budgetExhausted = true;
            if (this.onBudgetExhausted) {
              this.onBudgetExhausted(this);
            }
          }

          if (this.onComplete) {
            console.log(`[Session] ${this.id} calling onComplete, status=${this.status}`);
            this.onComplete(this);
          } else {
            console.log(`[Session] ${this.id} onComplete callback NOT set`);
          }
        }
      }
    }
  }

  kill(): void {
    if (this.status !== "starting" && this.status !== "running") return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clearSafetyNetTimer();
    this.status = "killed";
    this.completedAt = Date.now();
    // End the message stream
    if (this.messageStream) {
      this.messageStream.end();
    }
    this.abortController.abort();
  }

  getOutput(lines?: number): string[] {
    if (lines === undefined) {
      return this.outputBuffer.slice();
    }
    return this.outputBuffer.slice(-lines);
  }

  /**
   * Get all output produced since this channel was last foregrounded (or since launch).
   * Returns the missed output lines. If this is the first time foregrounding,
   * returns the full buffer (same as getOutput()).
   */
  getCatchupOutput(channelId: string): string[] {
    const lastOffset = this.fgOutputOffsets.get(channelId) ?? 0;
    // The buffer is capped at OUTPUT_BUFFER_MAX. If output has been trimmed,
    // we can only return what's still in the buffer.
    const available = this.outputBuffer.length;
    if (lastOffset >= available) {
      return []; // Already caught up
    }
    return this.outputBuffer.slice(lastOffset);
  }

  /**
   * Record that this channel has seen all current output (call when foregrounding).
   * Sets the offset to the current end of the buffer.
   */
  markFgOutputSeen(channelId: string): void {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }

  /**
   * Save the current output position for a channel (call when backgrounding).
   * This records where they left off so catchup can resume from here.
   */
  saveFgOutputOffset(channelId: string): void {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }

  /**
   * Increment the auto-respond counter (called on each agent-initiated claude_respond tool call).
   */
  incrementAutoRespond(): void {
    this.autoRespondCount++;
  }

  /**
   * Reset the auto-respond counter (called when the user sends a message via /claude_respond command).
   */
  resetAutoRespond(): void {
    this.autoRespondCount = 0;
  }

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }
}
