import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeviceMobile,
  Fire,
  Globe,
  Monitor,
  TerminalWindow,
  Trophy,
} from "@phosphor-icons/react";
import type {
  AdeUsageClientSurface,
  AdeUsageDailyPoint,
  AdeUsageRangePreset,
  AdeUsageStats,
} from "../../../shared/types";
import { formatTokens } from "../../lib/format";
import { useAppStore } from "../../state/appStore";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ade.activity.module.v1";
const LEGACY_STORAGE_KEY = "ade.stats.carousel.v1";
const DEFAULT_PRESET: AdeUsageRangePreset = "all";

const TABS = ["activity", "tokens", "code", "clients"] as const;
type ActivityTab = (typeof TABS)[number];

const TAB_LABELS: Record<ActivityTab, string> = {
  activity: "Activity",
  tokens: "Tokens",
  code: "Code",
  clients: "Clients",
};

export const RANGE_OPTIONS: Array<{ preset: AdeUsageRangePreset; label: string }> = [
  { preset: "today", label: "Today" },
  { preset: "7d", label: "7d" },
  { preset: "30d", label: "30d" },
  { preset: "year", label: "Year" },
  { preset: "all", label: "All" },
];

type PersistedState = { tab: ActivityTab; preset: AdeUsageRangePreset };

function isTab(value: unknown): value is ActivityTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

function isPreset(value: unknown): value is AdeUsageRangePreset {
  return RANGE_OPTIONS.some((option) => option.preset === value);
}

export function readActivityPersisted(): PersistedState {
  const fallback: PersistedState = { tab: "activity", preset: DEFAULT_PRESET };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        tab: isTab(parsed.tab) ? parsed.tab : "activity",
        preset: isPreset(parsed.preset) ? parsed.preset : DEFAULT_PRESET,
      };
    }
    // Migrate the retired carousel key ({ slide, preset }) once, gracefully.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as { slide?: unknown; preset?: unknown };
      return {
        tab: isTab(parsed.slide) ? parsed.slide : "activity",
        preset: isPreset(parsed.preset) ? parsed.preset : DEFAULT_PRESET,
      };
    }
  } catch {
    // Preferences are best-effort in hardened/private browser contexts.
  }
  return fallback;
}

