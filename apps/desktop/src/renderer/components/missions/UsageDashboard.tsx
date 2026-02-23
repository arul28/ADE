import React, { useState, useEffect, useCallback } from "react";
import { Pulse, Cpu, CurrencyDollar, Clock, CheckCircle, XCircle, SpinnerGap } from "@phosphor-icons/react";
import type { AggregatedUsageStats } from "../../../shared/types";
import { cn } from "../ui/cn";

const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "bg-blue-700",
  "claude-sonnet": "bg-blue-500",
  "claude-haiku": "bg-blue-400",
  "codex": "bg-emerald-500",
  "codex-mini": "bg-emerald-400",
  "default": "bg-zinc-500"
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

  const fetchUsage = useCallback(async () => {
    try {
      const result = await window.ade.orchestrator.getAggregatedUsage({
        missionId: missionId ?? null
      });
      setStats(result);
    } catch {
      // silently handle
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
      <div className="flex items-center justify-center h-48 text-zinc-500 text-xs">
        <SpinnerGap size={16} weight="regular" className="animate-spin mr-1.5" />
        Loading usage data...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500 text-xs">
        No usage data available
      </div>
    );
  }

  const maxTokens = Math.max(1, ...stats.byModel.map((m) => m.inputTokens + m.outputTokens));

  const scopeLabel = missionId
    ? `Usage for: ${missionTitle ?? "Selected Mission"}`
    : "Usage: All Missions";

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {/* Scope indicator */}
      <div className="rounded border border-border/20 bg-zinc-800/40 px-3 py-1.5 text-xs text-fg font-medium">
        {scopeLabel}
      </div>

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
          <h3 className="text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wide">Live Sessions</h3>
          <div className="flex flex-col gap-1">
            {stats.activeSessions.map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-zinc-800/60 border border-zinc-700/40">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", s.provider === "codex" ? "bg-emerald-500/20 text-emerald-300" : "bg-violet-500/20 text-violet-300")}>
                  {s.provider}
                </span>
                <span className="text-xs text-zinc-300 truncate">{s.model}</span>
                <span className="text-[10px] text-zinc-500 ml-auto">{s.feature}</span>
                <span className="text-[10px] text-zinc-400">{formatDuration(s.elapsedMs)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Model Breakdown */}
      {stats.byModel.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wide">By Model</h3>
          <div className="flex flex-col gap-1.5">
            {stats.byModel.map((m) => {
              const total = m.inputTokens + m.outputTokens;
              const pct = Math.max(2, (total / maxTokens) * 100);
              return (
                <div key={`${m.provider}-${m.model}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", m.provider === "codex" ? "bg-emerald-500/20 text-emerald-300" : "bg-violet-500/20 text-violet-300")}>
                        {m.provider}
                      </span>
                      <span className="text-zinc-300">{m.model}</span>
                    </div>
                    <div className="flex items-center gap-3 text-zinc-500 text-[10px]">
                      <span>{m.sessions} sessions</span>
                      <span>{formatTokens(total)} tokens</span>
                      <span>{formatCost(m.costEstimateUsd)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all", getModelColor(m.model))} style={{ width: `${pct}%` }} />
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
          <h3 className="text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wide">By Mission</h3>
          <div className="flex flex-col gap-0.5">
            {stats.missionBreakdown.map((m) => (
              <div key={m.missionId} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-zinc-800/40 text-[11px]">
                <span className="text-zinc-300 truncate max-w-[60%]">{m.missionTitle}</span>
                <div className="flex items-center gap-3 text-zinc-500 text-[10px]">
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
          <h3 className="text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wide">Recent Sessions</h3>
          <div className="flex flex-col gap-0.5">
            {stats.recentSessions.slice(0, 20).map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2.5 py-1 rounded bg-zinc-800/30 text-[11px]">
                {s.success ? (
                  <CheckCircle size={12} weight="regular" className="text-emerald-400 shrink-0" />
                ) : (
                  <XCircle size={12} weight="regular" className="text-red-400 shrink-0" />
                )}
                <span className={cn("px-1 py-0.5 rounded text-[9px] font-medium", s.provider === "codex" ? "bg-emerald-500/20 text-emerald-300" : "bg-violet-500/20 text-violet-300")}>
                  {s.provider}
                </span>
                <span className="text-zinc-400 truncate">{s.feature}</span>
                <span className="text-zinc-500 text-[10px] ml-auto">{formatTokens(s.inputTokens + s.outputTokens)}</span>
                <span className="text-zinc-600 text-[10px]">{formatDuration(s.durationMs)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700/30">
      <div className="flex items-center gap-1.5">
        <Icon size={12} weight="regular" className="text-zinc-500" />
        <span className="text-[11px] text-zinc-500 uppercase tracking-wide">{label}</span>
      </div>
      <span className="font-mono text-2xl font-semibold tracking-tight text-zinc-200">{value}</span>
      {sub && <span className="text-[11px] text-zinc-500">{sub}</span>}
    </div>
  );
}
