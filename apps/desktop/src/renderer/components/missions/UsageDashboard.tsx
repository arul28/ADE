import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Pulse, Cpu, CurrencyDollar, Clock, CheckCircle, XCircle, SpinnerGap, ArrowUp, Archive } from "@phosphor-icons/react";
import type { AggregatedUsageStats, MissionBudgetSnapshot } from "../../../shared/types";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";

const DEFAULT_MODEL_COLOR = "#71717A";

function getModelColor(model: string): string {
  const descriptor = getModelById(model) ?? resolveModelAlias(model);
  return descriptor?.color ?? DEFAULT_MODEL_COLOR;
}

function modelBadgeStyle(model: string): React.CSSProperties {
  const color = getModelColor(model);
  return {
    background: `${color}18`,
    color,
    fontFamily: "JetBrains Mono, monospace",
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "1px",
  };
}

function getModelDisplayName(model: string, provider?: string): string {
  const desc = getModelById(model) ?? resolveModelAlias(model);
  return desc?.displayName ?? provider ?? model;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatBudgetMs(ms: number | null | undefined): string {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return "n/a";
  const minutes = Math.max(1, Math.round(Number(ms) / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function budgetPercent(used: number, limit: number | null | undefined): number | null {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  const raw = (used / Number(limit)) * 100;
  return Math.max(0, Math.min(100, raw));
}

type UsageDashboardProps = {
  missionId?: string | null;
  missionTitle?: string | null;
};

type CandidateMemory = {
  id: string;
  content: string;
  category: string;
  confidence: number;
  createdAt: string;
};

type TimeRange = "5h" | "24h" | "7d" | "30d" | "all";
const TIME_RANGE_OPTIONS: { value: TimeRange; label: string; ms: number | null }[] = [
  { value: "5h", label: "5 Hours", ms: 5 * 60 * 60 * 1000 },
  { value: "24h", label: "24 Hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 Days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30 Days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All Time", ms: null },
];

export const UsageDashboard = React.memo(function UsageDashboard({ missionId, missionTitle }: UsageDashboardProps) {
  const [stats, setStats] = useState<AggregatedUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateMemory[]>([]);
  const [budget, setBudget] = useState<MissionBudgetSnapshot | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [detectedAuth, setDetectedAuth] = useState<import("../../../shared/types").AiDetectedAuth[]>([]);

  const maxTokens = useMemo(
    () => stats ? Math.max(1, ...stats.byModel.map((m) => m.inputTokens + m.outputTokens)) : 0,
    [stats]
  );

  const isSubscriptionModel = useCallback((model: string, provider: string) => {
    const desc = getModelById(model) ?? resolveModelAlias(model);
    const family = desc?.family ?? provider;
    return detectedAuth.some((a) =>
      a.type === "cli-subscription" && a.authenticated &&
      a.cli && ({ claude: "anthropic", codex: "openai", gemini: "google" } as Record<string, string>)[a.cli] === family
    );
  }, [detectedAuth]);

  const isSubscriptionProvider = useCallback((provider: string) => {
    return detectedAuth.some((a) =>
      a.type === "cli-subscription" && a.authenticated &&
      a.cli && ({ claude: "anthropic", codex: "openai", gemini: "google" } as Record<string, string>)[a.cli] === provider
    );
  }, [detectedAuth]);

  const hasAnySub = useMemo(() => detectedAuth.some((a) => a.type === "cli-subscription" && a.authenticated), [detectedAuth]);

  const byProvider = useMemo(() => {
    if (!stats) return [];
    const map = new Map<string, { provider: string; sessions: number; inputTokens: number; outputTokens: number; costEstimateUsd: number }>();
    for (const m of stats.byModel) {
      const family = (getModelById(m.model) ?? resolveModelAlias(m.model))?.family ?? m.provider;
      const existing = map.get(family);
      if (existing) {
        existing.sessions += m.sessions;
        existing.inputTokens += m.inputTokens;
        existing.outputTokens += m.outputTokens;
        existing.costEstimateUsd += m.costEstimateUsd;
      } else {
        map.set(family, {
          provider: family,
          sessions: m.sessions,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          costEstimateUsd: m.costEstimateUsd,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  }, [stats]);

  const fetchUsage = useCallback(async () => {
    try {
      const rangeOpt = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange);
      const since = rangeOpt?.ms ? new Date(Date.now() - rangeOpt.ms).toISOString() : null;
      const result = await window.ade.orchestrator.getAggregatedUsage({
        missionId: missionId ?? null,
        since,
      });
      setStats(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [missionId, timeRange]);

  const fetchMissionBudget = useCallback(async () => {
    if (!missionId) {
      setBudget(null);
      return;
    }
    try {
      const snapshot = await window.ade.orchestrator.getMissionBudgetStatus({ missionId });
      setBudget(snapshot);
    } catch {
      setBudget(null);
    }
  }, [missionId]);

  const fetchMemoryData = useCallback(async () => {
    try {
      if (window.ade.memory) {
        const rawCandidates = await window.ade.memory.getCandidates({ limit: 10 });
        setCandidates(rawCandidates as CandidateMemory[]);
      }
    } catch {
      // Memory data is best-effort
    }
  }, []);

  const handlePromote = useCallback(async (id: string) => {
    try {
      if (window.ade.memory) {
        await window.ade.memory.promote({ id });
        setCandidates((prev) => prev.filter((c) => c.id !== id));
      }
    } catch {
      // best-effort
    }
  }, []);

  const handleDismiss = useCallback(async (id: string) => {
    try {
      if (window.ade.memory) {
        await window.ade.memory.archive({ id });
        setCandidates((prev) => prev.filter((c) => c.id !== id));
      }
    } catch {
      // best-effort
    }
  }, []);

  // Pause polling when tab/window is not visible
  const visibleRef = useRef(true);
  useEffect(() => {
    const onVisChange = () => { visibleRef.current = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

  useEffect(() => {
    fetchUsage();
    fetchMissionBudget();
    fetchMemoryData();
    window.ade.ai.getStatus().then((s) => setDetectedAuth(s.detectedAuth ?? [])).catch(() => {});
    const interval = setInterval(() => {
      if (!visibleRef.current) return; // skip poll when backgrounded
      fetchUsage();
      fetchMissionBudget();
      fetchMemoryData();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchUsage, fetchMissionBudget, fetchMemoryData]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
        <SpinnerGap size={16} weight="regular" className="animate-spin mr-1.5" style={{ color: "#71717A" }} />
        Loading usage data...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
        No usage data available
      </div>
    );
  }

  const scopeLabel = missionId
    ? `Usage for: ${missionTitle ?? "Selected Mission"}`
    : "Usage: All Missions";

  const isEmpty = stats.summary.totalSessions === 0 && (stats.summary.totalInputTokens + stats.summary.totalOutputTokens) === 0;

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {/* Scope indicator + time range filter */}
      <div className="flex items-center justify-between px-3 py-1.5" style={{ background: "#13101A", border: "1px solid #1E1B26" }}>
        <span style={{ color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>
          {scopeLabel}
        </span>
        <div className="flex items-center gap-1">
          {TIME_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTimeRange(opt.value)}
              style={{
                padding: "2px 8px",
                background: timeRange === opt.value ? "#A78BFA18" : "transparent",
                border: timeRange === opt.value ? "1px solid #A78BFA30" : "1px solid transparent",
                color: timeRange === opt.value ? "#A78BFA" : "#71717A",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: "9px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                cursor: "pointer",
                borderRadius: 0,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {budget ? (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>
            Mission Budget
          </h3>
          <div className="flex flex-col gap-2" style={{ background: "#13101A", border: "1px solid #1E1B26", padding: "10px" }}>
            <div className="flex flex-wrap items-center gap-3" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
              <span>Mode: {budget.mode}</span>
              <span>Pressure: {budget.pressure}</span>
              <span>Active workers: {budget.activeWorkers}</span>
              <span>Tokens: {formatTokens(budget.mission.usedTokens)} / {budget.mission.maxTokens != null ? formatTokens(budget.mission.maxTokens) : "n/a"}</span>
              <span>Cost: {formatCost(budget.mission.usedCostUsd)} / {budget.mission.maxCostUsd != null ? formatCost(budget.mission.maxCostUsd) : "n/a"}</span>
              <span>Time: {formatBudgetMs(budget.mission.usedTimeMs)} / {formatBudgetMs(budget.mission.maxTimeMs ?? null)}</span>
            </div>
            <div style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
              {budget.recommendation}
            </div>
            <div className="grid grid-cols-1 gap-1">
              {[
                { key: "tokens", label: "Token Budget", used: budget.mission.usedTokens, limit: budget.mission.maxTokens, display: `${formatTokens(budget.mission.usedTokens)} / ${budget.mission.maxTokens != null ? formatTokens(budget.mission.maxTokens) : "n/a"}` },
                { key: "cost", label: "Cost Budget", used: budget.mission.usedCostUsd, limit: budget.mission.maxCostUsd ?? null, display: `${formatCost(budget.mission.usedCostUsd)} / ${budget.mission.maxCostUsd != null ? formatCost(budget.mission.maxCostUsd) : "n/a"}` },
                { key: "time", label: "Time Budget", used: budget.mission.usedTimeMs, limit: budget.mission.maxTimeMs ?? null, display: `${formatBudgetMs(budget.mission.usedTimeMs)} / ${formatBudgetMs(budget.mission.maxTimeMs ?? null)}` },
              ].map((entry) => {
                const pct = budgetPercent(Number(entry.used), Number(entry.limit));
                return (
                  <div key={entry.key} className="space-y-0.5">
                    <div className="flex items-center justify-between" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
                      <span>{entry.label}</span>
                      <span>{entry.display}</span>
                    </div>
                    <div style={{ height: 6, background: "#0F0D14", border: "1px solid #1E1B26" }}>
                      <div
                        style={{
                          width: `${pct ?? 0}%`,
                          height: "100%",
                          background: pct == null ? "#27232F" : pct >= 85 ? "#EF4444" : pct >= 60 ? "#F59E0B" : "#22C55E"
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
              <span>Rate Limits:</span>
              {budget.rateLimits.length === 0 ? (
                <span style={{ color: "#71717A" }}>none reported</span>
              ) : (
                budget.rateLimits.map((limit) => (
                  <span key={`${limit.provider}:${limit.source}`}>
                    {limit.provider} {limit.remainingTokens != null ? `${formatTokens(limit.remainingTokens)} remaining` : "remaining n/a"} {limit.resetAt ? `(reset ${new Date(limit.resetAt).toLocaleTimeString()})` : ""}
                  </span>
                ))
              )}
            </div>
            {budget.perPhase.length > 0 ? (
              <div className="flex flex-col gap-1">
                <div style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
                  By Phase
                </div>
                {budget.perPhase.slice(0, 8).map((phase) => (
                  <div
                    key={phase.phaseKey}
                    className="flex items-center justify-between px-2 py-1"
                    style={{ background: "#0F0D14", border: "1px solid #1E1B26", color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}
                  >
                    <span>{phase.phaseName}</span>
                    <span>{formatTokens(phase.usedTokens)} tok</span>
                    <span>{formatCost(phase.usedCostUsd)}</span>
                    <span>{phase.stepCount} steps</span>
                  </div>
                ))}
              </div>
            ) : null}
            {budget.perWorker.length > 0 ? (
              <div className="flex flex-col gap-1">
                <div style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
                  Top Workers
                </div>
                {budget.perWorker.slice(0, 5).map((worker) => (
                  <div
                    key={worker.stepId}
                    className="flex items-center justify-between px-2 py-1"
                    style={{ background: "#0F0D14", border: "1px solid #1E1B26", color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}
                  >
                    <span className="truncate max-w-[45%]">{worker.title}</span>
                    <span>{formatTokens(worker.usedTokens)} tok</span>
                    <span>{formatCost(worker.usedCostUsd)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 text-xs" style={{ background: "#EF444418", border: "1px solid #EF444430", color: "#EF4444", fontFamily: "JetBrains Mono, monospace" }}>
          Failed to load usage data: {error}
        </div>
      )}

      {/* Empty state */}
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 500, color: "#71717A" }}>No usage data yet</span>
          <span className="leading-relaxed max-w-xs" style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}>
            Usage metrics will appear here once AI agents begin processing steps.
            This includes token counts, costs, compute time, and model breakdowns.
          </span>
        </div>
      ) : (
      <>
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-2">
        <SummaryCard icon={Pulse} label="Sessions" value={String(stats.summary.totalSessions)} sub={stats.summary.activeSessions > 0 ? `${stats.summary.activeSessions} active` : undefined} />
        <SummaryCard icon={Cpu} label="Tokens" value={formatTokens(stats.summary.totalInputTokens + stats.summary.totalOutputTokens)} sub={`${formatTokens(stats.summary.totalInputTokens)} in / ${formatTokens(stats.summary.totalOutputTokens)} out`} />
        <SummaryCard icon={CurrencyDollar} label={hasAnySub ? "Est. API Cost" : "Est. Cost"} value={formatCost(stats.summary.totalCostEstimateUsd)} sub={hasAnySub ? "subscription usage tracked by tokens" : "estimated"} />
        <SummaryCard icon={Clock} label="Compute" value={formatDuration(stats.summary.totalDurationMs)} />
      </div>

      {/* Active Sessions */}
      {stats.activeSessions.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Live Sessions</h3>
          <div className="flex flex-col gap-1">
            {stats.activeSessions.map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: "#13101A", border: "1px solid #1E1B26" }}>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full" style={{ borderRadius: "9999px", backgroundColor: "#22C55E", opacity: 0.75 }} />
                  <span className="relative inline-flex h-2 w-2" style={{ borderRadius: "9999px", backgroundColor: "#22C55E" }} />
                </span>
                <span
                  className="px-1.5 py-0.5"
                  style={modelBadgeStyle(s.model)}
                >
                  {getModelDisplayName(s.model, s.provider)}
                </span>
                <span className="ml-auto" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{s.feature}</span>
                <span style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{formatDuration(s.elapsedMs)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Model Breakdown */}
      {stats.byModel.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>By Model</h3>
          <div className="flex flex-col gap-1.5">
            {stats.byModel.map((m) => {
              const total = m.inputTokens + m.outputTokens;
              const pct = Math.max(2, (total / maxTokens) * 100);
              const isSub = isSubscriptionModel(m.model, m.provider);
              return (
                <div key={`${m.provider}-${m.model}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="px-1.5 py-0.5"
                        style={modelBadgeStyle(m.model)}
                      >
                        {getModelDisplayName(m.model, m.provider)}
                      </span>
                      {isSub ? (
                        <span className="px-1 py-0.5" style={{ background: "#22C55E18", color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>SUB</span>
                      ) : (
                        <span className="px-1 py-0.5" style={{ background: "#F59E0B18", color: "#F59E0B", fontFamily: "JetBrains Mono, monospace", fontSize: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>API</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
                      <span>{m.sessions} sessions</span>
                      <span>{formatTokens(total)} tokens</span>
                      {!isSub && <span>{formatCost(m.costEstimateUsd)}</span>}
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden" style={{ background: "#1E1B26", borderRadius: 0 }}>
                    <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: getModelColor(m.model), borderRadius: 0 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Provider Breakdown */}
      {byProvider.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>By Provider</h3>
          <div className="flex flex-col gap-1">
            {byProvider.map((p) => {
              const total = p.inputTokens + p.outputTokens;
              const maxProviderTokens = Math.max(1, ...byProvider.map((x) => x.inputTokens + x.outputTokens));
              const pct = Math.max(2, (total / maxProviderTokens) * 100);
              const provIsSub = isSubscriptionProvider(p.provider);
              return (
                <div key={p.provider} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5" style={{ background: "#71717A18", color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
                        {p.provider}
                      </span>
                      {provIsSub ? (
                        <span className="px-1 py-0.5" style={{ background: "#22C55E18", color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>SUB</span>
                      ) : (
                        <span className="px-1 py-0.5" style={{ background: "#F59E0B18", color: "#F59E0B", fontFamily: "JetBrains Mono, monospace", fontSize: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>API</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
                      <span>{p.sessions} sessions</span>
                      <span>{formatTokens(total)} tokens</span>
                      {!provIsSub && <span>{formatCost(p.costEstimateUsd)}</span>}
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden" style={{ background: "#1E1B26", borderRadius: 0 }}>
                    <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: "#71717A", borderRadius: 0 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Mission Breakdown (hidden when scoped to a single mission) */}
      {!missionId && stats.missionBreakdown.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>By Mission</h3>
          <div className="flex flex-col gap-0.5">
            {stats.missionBreakdown.map((m) => (
              <div key={m.missionId} className="flex items-center justify-between px-2.5 py-1.5 text-[11px]" style={{ background: "#13101A", border: "1px solid #1E1B26" }}>
                <span className="truncate max-w-[60%]" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace" }}>{m.missionTitle}</span>
                <div className="flex items-center gap-3" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
                  <span>{formatTokens(m.totalTokens)}</span>
                  <span>{formatCost(m.costEstimateUsd)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Sessions */}
      {stats.recentSessions.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Recent Sessions</h3>
          <div className="flex flex-col gap-0.5">
            {stats.recentSessions.slice(0, 20).map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2.5 py-1 text-[11px]" style={{ background: "#13101A", border: "1px solid #1E1B26" }}>
                {s.success ? (
                  <CheckCircle size={12} weight="regular" className="shrink-0" style={{ color: "#22C55E" }} />
                ) : (
                  <XCircle size={12} weight="regular" className="shrink-0" style={{ color: "#EF4444" }} />
                )}
                <span
                  className="px-1 py-0.5"
                  style={modelBadgeStyle(s.model)}
                >
                  {getModelDisplayName(s.model, s.provider)}
                </span>
                <span className="truncate" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace" }}>{s.feature}</span>
                <span className="ml-auto" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{formatTokens(s.inputTokens + s.outputTokens)}</span>
                <span style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{formatDuration(s.durationMs)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      </>
      )}

      {/* Candidate Memories */}
      {candidates.length > 0 && (
        <section>
          <h3 style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>
            Candidate Memories ({candidates.length})
          </h3>
          <div className="flex flex-col gap-0.5">
            {candidates.map((c) => (
              <div key={c.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]" style={{ background: "#13101A", border: "1px solid #1E1B26" }}>
                <span className="shrink-0 px-1 py-0.5" style={{ background: "#F59E0B18", color: "#F59E0B", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
                  {c.category}
                </span>
                <span className="flex-1 truncate" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace" }}>{c.content}</span>
                <span style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", whiteSpace: "nowrap" }}>
                  {(c.confidence * 100).toFixed(0)}%
                </span>
                <button
                  onClick={() => handlePromote(c.id)}
                  className="shrink-0 p-0.5 hover:opacity-80"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#22C55E" }}
                  title="Promote to permanent memory"
                >
                  <ArrowUp size={12} weight="bold" />
                </button>
                <button
                  onClick={() => handleDismiss(c.id)}
                  className="shrink-0 p-0.5 hover:opacity-80"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#71717A" }}
                  title="Dismiss"
                >
                  <Archive size={12} weight="regular" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
});

function SummaryCard({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5" style={{ background: "#13101A", border: "1px solid #1E1B26", padding: "16px" }}>
      <div className="flex items-center gap-1.5">
        <Icon size={12} weight="regular" style={{ color: "#71717A" }} />
        <span style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>{label}</span>
      </div>
      <span style={{ color: "#FAFAFA", fontFamily: "'Space Grotesk', sans-serif", fontSize: "28px", fontWeight: 700 }}>{value}</span>
      {sub && <span style={{ color: "#52525B", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>{sub}</span>}
    </div>
  );
}

