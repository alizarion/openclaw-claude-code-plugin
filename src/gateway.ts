import { sessionManager, pluginConfig, formatSessionListing, formatDuration, formatStats, resolveOriginChannel } from "./shared";

/**
 * Task 17 — Gateway RPC methods
 *
 * Registers RPC methods so external clients (dashboard, API, other plugins)
 * can control Claude Code Plugin sessions programmatically.
 *
 * Methods:
 *   claude-code.sessions — list sessions (optionally filtered by status)
 *   claude-code.launch   — launch a new session
 *   claude-code.kill     — kill a running session
 *   claude-code.output   — get output from a session
 *   claude-code.stats    — return aggregated metrics
 */
export function registerGatewayMethods(api: any): void {

  // ── claude-code.sessions ────────────────────────────────────────
  api.registerGatewayMethod("claude-code.sessions", ({ respond, params }: any) => {
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const filter = params?.status ?? "all";
    const sessions = sessionManager.list(filter);

    const result = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      prompt: s.prompt,
      workdir: s.workdir,
      model: s.model,
      costUsd: s.costUsd,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationMs: s.duration,
      claudeSessionId: s.claudeSessionId,
      foreground: s.foregroundChannels.size > 0,
      multiTurn: s.multiTurn,
      // Also include human-readable listing
      display: formatSessionListing(s),
    }));

    respond(true, { sessions: result, count: result.length });
  });

  // ── claude-code.launch ──────────────────────────────────────────
  api.registerGatewayMethod("claude-code.launch", ({ respond, params }: any) => {
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    if (!params?.prompt) {
      return respond(false, { error: "Missing required parameter: prompt" });
    }

    try {
      const session = sessionManager.spawn({
        prompt: params.prompt,
        name: params.name,
        workdir: params.workdir || pluginConfig.defaultWorkdir || process.cwd(),
        model: params.model || pluginConfig.defaultModel,
        maxBudgetUsd: params.maxBudgetUsd ?? params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5,
        systemPrompt: params.systemPrompt ?? params.system_prompt,
        allowedTools: params.allowedTools ?? params.allowed_tools,
        resumeSessionId: params.resumeSessionId ?? params.resume_session_id,
        forkSession: params.forkSession ?? params.fork_session,
        multiTurn: !(params.multiTurnDisabled ?? params.multi_turn_disabled),
        originChannel: params.originChannel ?? "gateway",
      });

      respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        workdir: session.workdir,
        model: session.model,
      });
    } catch (err: any) {
      respond(false, { error: err.message });
    }
  });

  // ── claude-code.kill ────────────────────────────────────────────
  api.registerGatewayMethod("claude-code.kill", ({ respond, params }: any) => {
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }

    const session = sessionManager.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }

    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        message: `Session already ${session.status}`,
      });
    }

    sessionManager.kill(session.id);

    respond(true, {
      id: session.id,
      name: session.name,
      status: "killed",
      message: `Session ${session.name} [${session.id}] terminated`,
    });
  });

  // ── claude-code.output ──────────────────────────────────────────
  api.registerGatewayMethod("claude-code.output", ({ respond, params }: any) => {
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }

    const session = sessionManager.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }

    const lines = params?.full
      ? session.getOutput()
      : session.getOutput(params?.lines ?? 50);

    respond(true, {
      id: session.id,
      name: session.name,
      status: session.status,
      costUsd: session.costUsd,
      durationMs: session.duration,
      duration: formatDuration(session.duration),
      lines,
      lineCount: lines.length,
      result: session.result ?? null,
    });
  });

  // ── claude-code.stats ───────────────────────────────────────────
  api.registerGatewayMethod("claude-code.stats", ({ respond, params }: any) => {
    if (!sessionManager) {
      return respond(false, { error: "SessionManager not initialized" });
    }

    const metrics = sessionManager.getMetrics();

    // Build a serializable version (Map → Object)
    const costPerDay: Record<string, number> = {};
    for (const [key, val] of metrics.costPerDay) {
      costPerDay[key] = val;
    }

    const running = sessionManager.list("running").length;

    respond(true, {
      totalCostUsd: metrics.totalCostUsd,
      costPerDay,
      sessionsByStatus: {
        ...metrics.sessionsByStatus,
        running,
      },
      totalLaunched: metrics.totalLaunched,
      averageDurationMs: metrics.sessionsWithDuration > 0
        ? metrics.totalDurationMs / metrics.sessionsWithDuration
        : 0,
      mostExpensive: metrics.mostExpensive,
      // Human-readable version too
      display: formatStats(metrics),
    });
  });
}
