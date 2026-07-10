import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, Gauge } from "@phosphor-icons/react";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  ExtraUsage,
  UsagePacing,
  UsageProvider,
  UsageProviderStatus,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import { hasLocalProviderConnectionSignal } from "../../lib/aiProviderStatus";
import { providerChatAccent } from "../chat/chatSurfaceTheme";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import { cn } from "../ui/cn";

const PROVIDER_ORDER: UsageProvider[] = ["claude", "codex"];

const PROVIDER_META: Record<UsageProvider, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#D97757" },
  codex: { label: "Codex", color: providerChatAccent("codex")! },
  cursor: { label: "Cursor", color: "#00BFA5" },
};

const CARD_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(28,27,38,0.72) 0%, rgba(18,17,26,0.72) 100%)",
  border: "1px solid rgba(255,255,255,0.06)",
  boxShadow: "0 12px 30px -22px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.03)",
};

// ── small formatters ─────────────────────────────────────────────

function computeResetsInMs(resetsAt: string, nowMs: number): number {
  if (!resetsAt) return 0;
  return Math.max(0, new Date(resetsAt).getTime() - nowMs);
}

function formatResetIn(resetsAt: string, nowMs: number): string {
  const ms = computeResetsInMs(resetsAt, nowMs);
  if (ms <= 0) return "resetting now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

function formatUsagePercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function formatHoursShort(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// "today 3pm" / "tomorrow 9am" / "Tue 3pm" — when the quota would run dry.
function formatClock(targetMs: number, nowMs: number): string {
  const d = new Date(targetMs);
  const hours = d.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const dayDiff = Math.round((startOfDay(targetMs) - startOfDay(nowMs)) / 86_400_000);
  const prefix = dayDiff <= 0 ? "today" : dayDiff === 1 ? "tomorrow" : WEEKDAYS[d.getDay()];
  return `${prefix} ${h12}${ampm}`;
}

function windowLabel(window: UsageWindow): string {
  if (window.windowType === "five_hour" && window.windowDurationMs && window.windowDurationMs > 0) {
    const minutes = Math.round(window.windowDurationMs / 60_000);
    if (minutes < 60) return `${minutes}-min`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}-hour` : `${hours.toFixed(1)}-hour`;
  }
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

function displayPercent(window: UsageWindow, nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  const value = resetsInMs <= 0 ? 0 : window.percentUsed;
  return Math.max(0, Math.min(100, value));
}

function fillColorFor(percent: number, tone: string): string {
  if (percent > 90) return "#F87171";
  if (percent > 70) return "#F5A623";
  return tone;
}

type PaceVisual = { label: string; arrow: string; color: string; tint: string };

// Map the computed pacing to a calm/warm/hot read. "ahead" = burning faster
// than a steady pace (warm); "behind" = headroom (cool); "on track" (green).
function paceVisual(pacing?: UsagePacing | null): PaceVisual | null {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const { status, deltaPercent } = pacing;
  const mag = Math.round(Math.abs(deltaPercent));
  if (status === "on-track" || mag < 1) {
    return { label: "on track", arrow: "", color: "#34D399", tint: "#34D39920" };
  }
  let color: string;
  if (status === "far-ahead") color = "#F87171";
  else if (status === "ahead" || status === "slightly-ahead") color = "#F5A623";
  else color = "#8B93A7"; // behind family = headroom, kept calm
  const ahead = deltaPercent >= 0;
  return { label: `${mag}% ${ahead ? "ahead" : "behind"}`, arrow: ahead ? "▴" : "▾", color, tint: `${color}20` };
}

function headroomTitle(window: UsageWindow, nowMs: number): string {
  const reset = formatResetIn(window.resetsAt, nowMs);
  const pacing = window.pacing;
  const pct = Math.round(window.percentUsed);
  if (!pacing || pacing.etaHours == null) return `${pct}% used · ${reset}`;
  if (pacing.etaHours <= 0) return `Quota exhausted · ${reset}`;
  const left = formatHoursShort(pacing.etaHours);
  return pacing.willLastToReset
    ? `~${left} of headroom at this pace · ${reset}`
    : `~${left} left at this pace — would run dry before reset · ${reset}`;
}

function providerConnection(
  connections: AiProviderConnections | null,
  provider: UsageProvider,
): AiProviderConnectionStatus | null {
  return connections?.[provider] ?? null;
}

function ageMsFromIso(iso: string | undefined, nowMs: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return nowMs - parsed;
}

function providerSourceLabel(status: UsageProviderStatus | null): string {
  if (status?.source === "oauth") return "OAuth";
  if (status?.source === "http") return "HTTP";
  if (status?.source === "cli") return "CLI";
  return "Waiting";
}

function providerUpdatedLabel(status: UsageProviderStatus | null, nowMs: number): string {
  const updatedAt = status?.updatedAt ?? status?.lastSuccessAt;
  const ageMs = ageMsFromIso(updatedAt ?? undefined, nowMs);
  if (!Number.isFinite(ageMs)) return "not updated";
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.max(1, Math.floor(ageMs / 60_000))}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
}

// ── panel ────────────────────────────────────────────────────────

export function UsageQuotaPanel({
  className,
  onSnapshotChange,
  showRefreshControl = false,
}: {
  className?: string;
  onSnapshotChange?: (snapshot: UsageSnapshot | null) => void;
  showRefreshControl?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [providerConnections, setProviderConnections] = useState<AiProviderConnections | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const onSnapshotChangeRef = useRef(onSnapshotChange);
  useEffect(() => {
    onSnapshotChangeRef.current = onSnapshotChange;
  }, [onSnapshotChange]);

  const applySnapshot = useCallback((nextSnapshot: UsageSnapshot | null) => {
    setSnapshot(nextSnapshot);
    onSnapshotChangeRef.current?.(nextSnapshot);
  }, []);

  // Render cached numbers instantly, subscribe to live updates, and tell the
  // adaptive scheduler that this surface is active. A failed refresh changes
  // nothing already shown.
  useEffect(() => {
    if (!window.ade?.usage) {
      setBridgeMissing(true);
      return;
    }
    const bridge = window.ade.usage;
    let cancelled = false;
    const unsubscribe = bridge.onUpdate?.((next) => {
      if (!cancelled) applySnapshot(next);
    });

    void (async () => {
      let current: UsageSnapshot | null = null;
      try {
        current = await bridge.getSnapshot();
      } catch {
        current = null;
      }
      if (cancelled) return;
      if (current) applySnapshot(current);

      try {
        const demanded = await bridge.noteDemand?.();
        if (!cancelled && demanded) applySnapshot(demanded);
      } catch {
        // Quiet — demand only schedules a non-interactive provider refresh.
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applySnapshot]);

  const refreshNow = useCallback(async () => {
    if (!window.ade?.usage?.refresh || refreshing) return;
    setRefreshing(true);
    try {
      const next = await window.ade.usage.refresh();
      if (next) applySnapshot(next);
    } catch {
      // The service preserves last-good data and records the provider state.
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot, refreshing]);

  useEffect(() => {
    let cancelled = false;
    if (!window.ade?.ai?.getStatus) return;
    window.ade.ai
      .getStatus()
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
      return hasLocalProviderConnectionSignal(conn);
    });
  }, [providerConnections]);

  const windowsByProvider = useMemo(() => {
    const grouped: Partial<Record<UsageProvider, UsageWindow[]>> = {};
    for (const provider of visibleProviders) {
      grouped[provider] = snapshot?.windows.filter((window) => window.provider === provider) ?? [];
    }
    return grouped;
  }, [snapshot?.windows, visibleProviders]);

  if (bridgeMissing) {
    return (
      <div className={cn("rounded-lg px-3 py-6 text-center text-[12px] text-fg/45", className)}>
        Usage isn't available in this view.
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {showRefreshControl ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-fg">Live limits</div>
            <div className="mt-0.5 text-[10.5px] text-fg/45">Quota refresh never scans local history.</div>
          </div>
          <button
            type="button"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-fg/70 hover:bg-white/[0.05] disabled:opacity-50"
          >
            <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Refreshing" : "Refresh limits"}
          </button>
        </div>
      ) : null}
      {visibleProviders.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center rounded-xl py-9 text-center"
          style={CARD_STYLE}
        >
          <Gauge size={30} weight="regular" className="mb-3 text-fg/25" />
          <div className="text-[13px] font-semibold text-fg">No provider CLIs detected</div>
          <div className="mt-1.5 max-w-[44ch] text-[11.5px] text-fg/45">
            Install Claude Code or the Codex CLI to start tracking usage here.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {visibleProviders.map((provider) => (
            <ProviderUsageCard
              key={provider}
              provider={provider}
              windows={windowsByProvider[provider] ?? []}
              connection={providerConnection(providerConnections, provider)}
              status={snapshot?.providerStatus?.[provider] ?? null}
              messages={(snapshot?.providerMessages ?? []).filter((message) => message.provider === provider)}
              dailyUsage7d={snapshot?.dailyUsage7d?.[provider] ?? null}
              nowMs={nowMs}
              reducedMotion={reducedMotion}
              refreshing={refreshing}
              onRefresh={refreshNow}
            />
          ))}
        </div>
      )}

      {(snapshot?.extraUsage ?? [])
        .filter((extra) => extra.provider !== "cursor")
        .map((extra) => (
          <ExtraUsageCard key={extra.provider} extra={extra} reducedMotion={reducedMotion} />
        ))}
    </div>
  );
}

// ── pace bar ─────────────────────────────────────────────────────

function PaceBar({
  window,
  toneColor,
  nowMs,
  reducedMotion,
}: {
  window: UsageWindow;
  toneColor: string;
  nowMs: number;
  reducedMotion: boolean;
}) {
  const percent = displayPercent(window, nowMs);
  const fill = fillColorFor(percent, toneColor);
  const pace = paceVisual(window.pacing);
  const expected = window.pacing?.expectedPercent;
  const showTick = typeof expected === "number" && expected > 1 && expected < 99;

  const [grown, setGrown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) {
      setGrown(true);
      return;
    }
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium text-fg/85">{windowLabel(window)}</span>
        {pace ? <PacePill pace={pace} /> : null}
      </div>

      <div
        className="relative h-2.5 w-full overflow-hidden rounded-full"
        style={{ background: "rgba(255,255,255,0.07)" }}
        role="progressbar"
        aria-label={`${windowLabel(window)}: ${formatUsagePercent(percent)} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        title={headroomTitle(window, nowMs)}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${grown ? percent : 0}%`,
            background: fill,
            transition: reducedMotion ? undefined : "width 700ms cubic-bezier(0.22,1,0.36,1)",
          }}
        />
        {showTick ? (
          <span
            className="absolute top-[-1px] bottom-[-1px] w-px"
            style={{ left: `${expected}%`, background: "rgba(255,255,255,0.6)" }}
            aria-hidden
            title={`Expected ~${Math.round(expected ?? 0)}% by now`}
          />
        ) : null}
      </div>

      <div className="text-[10.5px] tabular-nums text-fg/45">
        <span>{formatUsagePercent(percent)} used</span>
        <span>{` · ${formatResetIn(window.resetsAt, nowMs)}`}</span>
      </div>
    </div>
  );
}

function PacePill({ pace }: { pace: PaceVisual }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-[1px] text-[10px] font-medium leading-none"
      style={{ color: pace.color, background: pace.tint }}
    >
      {pace.label}
      {pace.arrow ? <span aria-hidden>{pace.arrow}</span> : null}
    </span>
  );
}

// ── trend + sparkline ────────────────────────────────────────────

function TrendLine({ pacing, nowMs }: { pacing?: UsagePacing | null; nowMs: number }) {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const projected = Math.round(pacing.projectedWeeklyPercent);
  const parts = [`trending to ${projected}% by reset`];
  if (pacing.etaHours != null && pacing.etaHours > 0 && !pacing.willLastToReset) {
    parts.push(`runs dry ~${formatClock(nowMs + pacing.etaHours * 3_600_000, nowMs)}`);
  } else if (pacing.willLastToReset) {
    parts.push("lasts to reset");
  }
  return <div className="text-[10.5px] text-fg/45">{parts.join(" · ")}</div>;
}

function Sparkline7d({ data, color, nowMs }: { data: number[]; color: string; nowMs: number }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-4 items-end gap-[3px]">
      {data.map((value, index) => {
        const heightPx = Math.max(2, Math.round((value / max) * 16));
        const isToday = index === data.length - 1;
        const dayMs = nowMs - (data.length - 1 - index) * 86_400_000;
        const date = new Date(dayMs);
        const title = `${WEEKDAYS[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()} · ${formatTokens(value)} tokens`;
        return (
          <div
            key={index}
            title={title}
            className="w-full rounded-[2px]"
            style={{ minWidth: 4, height: heightPx, background: color, opacity: isToday ? 0.95 : 0.4 }}
          />
        );
      })}
    </div>
  );
}

function ModelSplitLine({ breakdown }: { breakdown: Record<string, number> }) {
  const entries = Object.entries(breakdown).filter(([, pct]) => pct > 0);
  if (entries.length === 0) return null;
  return (
    <span className="truncate text-[10.5px] text-fg/45">
      {entries.map(([model, pct]) => `${model} ${Math.round(pct)}%`).join(" · ")}
    </span>
  );
}

// ── provider card ────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-3 w-16 rounded bg-white/[0.05]" />
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-white/[0.09]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderUsageCard({
  provider,
  windows,
  connection,
  status,
  messages,
  dailyUsage7d,
  nowMs,
  reducedMotion,
  refreshing,
  onRefresh,
}: {
  provider: UsageProvider;
  windows: UsageWindow[];
  connection: AiProviderConnectionStatus | null;
  status: UsageProviderStatus | null;
  messages: NonNullable<UsageSnapshot["providerMessages"]>;
  dailyUsage7d: number[] | null;
  nowMs: number;
  reducedMotion: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const meta = PROVIDER_META[provider];
  const isAuthed = connection?.authAvailable !== false;
  const isUsageUnauthed = status?.state === "unauthed";

  if (windows.length === 0 && (!isAuthed || isUsageUnauthed)) {
    return (
      <div className="rounded-xl px-4 py-3.5" style={CARD_STYLE}>
        <div className="flex items-start justify-between gap-3">
          <ProviderHeading provider={provider} color={meta.color} label={meta.label} dim />
          <span className="text-right text-[10px] text-fg/40">
            {providerSourceLabel(status)} · {providerUpdatedLabel(status, nowMs)}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300/10 bg-amber-300/[0.04] px-2.5 py-2">
          <span className="text-[11px] text-amber-100/65">{status?.message ?? "Not signed in"}</span>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="min-h-8 shrink-0 rounded-md border border-white/10 px-2 text-[10.5px] text-fg/70 hover:bg-white/[0.05] disabled:opacity-50"
          >
            Reconnect
          </button>
        </div>
      </div>
    );
  }

  const fiveHourWindow = windows.find((w) => w.windowType === "five_hour");
  const weeklyWindow = windows.find((w) => w.windowType === "weekly");
  const monthlyWindow = windows.find((w) => w.windowType === "monthly");
  const trendWindow = weeklyWindow ?? monthlyWindow;
  const secondaryWindows = [
    ...(monthlyWindow && monthlyWindow !== trendWindow ? [monthlyWindow] : []),
    ...windows.filter((w) => w !== fiveHourWindow && w !== weeklyWindow && w !== monthlyWindow),
  ];
  const has7d = !!dailyUsage7d && dailyUsage7d.some((value) => value > 0);
  const modelBreakdown = trendWindow?.modelBreakdown;

  return (
    <div className="rounded-xl px-4 py-3.5" style={CARD_STYLE}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <ProviderHeading provider={provider} color={meta.color} label={meta.label} />
        <span className="text-right text-[10px] text-fg/40">
          {providerSourceLabel(status)} · {providerUpdatedLabel(status, nowMs)}
        </span>
      </div>

      {status && status.state !== "ok" ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300/10 bg-amber-300/[0.04] px-2.5 py-2">
          <span className="text-[10.5px] text-amber-100/65">
            {status.message ?? (status.state === "stale" ? "Showing last known quota" : "Quota is unavailable")}
          </span>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="min-h-8 shrink-0 rounded-md border border-white/10 px-2 text-[10px] text-fg/70 hover:bg-white/[0.05] disabled:opacity-50"
          >
            {status.state === "unauthed" ? "Reconnect" : "Retry"}
          </button>
        </div>
      ) : null}

      {windows.length > 0 ? (
        <div className="space-y-3">
          {messages.slice(0, 1).map((message) => (
            <div
              key={message.id}
              className="rounded-lg border border-white/[0.06] bg-white/[0.035] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-fg/58"
              title={message.message}
            >
              <span className="mr-1.5 font-semibold text-fg/68">
                {message.kind === "headline" ? "Notice" : "Update"}
              </span>
              {message.message}
            </div>
          ))}

          {fiveHourWindow ? (
            <PaceBar window={fiveHourWindow} toneColor={meta.color} nowMs={nowMs} reducedMotion={reducedMotion} />
          ) : null}

          {trendWindow ? (
            <div className="space-y-1.5">
              <PaceBar window={trendWindow} toneColor={meta.color} nowMs={nowMs} reducedMotion={reducedMotion} />
              <TrendLine pacing={trendWindow.pacing} nowMs={nowMs} />
            </div>
          ) : null}

          {modelBreakdown || has7d ? (
            <div className="flex items-end justify-between gap-3 pt-0.5">
              {modelBreakdown ? <ModelSplitLine breakdown={modelBreakdown} /> : <span />}
              {has7d && dailyUsage7d ? (
                <div className="flex items-center gap-2">
                  <Sparkline7d data={dailyUsage7d} color={meta.color} nowMs={nowMs} />
                  <span className="text-[9.5px] text-fg/35">7d</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {secondaryWindows.map((window) => (
            <PaceBar
              key={`${provider}-${window.windowType}`}
              window={window}
              toneColor={meta.color}
              nowMs={nowMs}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
      ) : status?.state === "error" ? (
        <div className="text-[11.5px] text-fg/45">
          {status.message ?? "Couldn't reach this provider — retrying"}
        </div>
      ) : (
        <SkeletonRows />
      )}
    </div>
  );
}

function ProviderHeading({
  provider,
  color,
  label,
  dim,
}: {
  provider: UsageProvider;
  color: string;
  label: string;
  dim?: boolean;
}) {
  const Logo = provider === "claude" ? ClaudeLogo : provider === "codex" ? CodexLogo : null;
  return (
    <div className="flex items-center gap-2">
      {Logo ? (
        <Logo
          size={16}
          className={cn(
            "shrink-0",
            provider === "codex" && "text-zinc-100",
            dim && "opacity-55",
          )}
        />
      ) : (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, opacity: dim ? 0.5 : 1, boxShadow: dim ? undefined : `0 0 8px ${color}66` }}
        />
      )}
      <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-fg">{label}</span>
    </div>
  );
}

// ── extra usage (monthly spend) ──────────────────────────────────

function ExtraUsageCard({ extra, reducedMotion }: { extra: ExtraUsage; reducedMotion: boolean }) {
  if (!extra.isEnabled) return null;
  if (extra.provider === "cursor") return null;

  const meta = PROVIDER_META[extra.provider];
  const usedUsd = extra.usedCreditsUsd;
  const limitUsd = extra.monthlyLimitUsd;
  const percent = limitUsd > 0 ? Math.min(100, (usedUsd / limitUsd) * 100) : 0;
  const fillColor = fillColorFor(percent, meta.color);
  const formatUsd = (v: number) =>
    v.toLocaleString("en-US", { style: "currency", currency: extra.currency.toUpperCase() });

  return (
    <div className="rounded-xl px-4 py-3.5" style={CARD_STYLE}>
      <div className="flex items-center justify-between gap-3">
        <ProviderHeading provider={extra.provider} color={meta.color} label={`${meta.label} extra usage`} />
        <span className="text-[11px] tabular-nums text-fg/70">
          {formatUsd(usedUsd)}
          {limitUsd > 0 ? <span className="text-fg/40"> / {formatUsd(limitUsd)}</span> : null}
        </span>
      </div>

      {limitUsd > 0 ? (
        <div
          className="mt-2.5 h-2.5 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.07)" }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${percent}%`,
              background: fillColor,
              transition: reducedMotion ? undefined : "width 700ms cubic-bezier(0.22,1,0.36,1)",
            }}
          />
        </div>
      ) : (
        <div className="mt-2 text-[10.5px] text-fg/40">No monthly limit configured</div>
      )}
    </div>
  );
}
