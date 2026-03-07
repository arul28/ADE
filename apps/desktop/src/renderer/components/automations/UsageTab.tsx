import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise as RefreshCw,
  Lightning,
  Moon,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { UsageSnapshot, BudgetCapConfig, UsageWindow } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { CARD_SHADOW_STYLE, extractError } from "./shared";
import { UsageMeter } from "./components/UsageMeter";
import { UsagePacingBadge } from "./components/UsagePacingBadge";
import { CostSummaryCard } from "./components/CostSummaryCard";
import { BudgetCapEditor } from "./components/BudgetCapEditor";

function formatResetTime(ms: number): string {
  if (ms <= 0) return "resets now";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function formatPolledAt(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function UsageTab() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.ade?.usage) { setError("Usage bridge unavailable."); return; }
    setLoading(true); setError(null);
    try {
      const [snap, cfg] = await Promise.all([
        window.ade.usage.getSnapshot(),
        window.ade.usage.getBudgetConfig(),
      ]);
      setSnapshot(snap); setBudgetConfig(cfg);
    } catch (err) {
      setError(extractError(err));
    } finally { setLoading(false); }
  }, []);

  const manualRefresh = useCallback(async () => {
    if (!window.ade?.usage) return;
    setLoading(true); setError(null);
    try {
      const snap = await window.ade.usage.refresh();
      setSnapshot(snap);
    } catch (err) {
      setError(extractError(err));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load().catch(() => {});
    if (!window.ade?.usage) return;
    const unsub = window.ade.usage.onUpdate((snap) => setSnapshot(snap));
    return () => { try { unsub(); } catch { /* ignore */ } };
  }, [load]);

  const claudeWindows = snapshot?.windows.filter((w) => w.provider === "claude") ?? [];
  const codexWindows = snapshot?.windows.filter((w) => w.provider === "codex") ?? [];
  const claudeCost = snapshot?.costs.find((c) => c.provider === "claude");
  const codexCost = snapshot?.costs.find((c) => c.provider === "codex");

  const nightShiftReserve = budgetConfig?.nightShiftReservePercent ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="h-full overflow-y-auto p-6"
      style={{ background: "#0F0D14" }}
    >
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div
              className="text-[16px] font-bold text-[#FAFAFA] tracking-[-0.4px]"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Usage Dashboard
            </div>
            <div className="mt-1 flex items-center gap-3">
              {snapshot?.pacing && (
                <UsagePacingBadge
                  status={snapshot.pacing.status}
                  projectedPercent={snapshot.pacing.projectedWeeklyPercent}
                />
              )}
              <span className="font-mono text-[9px] text-[#71717A]">
                Last polled: {formatPolledAt(snapshot?.lastPolledAt ?? null)}
              </span>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => void manualRefresh()} disabled={loading}>
            <RefreshCw size={12} weight="regular" className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {error && <div className="p-2 text-xs text-red-300" style={{ background: "rgba(239,68,68,0.08)" }}>{error}</div>}
        {snapshot?.errors.map((e, i) => (
          <div key={i} className="p-2 text-xs text-amber-300" style={{ background: "rgba(245,158,11,0.06)" }}>{e}</div>
        ))}

        {/* Provider cards */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ProviderUsageCard
            provider="Claude"
            windows={claudeWindows}
            icon={Lightning}
          />
          <ProviderUsageCard
            provider="Codex"
            windows={codexWindows}
            icon={Lightning}
          />
        </div>

        {/* Night Shift reserve */}
        {nightShiftReserve > 0 && (
          <div
            className="flex items-center gap-3 p-3"
            style={{ background: "#181423", border: "1px solid #2D2840" }}
          >
            <Moon size={16} weight="regular" className="text-[#A78BFA] shrink-0" />
            <div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
                Night Shift Reserve
              </div>
              <div className="font-mono text-[9px] text-[#71717A]">
                {nightShiftReserve}% reserved for Night Shift. Remaining for daytime: {100 - nightShiftReserve}%.
              </div>
            </div>
          </div>
        )}

        {/* Cost + Budget */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {claudeCost && (
            <CostSummaryCard
              provider="Claude"
              todayCostUsd={claudeCost.todayCostUsd}
              last30dCostUsd={claudeCost.last30dCostUsd}
              tokenBreakdown={claudeCost.tokenBreakdown}
            />
          )}
          {codexCost && (
            <CostSummaryCard
              provider="Codex"
              todayCostUsd={codexCost.todayCostUsd}
              last30dCostUsd={codexCost.last30dCostUsd}
              tokenBreakdown={codexCost.tokenBreakdown}
            />
          )}
          <BudgetCapEditor config={budgetConfig} />
        </div>

        {/* Empty state if no data at all */}
        {!snapshot && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Lightning size={48} weight="regular" className="text-[#2D2840] mb-4" />
            <div
              className="text-[14px] font-bold text-[#FAFAFA] tracking-[-0.3px]"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              No usage data yet
            </div>
            <div className="mt-2 font-mono text-[10px] text-[#71717A] max-w-[45ch]">
              Usage telemetry will appear here once providers are configured and automations start running.
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ── Per-provider usage card ── */

function ProviderUsageCard({
  provider,
  windows,
  icon: Icon,
}: {
  provider: string;
  windows: UsageWindow[];
  icon: React.ElementType;
}) {
  const fiveHour = windows.find((w) => w.windowType === "five_hour");
  const weekly = windows.find((w) => w.windowType === "weekly");

  if (!fiveHour && !weekly) {
    return (
      <div
        className="p-4"
        style={CARD_SHADOW_STYLE}
      >
        <div className="flex items-center gap-2 mb-3">
          <Icon size={14} weight="regular" className="text-[#A78BFA]" />
          <span
            className="text-[12px] font-bold text-[#FAFAFA] tracking-[-0.2px]"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            {provider}
          </span>
        </div>
        <div className="font-mono text-[10px] text-[#71717A]">No data available.</div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="p-4 space-y-4"
      style={CARD_SHADOW_STYLE}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} weight="regular" className="text-[#A78BFA]" />
        <span
          className="text-[12px] font-bold text-[#FAFAFA] tracking-[-0.2px]"
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          {provider}
        </span>
      </div>

      {fiveHour && (
        <UsageMeter
          label="5-Hour Window"
          percent={fiveHour.percentUsed}
          sublabel={formatResetTime(fiveHour.resetsInMs)}
        />
      )}

      {weekly && (
        <UsageMeter
          label="Weekly Window"
          percent={weekly.percentUsed}
          sublabel={formatResetTime(weekly.resetsInMs)}
          modelBreakdown={weekly.modelBreakdown}
        />
      )}
    </motion.div>
  );
}
