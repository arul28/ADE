import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const CARD_SHADOW_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(20, 31, 45, 0.96) 0%, rgba(10, 18, 28, 0.94) 100%)",
  border: "1px solid rgba(87, 108, 128, 0.22)",
  boxShadow: "0 18px 40px -24px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255,255,255,0.04)",
};

const PROVIDER_ORDER: UsageProvider[] = ["claude", "codex"];

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

function formatResetSublabel(resetsAt: string, nowMs: number): string {
  const ms = computeResetsInMs(resetsAt, nowMs);
  if (ms <= 0) return "resets now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function displayPercent(window: UsageWindow, nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  return resetsInMs <= 0 ? 0 : window.percentUsed;
}

function windowLabel(window: UsageWindow): string {
  switch (window.windowType) {
    case "five_hour":
      return "5-hour";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
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

  // Keep the latest onSnapshotChange in a ref so applySnapshot/manualRefresh
  // identities stay stable. Without this, a caller that passes an inline
  // arrow as onSnapshotChange would re-derive manualRefresh every render and
  // the auto-refresh-on-mount effect would re-fire in a loop.
  const onSnapshotChangeRef = useRef(onSnapshotChange);
  useEffect(() => {
    onSnapshotChangeRef.current = onSnapshotChange;
  }, [onSnapshotChange]);

  const applySnapshot = useCallback((nextSnapshot: UsageSnapshot | null) => {
    setSnapshot(nextSnapshot);
    onSnapshotChangeRef.current?.(nextSnapshot);
  }, []);

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

  // Auto-refresh on open so the drawer always shows fresh data instead of
  // whatever the last background poll happened to leave behind.
  useEffect(() => {
    void manualRefresh();
  }, [manualRefresh]);

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

  const visibleProviders = useMemo<UsageProvider[]>(() => {
    if (!providerConnections) return PROVIDER_ORDER;
    return PROVIDER_ORDER.filter((provider) => {
      const conn = providerConnection(providerConnections, provider);
      // Show only providers whose CLI is detected on this machine. Auth is
      // optional — a CLI without auth still renders so the user knows it's
      // installed but hasn't been signed in.
      return conn?.runtimeDetected !== false;
    });
  }, [providerConnections]);

  const windowsByProvider = useMemo(() => {
    const grouped: Partial<Record<UsageProvider, UsageWindow[]>> = {};
    for (const provider of visibleProviders) {
      grouped[provider] = snapshot?.windows.filter((window) => window.provider === provider) ?? [];
    }
    return grouped;
  }, [snapshot?.windows, visibleProviders]);

  return (
    <section className={cn("rounded-lg border border-white/10 bg-card/95 p-4 backdrop-blur-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Gauge size={15} weight="regular" className="text-muted-fg" />
            Provider usage
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

      {snapshot?.errors.map((entry, index) => (
        <div key={`${entry}-${index}`} className="mt-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
          {entry}
        </div>
      ))}

      {visibleProviders.length === 0 ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-border/10 bg-card/70 py-8 text-center">
          <Gauge size={32} weight="regular" className="mb-3 text-[#2D2840]" />
          <div className="text-sm font-semibold text-fg">No provider CLIs detected</div>
          <div className="mt-2 max-w-[44ch] text-[11px] text-muted-fg">
            Install Claude Code or the Codex CLI to start tracking usage here.
          </div>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3">
          {visibleProviders.map((provider) => (
            <ProviderUsageCard
              key={provider}
              provider={provider}
              windows={windowsByProvider[provider] ?? []}
              connection={providerConnection(providerConnections, provider)}
              dailyUsage7d={snapshot?.dailyUsage7d?.[provider] ?? null}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}

      {(snapshot?.extraUsage ?? [])
        .filter((extra) => extra.provider !== "cursor")
        .map((extra) => (
          <ExtraUsageCard key={extra.provider} extra={extra} />
        ))}
    </section>
  );
}

function Sparkline7d({
  data,
  color,
}: {
  data: number[];
  color: string;
}) {
  const max = Math.max(1, ...data);
  const width = 100;
  const height = 16;
  const step = width / Math.max(1, data.length);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      {data.map((value, index) => {
        const h = Math.max(1, (value / max) * (height - 1));
        const x = index * step + step * 0.1;
        const w = step * 0.8;
        return (
          <rect
            key={index}
            x={x}
            y={height - h}
            width={w}
            height={h}
            fill={color}
            opacity={0.65}
          />
        );
      })}
    </svg>
  );
}

function ProviderUsageCard({
  provider,
  windows,
  connection,
  dailyUsage7d,
  nowMs,
}: {
  provider: UsageProvider;
  windows: UsageWindow[];
  connection: AiProviderConnectionStatus | null;
  dailyUsage7d: number[] | null;
  nowMs: number;
}) {
  const meta = PROVIDER_META[provider];
  const isAuthed = connection?.authAvailable !== false;

  // Unauthed: render the card dimmed with a single "Not signed in" line and
  // no bars (matches the locked R2 wireframe).
  if (!isAuthed) {
    return (
      <div className="space-y-2 rounded-lg p-4 opacity-50" style={CARD_SHADOW_STYLE}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: meta.color, opacity: 0.5 }}
            />
            <span className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]">
              {meta.label}
            </span>
          </div>
          <span className="text-[11px] text-muted-fg">Not signed in</span>
        </div>
      </div>
    );
  }

  const weeklyWindow = windows.find((w) => w.windowType === "weekly");
  const monthlyWindow = windows.find((w) => w.windowType === "monthly");
  const trendWindow = weeklyWindow ?? monthlyWindow;
  const fiveHourWindow = windows.find((w) => w.windowType === "five_hour");
  const otherWindows = windows.filter(
    (w) => w !== weeklyWindow && w !== monthlyWindow && w !== fiveHourWindow,
  );

  return (
    <div className="space-y-3 rounded-lg p-4" style={CARD_SHADOW_STYLE}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
          <span className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]">
            {meta.label}
          </span>
        </div>
      </div>

      {windows.length > 0 ? (
        <div className="space-y-3">
          {fiveHourWindow ? (
            <UsageMeter
              key={`${provider}-five_hour`}
              label={windowLabel(fiveHourWindow)}
              percent={displayPercent(fiveHourWindow, nowMs)}
              sublabel={formatResetSublabel(fiveHourWindow.resetsAt, nowMs)}
              modelBreakdown={fiveHourWindow.modelBreakdown}
              mode="used"
              toneColor={meta.color}
            />
          ) : null}
          {[weeklyWindow, monthlyWindow].map((window) => window ? (
            <div className="space-y-1" key={`${provider}-${window.windowType}`}>
              <UsageMeter
                label={windowLabel(window)}
                percent={displayPercent(window, nowMs)}
                sublabel={formatResetSublabel(window.resetsAt, nowMs)}
                modelBreakdown={window.modelBreakdown}
                mode="used"
                toneColor={meta.color}
              />
              {window === trendWindow && dailyUsage7d && dailyUsage7d.some((value) => value > 0) ? (
                <div
                  className="flex items-center gap-2"
                  title="Daily token usage over the last 7 days (oldest → today)"
                >
                  <span className="font-mono text-[8px] uppercase tracking-[1px] text-[#71717A]">
                    7d
                  </span>
                  <div className="flex-1">
                    <Sparkline7d data={dailyUsage7d} color={meta.color} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null)}
          {otherWindows.map((window) => (
            <UsageMeter
              key={`${provider}-${window.windowType}`}
              label={windowLabel(window)}
              percent={displayPercent(window, nowMs)}
              sublabel={formatResetSublabel(window.resetsAt, nowMs)}
              modelBreakdown={window.modelBreakdown}
              mode="used"
              toneColor={meta.color}
            />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-fg">
          Waiting for the first usage poll…
        </div>
      )}
    </div>
  );
}

function ExtraUsageCard({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null;
  if (extra.provider === "cursor") return null;

  const meta = PROVIDER_META[extra.provider];
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
          {meta.label} extra usage
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
