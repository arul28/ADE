import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise as RefreshCw, Gauge } from "@phosphor-icons/react";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  ExtraUsage,
  UsageProvider,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { UsageMeter } from "../settings/UsageMeter";
import { UsagePacingBadge } from "../settings/UsagePacingBadge";

const CARD_SHADOW_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(20, 31, 45, 0.96) 0%, rgba(10, 18, 28, 0.94) 100%)",
  border: "1px solid rgba(87, 108, 128, 0.22)",
  boxShadow: "0 18px 40px -24px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255,255,255,0.04)",
};

const PROVIDER_ORDER: UsageProvider[] = ["claude", "codex", "cursor"];

const PROVIDER_META: Record<UsageProvider, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#D97757" },
  codex: { label: "Codex", color: "#4ADE80" },
  cursor: { label: "Cursor", color: "#00BFA5" },
};

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function formatPolledAt(iso: string | null): string {
  if (!iso) return "--";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "--";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function displayPercent(window: UsageWindow, nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  return resetsInMs <= 0 ? 0 : window.percentUsed;
}

function windowLabel(window: UsageWindow): string {
  switch (window.windowType) {
    case "five_hour":
      return "5-hour window";
    case "weekly":
      return "Weekly window";
    case "monthly":
      return "Monthly window";
    case "weekly_oauth_apps":
      return "OAuth apps";
    case "weekly_cowork":
      return "Cowork";
    default:
      return window.windowType;
  }
}

function providerConnection(
  connections: AiProviderConnections | null,
  provider: UsageProvider,
): AiProviderConnectionStatus | null {
  return connections?.[provider] ?? null;
}

export function UsageQuotaPanel({
  className,
  onSnapshotChange,
}: {
  className?: string;
  onSnapshotChange?: (snapshot: UsageSnapshot | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [providerConnections, setProviderConnections] = useState<AiProviderConnections | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const applySnapshot = useCallback((nextSnapshot: UsageSnapshot | null) => {
    setSnapshot(nextSnapshot);
    onSnapshotChange?.(nextSnapshot);
  }, [onSnapshotChange]);

  const load = useCallback(async () => {
    if (!window.ade?.usage) {
      setError("Usage bridge unavailable.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      applySnapshot(await window.ade.usage.getSnapshot());
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  const manualRefresh = useCallback(async () => {
    if (!window.ade?.usage) return;
    setLoading(true);
    setError(null);
    try {
      applySnapshot(await window.ade.usage.refresh());
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    void load();
    if (!window.ade?.usage) return;
    const unsubscribe = window.ade.usage.onUpdate(applySnapshot);
    return unsubscribe;
  }, [applySnapshot, load]);

  useEffect(() => {
    let cancelled = false;
    if (!window.ade?.ai?.getStatus) return;
    window.ade.ai.getStatus()
      .then((status) => {
        if (!cancelled) setProviderConnections(status.providerConnections ?? null);
      })
      .catch(() => {
        if (!cancelled) setProviderConnections(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const windowsByProvider = useMemo(() => {
    const grouped: Partial<Record<UsageProvider, UsageWindow[]>> = {};
    for (const provider of PROVIDER_ORDER) {
      grouped[provider] = snapshot?.windows.filter((window) => window.provider === provider) ?? [];
    }
    return grouped;
  }, [snapshot?.windows]);

  const hasAnyWindow = PROVIDER_ORDER.some((provider) => (windowsByProvider[provider]?.length ?? 0) > 0);
  const hasAnyExtraUsage = (snapshot?.extraUsage.length ?? 0) > 0;
  const showEmptyQuotaWarning =
    PROVIDER_ORDER.some((provider) => providerConnection(providerConnections, provider)?.authAvailable) &&
    !hasAnyWindow &&
    !hasAnyExtraUsage &&
    (snapshot?.errors.length ?? 0) === 0;

  return (
    <section className={cn("rounded-lg border border-white/10 bg-card/95 p-4 backdrop-blur-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Gauge size={15} weight="regular" className="text-muted-fg" />
            Provider usage
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-fg">
            Last polled: {formatPolledAt(snapshot?.lastPolledAt ?? null)}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void manualRefresh()} disabled={loading}>
          <RefreshCw size={12} weight="regular" className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{error}</div>
      ) : null}

      {showEmptyQuotaWarning ? (
        <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">
          Provider login is detected, but the quota poll returned no provider windows. Restart ADE if the main process has stale usage polling code.
        </div>
      ) : null}

      {snapshot?.errors.map((entry, index) => (
        <div key={`${entry}-${index}`} className="mt-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
          {entry}
        </div>
      ))}

      <div className="mt-4 grid grid-cols-1 gap-3">
        {PROVIDER_ORDER.map((provider) => (
          <ProviderUsageCard
            key={provider}
            provider={provider}
            windows={windowsByProvider[provider] ?? []}
            connection={providerConnection(providerConnections, provider)}
            pacing={snapshot?.pacingByProvider?.[provider] ?? null}
            nowMs={nowMs}
          />
        ))}
      </div>

      {(snapshot?.extraUsage ?? []).map((extra) => (
        <ExtraUsageCard key={extra.provider} extra={extra} />
      ))}

      {!snapshot && !loading && !error ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-border/10 bg-card/70 py-8 text-center">
          <Gauge size={32} weight="regular" className="mb-3 text-[#2D2840]" />
          <div className="text-sm font-semibold text-fg">No provider usage data yet</div>
          <div className="mt-2 max-w-[44ch] font-mono text-[10px] text-muted-fg">
            This fills in once provider auth is configured and ADE has quota data to poll.
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProviderUsageCard({
  provider,
  windows,
  connection,
  pacing,
  nowMs,
}: {
  provider: UsageProvider;
  windows: UsageWindow[];
  connection: AiProviderConnectionStatus | null;
  pacing: UsageSnapshot["pacing"] | null;
  nowMs: number;
}) {
  const meta = PROVIDER_META[provider];

  return (
    <div className="space-y-3 rounded-lg p-4" style={CARD_SHADOW_STYLE}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
          <span className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]">
            {meta.label}
          </span>
        </div>
        <AuthChip label={meta.label} entry={connection} />
      </div>

      {pacing ? (
        <UsagePacingBadge
          status={pacing.status}
          projectedPercent={pacing.projectedWeeklyPercent}
          pacing={pacing}
        />
      ) : null}

      {windows.length > 0 ? (
        <div className="space-y-3">
          {windows.map((window) => {
            const resetMs = computeResetsInMs(window.resetsAt, nowMs);
            return (
              <UsageMeter
                key={`${provider}-${window.windowType}`}
                label={windowLabel(window)}
                percent={displayPercent(window, nowMs)}
                sublabel={formatResetTime(resetMs)}
                modelBreakdown={window.modelBreakdown}
                mode="used"
                toneColor={meta.color}
              />
            );
          })}
        </div>
      ) : (
        <div className="font-mono text-[10px] text-[#71717A]">
          No quota window data available.
        </div>
      )}
    </div>
  );
}

function ExtraUsageCard({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null;

  const meta = PROVIDER_META[extra.provider];
  const title = extra.provider === "cursor" ? `${meta.label} monthly spend` : `${meta.label} extra usage`;
  const usedUsd = extra.usedCreditsUsd;
  const limitUsd = extra.monthlyLimitUsd;
  const percent = limitUsd > 0 ? Math.min(100, (usedUsd / limitUsd) * 100) : 0;
  let fillColor = meta.color;
  if (percent > 90) fillColor = "#EF4444";
  else if (percent > 70) fillColor = "#F59E0B";

  const formatUsd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: extra.currency.toUpperCase() });

  return (
    <div className="mt-3 rounded-lg p-4" style={CARD_SHADOW_STYLE}>
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
        <span className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]">
          {title}
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
          <div className="relative h-2 w-full overflow-hidden" style={{ background: "#1A1720", border: "1px solid #1E1B26" }}>
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
  entry: AiProviderConnectionStatus | null;
}) {
  let tone: { border: string; bg: string; text: string; copy: string };
  if (entry?.runtimeAvailable) {
    tone = { border: "rgba(34,197,94,0.3)", bg: "rgba(34,197,94,0.12)", text: "#22C55E", copy: "runtime ready" };
  } else if (entry?.authAvailable) {
    const copy = entry.runtimeDetected && !entry.runtimeAvailable
      ? entry.usageAvailable ? "usage auth only" : "sign-in required"
      : "auth found locally";
    tone = { border: "rgba(59,130,246,0.3)", bg: "rgba(59,130,246,0.12)", text: "#60A5FA", copy };
  } else {
    tone = { border: "rgba(113,113,122,0.3)", bg: "rgba(113,113,122,0.12)", text: "#A1A1AA", copy: "not detected" };
  }

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full px-2 py-0.5 font-mono text-[9px]"
      style={{ border: `1px solid ${tone.border}`, background: tone.bg, color: tone.text }}
      title={`${label}: ${tone.copy}`}
    >
      <span>{label}</span>
      <span className="text-[#8B8B9A]">{tone.copy}</span>
    </div>
  );
}
