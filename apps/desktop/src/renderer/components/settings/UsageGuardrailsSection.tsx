import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise as RefreshCw, Lightning, Moon } from "@phosphor-icons/react";
import type { AiDetectedAuth, BudgetCapConfig, ExtraUsage, UsageSnapshot, UsageWindow } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { BudgetCapEditor } from "../automations/components/BudgetCapEditor";
import { CostSummaryCard } from "../automations/components/CostSummaryCard";
import { UsageMeter } from "../automations/components/UsageMeter";
import { UsagePacingBadge } from "../automations/components/UsagePacingBadge";
import { CARD_SHADOW_STYLE, extractError } from "../automations/shared";

function computeResetsInMs(resetsAt: string, nowMs: number): number {
  if (!resetsAt) return 0;
  return Math.max(0, new Date(resetsAt).getTime() - nowMs);
}

function formatResetTime(ms: number): string {
  if (ms <= 0) return "resets now";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function displayPercent(window: UsageWindow, mode: "used" | "remaining", nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  const effectiveUsed = resetsInMs <= 0 ? 0 : window.percentUsed;
  return mode === "remaining" ? 100 - effectiveUsed : effectiveUsed;
}

function formatPolledAt(iso: string | null): string {
  if (!iso) return "--";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "--";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function UsageGuardrailsSection({
  showApiCost = false,
}: {
  showApiCost?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [detectedAuth, setDetectedAuth] = useState<AiDetectedAuth[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!window.ade?.usage) {
      setError("Usage bridge unavailable.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextSnapshot, nextBudgetConfig] = await Promise.all([
        window.ade.usage.refresh(),
        window.ade.usage.getBudgetConfig(),
      ]);
      setSnapshot(nextSnapshot);
      setBudgetConfig(nextBudgetConfig);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const manualRefresh = useCallback(async () => {
    if (!window.ade?.usage) return;
    setLoading(true);
    setError(null);
    try {
      const nextSnapshot = await window.ade.usage.refresh();
      setSnapshot(nextSnapshot);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const saveBudgetConfig = useCallback(async (nextConfig: BudgetCapConfig) => {
    if (!window.ade?.usage?.saveBudgetConfig) {
      setBudgetError("Budget save bridge unavailable.");
      return;
    }
    setBudgetSaving(true);
    setBudgetError(null);
    try {
      const saved = await window.ade.usage.saveBudgetConfig(nextConfig);
      setBudgetConfig(saved);
    } catch (err) {
      setBudgetError(extractError(err));
    } finally {
      setBudgetSaving(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!window.ade?.usage) return;
    const unsubscribe = window.ade.usage.onUpdate((nextSnapshot) => setSnapshot(nextSnapshot));
    return () => {
      try {
        unsubscribe();
      } catch {
        // noop
      }
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    window.ade.ai.getStatus()
      .then((status) => {
        if (!cancelled) setDetectedAuth(status.detectedAuth ?? []);
      })
      .catch(() => {
        if (!cancelled) setDetectedAuth([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const claudeWindows = snapshot?.windows.filter((window) => window.provider === "claude") ?? [];
  const codexWindows = snapshot?.windows.filter((window) => window.provider === "codex") ?? [];
  const claudeCost = snapshot?.costs.find((cost) => cost.provider === "claude");
  const codexCost = snapshot?.costs.find((cost) => cost.provider === "codex");
  const nightShiftReserve = budgetConfig?.nightShiftReservePercent ?? 0;
  const cliAuth = useMemo(
    () => ({
      claude: detectedAuth.find((entry) => entry.type === "cli-subscription" && entry.cli === "claude") ?? null,
      codex: detectedAuth.find((entry) => entry.type === "cli-subscription" && entry.cli === "codex") ?? null,
    }),
    [detectedAuth]
  );
  const showEmptyQuotaWarning =
    (cliAuth.claude?.authenticated || cliAuth.codex?.authenticated) &&
    claudeWindows.length === 0 &&
    codexWindows.length === 0 &&
    (snapshot?.errors.length ?? 0) === 0;

  return (
    <section
      className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4"
      style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.18)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg">Provider limits & automation guardrails</div>
          <div className="mt-0.5 text-xs text-muted-fg">
            Live Claude/Codex quota polling plus the budget rules that govern automations and Night Shift.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {snapshot?.pacing ? (
              <UsagePacingBadge
                status={snapshot.pacing.status}
                projectedPercent={snapshot.pacing.projectedWeeklyPercent}
                pacing={snapshot.pacing}
              />
            ) : null}
            <span className="font-mono text-[10px] text-muted-fg">
              Last polled: {formatPolledAt(snapshot?.lastPolledAt ?? null)}
            </span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void manualRefresh()} disabled={loading}>
          <RefreshCw size={12} weight="regular" className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <AuthChip label="Claude" entry={cliAuth.claude} />
        <AuthChip label="Codex" entry={cliAuth.codex} />
      </div>

      {error ? (
        <div className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{error}</div>
      ) : null}

      {showEmptyQuotaWarning ? (
        <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">
          Claude/Codex login is detected, but the quota poll returned no provider windows. If you just pulled these changes,
          restart the ADE app fully so the Electron main process picks up the updated usage parser.
        </div>
      ) : null}

      {snapshot?.errors.map((entry, index) => (
        <div key={`${entry}-${index}`} className="mt-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
          {entry}
        </div>
      ))}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ProviderUsageCard provider="Claude" windows={claudeWindows} nowMs={nowMs} />
        <ProviderUsageCard provider="Codex" windows={codexWindows} nowMs={nowMs} />
      </div>

      {(snapshot?.extraUsage ?? []).map((extra) => (
        <ExtraUsageCard key={extra.provider} extra={extra} />
      ))}

      {nightShiftReserve > 0 ? (
        <div
          className="mt-4 flex items-center gap-3 rounded-lg p-3"
          style={{ background: "#181423", border: "1px solid #2D2840" }}
        >
          <Moon size={16} weight="regular" className="shrink-0 text-[#A78BFA]" />
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
              Night Shift reserve
            </div>
            <div className="font-mono text-[10px] text-[#71717A]">
              {nightShiftReserve}% is reserved for overnight runs. Daytime automations can use the remaining {100 - nightShiftReserve}%.
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        {showApiCost && claudeCost ? (
          <CostSummaryCard
            provider="Claude"
            todayCostUsd={claudeCost.todayCostUsd}
            last30dCostUsd={claudeCost.last30dCostUsd}
            tokenBreakdown={claudeCost.tokenBreakdown}
          />
        ) : null}
        {showApiCost && codexCost ? (
          <CostSummaryCard
            provider="Codex"
            todayCostUsd={codexCost.todayCostUsd}
            last30dCostUsd={codexCost.last30dCostUsd}
            tokenBreakdown={codexCost.tokenBreakdown}
          />
        ) : null}
        <BudgetCapEditor
          config={budgetConfig}
          saving={budgetSaving}
          saveError={budgetError}
          onSave={saveBudgetConfig}
          className={cn(!showApiCost && "xl:col-span-3")}
        />
      </div>

      {!snapshot && !loading && !error ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-border/10 bg-card/70 py-12 text-center">
          <Lightning size={40} weight="regular" className="mb-3 text-[#2D2840]" />
          <div className="text-sm font-semibold text-fg">No provider usage data yet</div>
          <div className="mt-2 max-w-[44ch] font-mono text-[10px] text-muted-fg">
            This panel will fill in once Claude or Codex auth is configured and ADE has quota data to poll.
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProviderUsageCard({
  provider,
  windows,
  nowMs,
}: {
  provider: string;
  windows: UsageWindow[];
  nowMs: number;
}) {
  const fiveHour = windows.find((window) => window.windowType === "five_hour");
  const weekly = windows.find((window) => window.windowType === "weekly");
  const mode = provider === "Codex" ? "remaining" as const : "used" as const;
  const fiveHourPercent = fiveHour ? displayPercent(fiveHour, mode, nowMs) : null;
  const weeklyPercent = weekly ? displayPercent(weekly, mode, nowMs) : null;
  const fiveHourReset = fiveHour ? formatResetTime(computeResetsInMs(fiveHour.resetsAt, nowMs)) : undefined;
  const weeklyReset = weekly ? formatResetTime(computeResetsInMs(weekly.resetsAt, nowMs)) : undefined;
  const weeklyBreakdown =
    mode === "remaining" && weekly?.modelBreakdown
      ? Object.fromEntries(Object.entries(weekly.modelBreakdown).map(([label, value]) => [label, Math.max(0, 100 - value)]))
      : weekly?.modelBreakdown;

  return (
    <div className="space-y-4 rounded-lg p-4" style={CARD_SHADOW_STYLE}>
      <div className="flex items-center gap-2">
        <Lightning size={14} weight="regular" className="text-[#A78BFA]" />
        <span
          className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          {provider}
        </span>
      </div>

      {fiveHour ? (
        <UsageMeter
          label={provider === "Codex" ? "5-hour limit" : "5-hour window"}
          percent={fiveHourPercent ?? 0}
          sublabel={fiveHourReset}
          mode={mode}
        />
      ) : (
        <div className="font-mono text-[10px] text-[#71717A]">No short-window data available.</div>
      )}

      {weekly ? (
        <UsageMeter
          label={provider === "Codex" ? "Weekly limit" : "Weekly window"}
          percent={weeklyPercent ?? 0}
          sublabel={weeklyReset}
          modelBreakdown={weeklyBreakdown}
          mode={mode}
        />
      ) : (
        <div className="font-mono text-[10px] text-[#71717A]">No weekly data available.</div>
      )}
    </div>
  );
}

function ExtraUsageCard({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null;

  const usedUsd = extra.usedCreditsUsd;
  const limitUsd = extra.monthlyLimitUsd;
  const percent = limitUsd > 0 ? Math.min(100, (usedUsd / limitUsd) * 100) : 0;
  const fillColor = percent > 90 ? "#EF4444" : percent > 70 ? "#F59E0B" : "#A78BFA";

  const formatUsd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: extra.currency.toUpperCase() });

  return (
    <div
      className="mt-4 rounded-lg p-4"
      style={CARD_SHADOW_STYLE}
    >
      <div className="flex items-center gap-2">
        <Lightning size={14} weight="regular" className="text-[#A78BFA]" />
        <span
          className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          {extra.provider === "claude" ? "Claude" : "Codex"} Extra Usage
        </span>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
            Monthly spend
          </span>
          <span className="font-mono text-[10px] font-bold text-[#FAFAFA]">
            {formatUsd(usedUsd)}{limitUsd > 0 ? ` / ${formatUsd(limitUsd)}` : ""}
          </span>
        </div>

        {limitUsd > 0 ? (
          <div
            className="relative h-2 w-full overflow-hidden"
            style={{ background: "#1A1720", border: "1px solid #1E1B26" }}
          >
            <div
              className="absolute inset-y-0 left-0 transition-all duration-500 ease-out"
              style={{ width: `${percent}%`, background: fillColor }}
            />
          </div>
        ) : (
          <div className="font-mono text-[9px] text-[#71717A]">
            No monthly limit configured
          </div>
        )}
      </div>
    </div>
  );
}

function AuthChip({
  label,
  entry,
}: {
  label: string;
  entry: AiDetectedAuth | null;
}) {
  const authenticated = entry?.type === "cli-subscription" && entry.authenticated;
  const verified = entry?.type === "cli-subscription" ? entry.verified !== false : false;
  const tone = authenticated
    ? { border: "rgba(34,197,94,0.3)", bg: "rgba(34,197,94,0.12)", text: "#22C55E", copy: verified ? "connected" : "connected (unverified)" }
    : { border: "rgba(113,113,122,0.3)", bg: "rgba(113,113,122,0.12)", text: "#A1A1AA", copy: "not detected" };

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 font-mono text-[10px]"
      style={{ border: `1px solid ${tone.border}`, background: tone.bg, color: tone.text }}
    >
      <span>{label}</span>
      <span className="text-[#8B8B9A]">{tone.copy}</span>
    </div>
  );
}