function persistActivityPatch(patch: Partial<PersistedState>): void {
  if (typeof localStorage === "undefined") return;
  try {
    const current = readActivityPersisted();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Reduced-motion
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return Math.floor(value).toLocaleString();
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString([], { month: "short", day: "numeric" });
}

function dayValue(point: AdeUsageDailyPoint): number {
  return (
    point.totalTokens
    + point.sessions * 4_000
    + (point.interactions ?? 0) * 1_500
    // GitHub-only days (no local tokens/sessions) still count toward the
    // heatmap intensity, consistent with dayHasActivity: commits/PRs weighted
    // like sessions-scale events, additions/deletions as raw line counts.
    + (point.githubCommits ?? 0) * 3_000
    + (point.githubPrs ?? 0) * 5_000
    + (point.githubAdditions ?? 0)
    + (point.githubDeletions ?? 0)
  );
}

function dayHasActivity(point: AdeUsageDailyPoint): boolean {
  return (
    point.totalTokens > 0 ||
    point.sessions > 0 ||
    point.insertions > 0 ||
    point.deletions > 0 ||
    (point.githubCommits ?? 0) > 0 ||
    (point.githubPrs ?? 0) > 0 ||
    (point.githubAdditions ?? 0) > 0 ||
    (point.githubDeletions ?? 0) > 0 ||
    (point.interactions ?? 0) > 0
  );
}

function sessionsTotal(stats: AdeUsageStats): number {
  return (stats.summary.chatSessions ?? 0) + (stats.summary.terminalSessions ?? 0);
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const TOKEN_COLORS = { input: "#5B93F5", output: "#E0A82E", cache: "#8892A6" } as const;
const CODE_COLORS = { insertions: "#3FB950", deletions: "#E5595C", github: "#8892A6" } as const;
const HEATMAP_HUE = "#5B93F5";

const CLIENT_COLORS: Record<AdeUsageClientSurface, string> = {
  desktop: "#5B93F5",
  mobile: "#E0729B",
  tui: "#3FB950",
  web: "#2DD4BF",
  api: "#E0A82E",
};
const CLIENT_LABELS: Record<AdeUsageClientSurface, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tui: "ADE Code",
  web: "Web",
  api: "API",
};

// ---------------------------------------------------------------------------
// Day tooltip
// ---------------------------------------------------------------------------

type TooltipState = { point: AdeUsageDailyPoint; left: number; top: number };

function useDayTooltip(containerRef: React.RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const locate = useCallback((point: AdeUsageDailyPoint, target: HTMLElement): TooltipState | null => {
    const container = containerRef.current;
    if (!container) return null;
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const half = 92;
    const rawLeft = t.left - c.left + t.width / 2;
    return {
      point,
      left: Math.min(Math.max(rawLeft, half), Math.max(half, c.width - half)),
      top: t.top - c.top,
    };
  }, [containerRef]);

  const show = useCallback((point: AdeUsageDailyPoint, target: HTMLElement) => {
    const next = locate(point, target);
    if (next) setTip(next);
  }, [locate]);

  const toggle = useCallback((point: AdeUsageDailyPoint, target: HTMLElement) => {
    setTip((prev) => (prev?.point.date === point.date ? null : locate(point, target)));
  }, [locate]);

  const hide = useCallback(() => setTip(null), []);

  return { tip, show, toggle, hide };
}

function DayTooltip({ tip }: { tip: TooltipState }) {
  const { point } = tip;
  const code = point.insertions + point.deletions;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full rounded-lg border px-2.5 py-2 text-left"
      style={{
        left: tip.left,
        top: tip.top - 8,
        minWidth: 150,
        background: "color-mix(in srgb, var(--color-card) 96%, var(--color-fg) 4%)",
        borderColor: "color-mix(in srgb, var(--color-border) 80%, transparent)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}
    >
      <div className="text-[11px] font-semibold text-fg">{formatDay(point.date)}</div>
      <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-muted-fg">
        <span>{formatTokens(point.totalTokens)} tokens</span>
        <span>
          {formatTokens(point.inputTokens)} in · {formatTokens(point.outputTokens)} out
          {point.cachedTokens != null && point.cachedTokens > 0 ? ` · ${formatTokens(point.cachedTokens)} cache` : ""}
        </span>
        <span>{point.sessions} {point.sessions === 1 ? "session" : "sessions"}</span>
        {code > 0 ? (
          <span>
            <span style={{ color: CODE_COLORS.insertions }}>+{compact(point.insertions)}</span>
            {" "}
            <span style={{ color: CODE_COLORS.deletions }}>-{compact(point.deletions)}</span>
            {" lines"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart primitives
// ---------------------------------------------------------------------------

/** Downsamples a daily series so wide ranges stay legible as fixed-count bars. */
function useChartPoints(points: AdeUsageDailyPoint[], maxBars: number): AdeUsageDailyPoint[] {
  return useMemo(() => {
    const source = [...points].sort((a, b) => a.date.localeCompare(b.date));
    if (source.length <= maxBars) return source;
    const size = Math.ceil(source.length / maxBars);
    const merged: AdeUsageDailyPoint[] = [];
    for (let index = 0; index < source.length; index += size) {
      const chunk = source.slice(index, index + size);
      const last = chunk.at(-1);
      if (!last) continue;
      const sum = (pick: (p: AdeUsageDailyPoint) => number) => chunk.reduce((acc, p) => acc + pick(p), 0);
      merged.push({
        date: last.date,
        inputTokens: sum((p) => p.inputTokens),
        outputTokens: sum((p) => p.outputTokens),
        totalTokens: sum((p) => p.totalTokens),
        cachedTokens: sum((p) => p.cachedTokens ?? 0),
        commits: sum((p) => p.commits),
        prs: sum((p) => p.prs),
        insertions: sum((p) => p.insertions),
        deletions: sum((p) => p.deletions),
        filesChanged: sum((p) => p.filesChanged),
        sessions: sum((p) => p.sessions),
        durationMs: sum((p) => p.durationMs ?? 0),
        interactions: sum((p) => p.interactions ?? 0),
        githubAdditions: sum((p) => p.githubAdditions ?? 0),
        githubDeletions: sum((p) => p.githubDeletions ?? 0),
      });
    }
    return merged;
  }, [points, maxBars]);
}

function ChartFrame({
  height,
  children,
  ariaLabel,
}: {
  height: number;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-end gap-[3px]" style={{ height }} role="img" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

function ActivityHeatmap({
  points,
  height,
  reduced,
  tooltip,
}: {
  points: AdeUsageDailyPoint[];
  height: number;
  reduced: boolean;
  tooltip: ReturnType<typeof useDayTooltip>;
}) {
  const cells = useMemo(() => {
    const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const max = Math.max(1, ...ordered.map(dayValue));
    return ordered.map((point) => ({ point, intensity: Math.max(0, Math.min(1, dayValue(point) / max)) }));
  }, [points]);

  // Fill the chart box instead of leaving it mostly blank: a short range lays out
  // as one tall row of large cells; longer ranges use a 7-row calendar-style grid
  // (columns = weeks) whose cells stretch to fill the available width and height.
  const rows = cells.length <= 7 ? 1 : 7;
  const cols = Math.max(1, Math.ceil(cells.length / rows));

  return (
    <div
      className="grid min-h-0 w-full flex-1 gap-[3px]"
      style={{
        height,
        gridAutoFlow: "column",
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
      role="img"
      aria-label="Daily activity heatmap"
      data-heatmap-rows={rows}
    >
      {cells.map(({ point, intensity }) => (
        <span
          key={point.date}
          className="rounded-[2px]"
          data-intensity={intensity.toFixed(2)}
          style={{
            background:
              intensity === 0
                ? "color-mix(in srgb, var(--color-fg) 7%, transparent)"
                : `color-mix(in srgb, ${HEATMAP_HUE} ${Math.round(24 + intensity * 68)}%, var(--color-card))`,
            transition: reduced ? undefined : "background 120ms ease",
            cursor: "default",
          }}
          onPointerEnter={(event) => tooltip.show(point, event.currentTarget)}
          onPointerLeave={tooltip.hide}
          onClick={(event) => tooltip.toggle(point, event.currentTarget)}
        />
      ))}
    </div>
  );
}

/** Muted, centered hint for a tab whose own series is empty while the module
 * has data on other tabs (so the global warm-empty state does not apply). */
function TabEmptyHint({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-center text-[11px] text-muted-fg">
      {message}
    </div>
  );
}

function TokenBars({
  points,
  height,
  reduced,
  tooltip,
}: {
  points: AdeUsageDailyPoint[];
  height: number;
  reduced: boolean;
  tooltip: ReturnType<typeof useDayTooltip>;
}) {
  const max = Math.max(1, ...points.map((p) => p.totalTokens));
  const anyCache = points.some((p) => (p.cachedTokens ?? 0) > 0);
  const anyTokens = points.some((p) => p.totalTokens > 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-2">
      {!anyTokens ? (
        <TabEmptyHint message="No token usage in this range." />
      ) : (
      <ChartFrame height={height} ariaLabel="Token usage by day, split by input, output, and cache">
        {points.map((point) => {
          const total = Math.max(0, point.inputTokens + point.outputTokens + (point.cachedTokens ?? 0));
          const barHeight = total > 0 ? Math.max(3, (total / max) * height) : 0;
          const seg = (value: number) => (total > 0 ? `${(value / total) * 100}%` : "0%");
          return (
            <div
              key={point.date}
              className="relative flex min-w-[3px] flex-1 flex-col-reverse overflow-hidden rounded-t-[2px]"
              style={{ height: barHeight, transition: reduced ? undefined : "height 160ms ease" }}
              onPointerEnter={(event) => tooltip.show(point, event.currentTarget)}
              onPointerLeave={tooltip.hide}
              onClick={(event) => tooltip.toggle(point, event.currentTarget)}
            >
              <span style={{ height: seg(point.inputTokens), background: TOKEN_COLORS.input }} />
              <span style={{ height: seg(point.outputTokens), background: TOKEN_COLORS.output }} />
              {anyCache ? <span style={{ height: seg(point.cachedTokens ?? 0), background: TOKEN_COLORS.cache }} /> : null}
            </div>
          );
        })}
      </ChartFrame>
      )}
      <Legend
        items={[
          { color: TOKEN_COLORS.input, label: "Input" },
          { color: TOKEN_COLORS.output, label: "Output" },
          ...(anyCache ? [{ color: TOKEN_COLORS.cache, label: "Cache" }] : []),
        ]}
      />
    </div>
  );
}

function CodeBars({
  points,
  height,
  reduced,
  tooltip,
}: {
  points: AdeUsageDailyPoint[];
  height: number;
  reduced: boolean;
  tooltip: ReturnType<typeof useDayTooltip>;
}) {
  const anyGithub = points.some((p) => (p.githubAdditions ?? 0) + (p.githubDeletions ?? 0) > 0);
  const localMax = Math.max(1, ...points.map((p) => p.insertions + p.deletions));
  const githubMax = anyGithub
    ? Math.max(1, ...points.map((p) => (p.githubAdditions ?? 0) + (p.githubDeletions ?? 0)))
    : 1;
  const max = Math.max(localMax, githubMax);
  const anyCode = points.some((p) => p.insertions + p.deletions > 0) || anyGithub;
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-2">
      {!anyCode ? (
        <TabEmptyHint message="No code changes in this range." />
      ) : (
      <ChartFrame height={height} ariaLabel="Code changes by day, additions and deletions">
        {points.map((point) => {
          const total = Math.max(0, point.insertions + point.deletions);
          const barHeight = total > 0 ? Math.max(3, (total / max) * height) : 0;
          const seg = (value: number) => (total > 0 ? `${(value / total) * 100}%` : "0%");
          const githubTotal = (point.githubAdditions ?? 0) + (point.githubDeletions ?? 0);
          const githubHeight = anyGithub && githubTotal > 0 ? Math.max(2, (githubTotal / max) * height) : 0;
          return (
            <div
              key={point.date}
              className="relative flex min-w-[3px] flex-1 items-end"
              onPointerEnter={(event) => tooltip.show(point, event.currentTarget)}
              onPointerLeave={tooltip.hide}
              onClick={(event) => tooltip.toggle(point, event.currentTarget)}
            >
              {githubHeight > 0 ? (
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t-[2px]"
                  style={{ height: githubHeight, background: `color-mix(in srgb, ${CODE_COLORS.github} 32%, transparent)` }}
                />
              ) : null}
              <span
                className="relative flex w-full flex-col-reverse overflow-hidden rounded-t-[2px]"
                style={{ height: barHeight, transition: reduced ? undefined : "height 160ms ease" }}
              >
                <span style={{ height: seg(point.insertions), background: CODE_COLORS.insertions }} />
                <span style={{ height: seg(point.deletions), background: CODE_COLORS.deletions }} />
              </span>
            </div>
          );
        })}
      </ChartFrame>
      )}
      <Legend
        items={[
          { color: CODE_COLORS.insertions, label: "Added" },
          { color: CODE_COLORS.deletions, label: "Removed" },
          ...(anyGithub ? [{ color: `color-mix(in srgb, ${CODE_COLORS.github} 45%, transparent)`, label: "GitHub" }] : []),
        ]}
      />
    </div>
  );
}

function ClientMix({ stats }: { stats: AdeUsageStats }) {
  const clients = (stats.clients ?? []).filter((client) => client.interactions > 0);
  const total = clients.reduce((sum, client) => sum + client.interactions, 0);
  const Icon = ({ client }: { client: AdeUsageClientSurface }) => {
    if (client === "mobile") return <DeviceMobile size={12} />;
    if (client === "tui") return <TerminalWindow size={12} />;
    if (client === "web") return <Globe size={12} />;
    return <Monitor size={12} />;
  };
  if (clients.length === 0) {
    return <TabEmptyHint message="No client activity in this range." />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-3">
      <div className="flex h-3 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--color-fg) 6%, transparent)" }}>
        {clients.map((client) => (
          <span
            key={client.client}
            style={{ width: `${(client.interactions / total) * 100}%`, background: CLIENT_COLORS[client.client] }}
            title={`${CLIENT_LABELS[client.client]}: ${client.interactions.toLocaleString()} actions`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-2">
        {clients.slice(0, 4).map((client) => (
          <div key={client.client} className="flex items-center gap-2 text-[10px]">
            <span className="flex" style={{ color: CLIENT_COLORS[client.client] }}>
              <Icon client={client.client} />
            </span>
            <span className="min-w-0 flex-1 truncate text-fg/70">{CLIENT_LABELS[client.client]}</span>
            <span className="text-fg/85">{Math.round((client.interactions / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-[10px] text-muted-fg">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty + loading states
// ---------------------------------------------------------------------------

function SkeletonChart({ height, bars }: { height: number; bars: number }) {
  const heights = useMemo(
    () => Array.from({ length: bars }, (_, index) => 0.3 + ((index * 37) % 60) / 100),
    [bars],
  );
  return (
    <div className="flex min-h-0 flex-1 items-end gap-[3px]" aria-label="Loading activity" aria-busy="true">
      {heights.map((fraction, index) => (
        <span
          key={index}
          className="flex-1 rounded-t-[2px]"
          style={{ height: Math.max(4, fraction * height), background: "color-mix(in srgb, var(--color-fg) 8%, transparent)" }}
        />
      ))}
    </div>
  );
}

function WarmEmpty({ height }: { height: number }) {
  const heights = [0.35, 0.55, 0.4, 0.7, 0.5, 0.62, 0.44, 0.58, 0.48, 0.66, 0.4, 0.54];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="flex w-full max-w-[220px] items-end gap-[3px] opacity-40" style={{ height: height * 0.6 }} aria-hidden="true">
        {heights.map((fraction, index) => (
          <span
            key={index}
            className="flex-1 rounded-t-[2px]"
            style={{ height: `${fraction * 100}%`, background: "color-mix(in srgb, var(--color-fg) 10%, transparent)" }}
          />
        ))}
      </div>
      <p className="max-w-[280px] text-[11px] text-muted-fg">
        Your activity will appear here after your first chat.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function TabRow({ tab, onTabChange }: { tab: ActivityTab; onTabChange: (tab: ActivityTab) => void }) {
  return (
    <div role="tablist" aria-label="Activity views" className="flex items-center gap-0.5">
      {TABS.map((value) => {
        const active = value === tab;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(value)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              active ? "bg-white/[0.08] text-fg" : "text-muted-fg hover:text-fg/85"
            }`}
          >
            {TAB_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}

function RangeControl({
  preset,
  onPresetChange,
  variant,
}: {
  preset: AdeUsageRangePreset;
  onPresetChange: (preset: AdeUsageRangePreset) => void;
  variant: "compact" | "full";
}) {
  if (variant === "compact") {
    return (
      <label className="relative flex items-center">
        <span className="sr-only">Time range</span>
        <select
          value={preset}
          onChange={(event) => onPresetChange(event.target.value as AdeUsageRangePreset)}
          aria-label="Time range"
          className="cursor-pointer appearance-none rounded-md border border-white/[0.08] bg-white/[0.03] py-1 pl-2 pr-6 text-[11px] font-medium text-fg/85 outline-none hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-white/20"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.preset} value={option.preset}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-1.5 text-muted-fg">▾</span>
      </label>
    );
  }
  return (
    <div className="flex items-center rounded-md bg-white/[0.035] p-0.5" role="group" aria-label="Time range">
      {RANGE_OPTIONS.map((option) => {
        const active = preset === option.preset;
        return (
          <button
            key={option.preset}
            type="button"
            aria-pressed={active}
            onClick={() => onPresetChange(option.preset)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              active ? "bg-white/[0.10] text-fg" : "text-muted-fg hover:text-fg/85"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifetime total / streak chip
// ---------------------------------------------------------------------------

/**
 * Shows the measured all-provider lifetime total on the all-time range. Other
 * ranges retain the streak chip because their token total is range-scoped.
 */
function useFooterChip(stats: AdeUsageStats | null): { icon: "trophy" | "fire"; label: string; fresh: boolean } | null {
  return useMemo(() => {
    if (!stats) return null;
    if (stats.range.preset === "all" && stats.summary.totalTokens > 0) {
      return {
        icon: "trophy",
        label: `${formatTokens(stats.summary.totalTokens)} lifetime tokens`,
        fresh: false,
      };
    }
    const streak = stats.summary.currentStreakDays ?? 0;
    if (streak >= 3) return { icon: "fire", label: `${streak}-day streak`, fresh: false };
    return null;
  }, [stats]);
}

function FooterChip({
  chip,
  reduced,
}: {
  chip: { icon: "trophy" | "fire"; label: string; fresh: boolean };
  reduced: boolean;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!chip.fresh || reduced || !ref.current) return;
    ref.current.animate?.(
      [
        { opacity: 0.4, transform: "scale(0.94)" },
        { opacity: 1, transform: "scale(1.04)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 620, easing: "ease-out" },
    );
  }, [chip.fresh, reduced]);
  return (
    <span
      ref={ref}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        color: "color-mix(in srgb, var(--color-accent) 70%, var(--color-fg))",
      }}
    >
      {chip.icon === "trophy" ? <Trophy size={11} weight="fill" /> : <Fire size={11} weight="fill" />}
      {chip.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

function ariaSummary(stats: AdeUsageStats | null, preset: AdeUsageRangePreset): string {
  const rangeLabel = RANGE_OPTIONS.find((option) => option.preset === preset)?.label ?? preset;
  if (!stats) return `Activity summary for ${rangeLabel}. Loading.`;
  return `Activity for ${rangeLabel}: ${formatTokens(stats.summary.totalTokens)} tokens, ${sessionsTotal(stats)} sessions, ${stats.summary.activeDays ?? 0} active days.`;
}

export function ActivityModule({
  stats,
  loading = false,
  variant = "full",
  preset,
  onPresetChange,
  showRangeControl = true,
  className = "",
}: {
  stats: AdeUsageStats | null;
  loading?: boolean;
  variant?: "compact" | "full";
  preset: AdeUsageRangePreset;
  onPresetChange?: (preset: AdeUsageRangePreset) => void;
  showRangeControl?: boolean;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [tab, setTab] = useState<ActivityTab>(() => readActivityPersisted().tab);
  const cardRef = useRef<HTMLElement | null>(null);
  const tooltip = useDayTooltip(cardRef);
  const chip = useFooterChip(stats);

  const compactMode = variant === "compact";
  const chartHeight = compactMode ? 84 : 132;
  const maxBars = compactMode ? 40 : 64;
  const chartPoints = useChartPoints(stats?.daily ?? [], maxBars);
  const hasActivity = (stats?.daily ?? []).some(dayHasActivity);

  const changeTab = useCallback((next: ActivityTab) => {
    setTab(next);
    tooltip.hide();
    persistActivityPatch({ tab: next });
  }, [tooltip]);

  const summary = stats?.summary;
  const activeDays = summary?.activeDays;

  let chart: React.ReactNode;
  if (loading && !stats) {
    chart = <SkeletonChart height={chartHeight} bars={compactMode ? 20 : 32} />;
  } else if (!stats) {
    chart = <WarmEmpty height={chartHeight} />;
  } else if (!hasActivity) {
    chart = <WarmEmpty height={chartHeight} />;
  } else if (tab === "activity") {
    chart = <ActivityHeatmap points={stats.daily} height={chartHeight} reduced={reduced} tooltip={tooltip} />;
  } else if (tab === "tokens") {
    chart = <TokenBars points={chartPoints} height={chartHeight} reduced={reduced} tooltip={tooltip} />;
  } else if (tab === "code") {
    chart = <CodeBars points={chartPoints} height={chartHeight} reduced={reduced} tooltip={tooltip} />;
  } else {
    chart = <ClientMix stats={stats} />;
  }

  return (
    <section
      ref={cardRef}
      className={`relative flex flex-col rounded-xl border ${compactMode ? "gap-2 px-3 py-2.5" : "gap-3 p-4"} ${className}`}
      style={{
        background: "color-mix(in srgb, var(--color-card) 92%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-border) 70%, transparent)",
      }}
      aria-label={ariaSummary(stats, preset)}
      data-activity-module
    >
      <div className="flex items-center justify-between gap-3">
        <TabRow tab={tab} onTabChange={changeTab} />
        {showRangeControl && onPresetChange ? (
          <RangeControl preset={preset} onPresetChange={onPresetChange} variant={variant} />
        ) : null}
      </div>

      <div
        role="tabpanel"
        aria-label={TAB_LABELS[tab]}
        className={`relative flex min-h-0 flex-col ${compactMode ? "min-h-[96px]" : "min-h-[148px]"}`}
      >
        {chart}
        {tooltip.tip ? <DayTooltip tip={tooltip.tip} /> : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--color-border) 55%, transparent)" }}>
        <span className="min-w-0 truncate text-[11px] text-muted-fg">
          {stats ? (
            <>
              <b className="font-semibold text-fg/85">{formatTokens(stats.summary.totalTokens)}</b> tokens
              {" · "}
              <b className="font-semibold text-fg/85">{compact(sessionsTotal(stats))}</b> sessions
              {activeDays != null ? (
                <>
                  {" · "}
                  <b className="font-semibold text-fg/85">{activeDays}</b> active {activeDays === 1 ? "day" : "days"}
                </>
              ) : null}
            </>
          ) : loading ? (
            "Loading activity…"
          ) : (
            "No activity yet"
          )}
        </span>
        {chip ? <FooterChip chip={chip} reduced={reduced} /> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Self-fetching wrapper for the new-chat surface (compact variant)
// ---------------------------------------------------------------------------

const workStatsCache = new Map<string, AdeUsageStats>();

export function WorkActivityModule() {
  const projectRoot = useAppStore(
    (state) => state.project?.rootPath ?? state.projectBinding?.rootPath ?? "project",
  );
  const [preset, setPreset] = useState<AdeUsageRangePreset>(() => readActivityPersisted().preset);
  const cacheKey = `${projectRoot}:${preset}`;
  const [stats, setStats] = useState<AdeUsageStats | null>(() => workStatsCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(!stats);
  const requestRef = useRef(0);

  const load = useCallback(async (key: string, nextPreset: AdeUsageRangePreset) => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    try {
      const result = await window.ade?.usage?.getAdeStats?.({ preset: nextPreset });
      if (!result || requestRef.current !== request) return;
      workStatsCache.set(key, result);
      setStats(result);
    } catch {
      // The composer stays available when stats are temporarily unavailable;
      // keep the last successful snapshot rather than surfacing an error here.
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cached = workStatsCache.get(cacheKey) ?? null;
    setStats(cached);
    setLoading(!cached);
    void load(cacheKey, preset);
  }, [cacheKey, load, preset]);

  // Pick up background ledger-refresh completions whenever they land, instead of
  // a capped retry loop.
  useEffect(() => {
    const unsubscribe = window.ade?.usage?.onUpdate?.(() => {
      void load(cacheKey, preset);
    });
    return () => unsubscribe?.();
  }, [cacheKey, load, preset]);

  const changePreset = useCallback((next: AdeUsageRangePreset) => {
    setPreset(next);
    persistActivityPatch({ preset: next });
  }, []);

  return (
    <ActivityModule
      stats={stats}
      loading={loading}
      variant="compact"
      preset={preset}
      onPresetChange={changePreset}
      className="w-full max-w-[640px]"
    />
  );
}
