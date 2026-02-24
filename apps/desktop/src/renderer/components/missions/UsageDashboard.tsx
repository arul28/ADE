import React, { useState, useEffect, useCallback } from "react";
import { Pulse, Cpu, CurrencyDollar, Clock, CheckCircle, XCircle, SpinnerGap } from "@phosphor-icons/react";
import type { AggregatedUsageStats } from "../../../shared/types";

const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "#1D4ED8",
  "claude-sonnet": "#3B82F6",
  "claude-haiku": "#60A5FA",
  "codex": "#22C55E",
  "codex-mini": "#4ADE80",
  "default": "#71717A"
};

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_COLORS["claude-opus"];
  if (lower.includes("sonnet")) return MODEL_COLORS["claude-sonnet"];
  if (lower.includes("haiku")) return MODEL_COLORS["claude-haiku"];
  if (lower.includes("codex") && lower.includes("mini")) return MODEL_COLORS["codex-mini"];
  if (lower.includes("codex")) return MODEL_COLORS["codex"];
  return MODEL_COLORS["default"];
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

type UsageDashboardProps = {
  missionId?: string | null;
  missionTitle?: string | null;
};

export function UsageDashboard({ missionId, missionTitle }: UsageDashboardProps) {
  const [stats, setStats] = useState<AggregatedUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const result = await window.ade.orchestrator.getAggregatedUsage({
        missionId: missionId ?? null
      });
      setStats(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 10_000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

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

  const maxTokens = Math.max(1, ...stats.byModel.map((m) => m.inputTokens + m.outputTokens));

  const scopeLabel = missionId
    ? `Usage for: ${missionTitle ?? "Selected Mission"}`
    : "Usage: All Missions";

  const isEmpty = stats.summary.totalSessions === 0 && (stats.summary.totalInputTokens + stats.summary.totalOutputTokens) === 0;

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {/* Scope indicator */}
      <div className="px-3 py-1.5" style={{ background: "#13101A", border: "1px solid #1E1B26", color: "#FAFAFA", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>
        {scopeLabel}
      </div>

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
        <SummaryCard icon={CurrencyDollar} label="Est. Cost" value={formatCost(stats.summary.totalCostEstimateUsd)} sub="estimated" />
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
                  style={s.provider === "codex"
                    ? { background: "#22C55E18", color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                    : { background: "#A78BFA18", color: "#A78BFA", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                  }
                >
                  {s.provider}
                </span>
                <span className="text-xs truncate" style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace" }}>{s.model}</span>
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
              return (
                <div key={`${m.provider}-${m.model}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="px-1.5 py-0.5"
                        style={m.provider === "codex"
                          ? { background: "#22C55E18", color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                          : { background: "#A78BFA18", color: "#A78BFA", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                        }
                      >
                        {m.provider}
                      </span>
                      <span style={{ color: "#A1A1AA", fontFamily: "JetBrains Mono, monospace" }}>{m.model}</span>
                    </div>
                    <div className="flex items-center gap-3" style={{ color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "10px" }}>
                      <span>{m.sessions} sessions</span>
                      <span>{formatTokens(total)} tokens</span>
                      <span>{formatCost(m.costEstimateUsd)}</span>
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
                  style={s.provider === "codex"
                    ? { background: "#22C55E18", color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                    : { background: "#A78BFA18", color: "#A78BFA", fontFamily: "JetBrains Mono, monospace", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }
                  }
                >
                  {s.provider}
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
    </div>
  );
}

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
