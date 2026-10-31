import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  DeviceMobile,
  Fire,
  Globe,
  Monitor,
  TerminalWindow,
  Trophy,
} from "@phosphor-icons/react";
import {
  normalizeAdeUsageClientSurface,
  type AdeUsageClientSummary,
  type AdeUsageClientSurface,
  type AdeUsageDailyPoint,
  type AdeUsageRangePreset,
  type AdeUsageStats,
} from "../../../shared/types";
import { formatCompact, formatDayShort, formatTokens } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { cn } from "../ui/cn";
import { AnchoredTooltip } from "../ui/AnchoredTooltip";
import {
  type ActivityInsight,
  dayHasActivity,
  describeActivityInsight,
} from "./activityIntensity";
import {
  ActivityHeatmap,
  HeatmapRampKey,
  computeHeatmapLayout,
  fillMissingDays,
  useHeatmapCells,
  weekAlignment,
} from "./ActivityHeatmap";
import { USAGE_OVERLAY_CLASS } from "./usageDesign";
import ContributionSkyline, { ContributionSkylineToggle, type ContributionDay } from "../ui/ContributionSkyline";
import { DAY_MS, dayMs, toKey } from "../ui/contributionSkylineModel";
import "./usageSurfaces.css";
import { fgTint } from "../lanes/laneDesignTokens";

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

// The home card's Activity view: the Home page's 3D contribution skyline, or
// the flat heat map. Machine-local, like the rest of this module's state.
const SKYLINE_VIEW_KEY = "ade.activity.module.skyline.v1";
type SkylineView = "2d" | "3d";

function readSkylineView(): SkylineView {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SKYLINE_VIEW_KEY) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

function persistSkylineView(view: SkylineView): void {
  try {
    localStorage.setItem(SKYLINE_VIEW_KEY, view);
  } catch {
    // Best-effort, like the module's other preferences.
  }
}

/** Days for the skyline: chats plus commits and PRs (git or GitHub, whichever saw more), as the Home widget counts them. */
function skylineDays(daily: readonly AdeUsageDailyPoint[]): ContributionDay[] {
  return daily.map((point) => {
    const commits = Math.max(point.commits, point.githubCommits ?? 0);
    const prs = Math.max(point.prs, point.githubPrs ?? 0);
    const parts = [
      point.sessions > 0 ? `${point.sessions} ${point.sessions === 1 ? "chat" : "chats"}` : null,
      commits > 0 ? `${commits} ${commits === 1 ? "commit" : "commits"}` : null,
      prs > 0 ? `${prs} ${prs === 1 ? "PR" : "PRs"}` : null,
      point.totalTokens > 0 ? `${formatCompact(point.totalTokens)} tokens` : null,
    ].filter(Boolean);
    // A day with only token usage (no chat row) still stands as a tower.
    const count = Math.max(point.sessions + commits + prs, point.totalTokens > 0 ? 1 : 0);
    return { date: point.date, count, detail: parts.length > 0 ? parts.join(" · ") : undefined };
  });
}

/**
 * Weeks the card's skyline spans: from a week before the first active day to
 * where the street ends (today, or a later reported day), 20 weeks at least
 * (the card is wide) and a year at most. A short history no longer sits as a
 * few towers at the far end of an empty year.
 */
function skylineWeeks(days: readonly ContributionDay[]): number {
  const active = days.filter((day) => day.count > 0).map((day) => dayMs(day.date));
  if (active.length === 0) return 53;
  const end = Math.max(dayMs(new Date()), ...days.map((day) => dayMs(day.date)));
  const span = Math.floor((end - Math.min(...active)) / DAY_MS / 7) + 2;
  return Math.max(20, Math.min(53, span));
}

/** Skyline band height on the home card: tall enough for the isometric rise, still a strip under the prompt. */
const SKYLINE_HEIGHT = 120;

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
// Formatting helpers
// ---------------------------------------------------------------------------

function sessionsTotal(stats: AdeUsageStats): number {
  return (stats.summary.chatSessions ?? 0) + (stats.summary.terminalSessions ?? 0);
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Series colours, all from theme tokens so dark, light and custom themes
 * follow. Colour is spent on the one series that matters per chart — output
 * tokens in the accent, additions and removals in the theme's success/error —
 * and the rest are steps of the foreground, so a three-part bar reads as
 * "the important part, the bulk, the cheap part" without a rainbow.
 */
type SeriesKey = "input" | "output" | "cache" | "insertions" | "deletions" | "github";

const SERIES_PALETTE: Record<SeriesKey, string> = {
  input: "color-mix(in srgb, var(--color-fg) 42%, transparent)",
  output: "var(--color-accent)",
  cache: "color-mix(in srgb, var(--color-fg) 14%, transparent)",
  insertions: "var(--color-success)",
  deletions: "var(--color-error)",
  github: "var(--color-fg)",
};

/** One hue in steps: the busiest client gets the full accent. */
const CLIENT_COLORS: Record<AdeUsageClientSurface, string> = {
  desktop: "var(--color-accent)",
  cli: "color-mix(in srgb, var(--color-accent) 66%, transparent)",
  mobile: "color-mix(in srgb, var(--color-accent) 46%, transparent)",
  web: "color-mix(in srgb, var(--color-accent) 32%, transparent)",
  api: "color-mix(in srgb, var(--color-fg) 35%, transparent)",
};

function clientColor(client: AdeUsageClientSurface): string {
  return CLIENT_COLORS[client];
}

const CLIENT_LABELS: Record<AdeUsageClientSurface, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  cli: "CLI",
  web: "Web",
  api: "API",
};

// ---------------------------------------------------------------------------
// Day tooltip
// ---------------------------------------------------------------------------

type TooltipState = { point: AdeUsageDailyPoint };

function useDayTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  // The bar or cell the tooltip is placed against.
  const targetRef = useRef<HTMLElement | null>(null);

  const show = useCallback((point: AdeUsageDailyPoint, target: HTMLElement) => {
    targetRef.current = target;
    setTip({ point });
  }, []);

  const toggle = useCallback((point: AdeUsageDailyPoint, target: HTMLElement) => {
    targetRef.current = target;
    setTip((prev) => (prev?.point.date === point.date ? null : { point }));
  }, []);

  const hide = useCallback(() => setTip(null), []);

  return { tip, targetRef, show, toggle, hide };
}

function DayTooltip({
  tip,
  targetRef,
  palette,
  onDismiss,
}: {
  tip: TooltipState;
  targetRef: React.RefObject<HTMLElement | null>;
  palette: Record<SeriesKey, string>;
  onDismiss: () => void;
}) {
  const { point } = tip;
  const code = point.insertions + point.deletions;
  // Placed against the window: inside the card, a tall bar's tooltip grew up
  // past the card's top edge and was cut off.
  return (
    <AnchoredTooltip
      open
      triggerRef={targetRef}
      side="top"
      remeasureKey={point.date}
      onDismiss={onDismiss}
      className={cn("pointer-events-none px-2.5 py-2 text-left", USAGE_OVERLAY_CLASS)}
      style={{ minWidth: 150 }}
    >
      <div className="kit-eyebrow">{formatDayShort(point.date)}</div>
      <div className="kit-num mt-1 flex flex-col gap-0.5 text-[11px] text-muted-fg">
        <span>{formatTokens(point.totalTokens)} tokens</span>
        <span>
          {formatTokens(point.inputTokens)} in · {formatTokens(point.outputTokens)} out
          {point.cachedTokens != null && point.cachedTokens > 0 ? ` · ${formatTokens(point.cachedTokens)} cache` : ""}
        </span>
        <span>{point.sessions} {point.sessions === 1 ? "session" : "sessions"}</span>
        {code > 0 ? (
          <span>
            <span style={{ color: palette.insertions }}>+{formatCompact(point.insertions)}</span>
            {" "}
            <span style={{ color: palette.deletions }}>-{formatCompact(point.deletions)}</span>
            {" lines"}
          </span>
        ) : null}
      </div>
    </AnchoredTooltip>
  );
}

// ---------------------------------------------------------------------------
// Chart primitives
// ---------------------------------------------------------------------------

/**
 * Fewest day slots a bar chart draws. A short history (a new install, the
 * Today or 7d range) padded out to two weeks reads as a timeline with a few
 * busy days, instead of two or three slabs stretched across the card.
 */
const MIN_BAR_SLOTS = 14;

/** Days drawn only to fill a short timeline: they carry no data, so no tooltip. */
const PADDING_DAYS = new WeakSet<AdeUsageDailyPoint>();

/** An empty day, `daysBefore` days before `date` (YYYY-MM-DD). */
function emptyDayBefore(date: string, daysBefore: number): AdeUsageDailyPoint {
  return {
    date: toKey(dayMs(date) - daysBefore * DAY_MS),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    sessions: 0,
  };
}

/** Downsamples a daily series so wide ranges stay legible as fixed-count bars. */
function useChartPoints(points: AdeUsageDailyPoint[], maxBars: number): AdeUsageDailyPoint[] {
  return useMemo(() => {
    const source = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const first = source[0];
    if (first && source.length < MIN_BAR_SLOTS) {
      const missing = MIN_BAR_SLOTS - source.length;
      const padding = Array.from({ length: missing }, (_, i) => emptyDayBefore(first.date, missing - i));
      for (const day of padding) PADDING_DAYS.add(day);
      return [...padding, ...source];
    }
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

/** Horizontal padding of the card, per variant — subtracted from the measured
 * slot to get the width the grid actually has, and added back to turn the
 * grid's natural width into a card width. */
const CARD_PADDING_X_COMPACT = 20;
const CARD_PADDING_X_FULL = 32;
/** Below this the tab row and the footer line start colliding, so a very short
 * range widens the card past its grid rather than squeezing the chrome. */
const MIN_CARD_WIDTH = 380;

/** Tracks a container's width so the heatmap can be sized from it. */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Muted, centered hint for a tab whose own series is empty while the module
 * has data on other tabs (so the global warm-empty state does not apply). */
function TabEmptyHint({ message }: { message: string }) {
  return (
    <div className="usage-tab-body usage-footnote flex min-h-0 flex-1 items-center justify-center text-center">
      {message}
    </div>
  );
}

function tokenLegendItems(points: AdeUsageDailyPoint[], palette: Record<SeriesKey, string>) {
  const anyCache = points.some((p) => (p.cachedTokens ?? 0) > 0);
  return [
    { color: palette.input, label: "Input" },
    { color: palette.output, label: "Output" },
    ...(anyCache ? [{ color: palette.cache, label: "Cache" }] : []),
  ];
}

function codeLegendItems(points: AdeUsageDailyPoint[], palette: Record<SeriesKey, string>) {
  const anyGithub = points.some((p) => (p.githubAdditions ?? 0) + (p.githubDeletions ?? 0) > 0);
  return [
    { color: palette.insertions, label: "Added" },
    { color: palette.deletions, label: "Removed" },
    ...(anyGithub ? [{ color: `color-mix(in srgb, ${palette.github} 22%, transparent)`, label: "GitHub" }] : []),
  ];
}

/** Hover and click open the day's tooltip; a padding day has none. */
function dayTooltipHandlers(point: AdeUsageDailyPoint, tooltip: ReturnType<typeof useDayTooltip>) {
  if (PADDING_DAYS.has(point)) return {};
  return {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => tooltip.show(point, event.currentTarget),
    onPointerLeave: tooltip.hide,
    onClick: (event: React.MouseEvent<HTMLElement>) => tooltip.toggle(point, event.currentTarget),
  };
}

function TokenBars({
  points,
  height,
  reduced,
  tooltip,
  palette,
  showLegend = true,
}: {
  showLegend?: boolean;
  points: AdeUsageDailyPoint[];
  height: number;
  reduced: boolean;
  tooltip: ReturnType<typeof useDayTooltip>;
  palette: Record<SeriesKey, string>;
}) {
  // Scaled to the same sum each bar draws (input + output + cache), so the
  // tallest bar meets the top of the band instead of overflowing it.
  const max = Math.max(1, ...points.map((p) => p.inputTokens + p.outputTokens + (p.cachedTokens ?? 0)));
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
          const barHeight = total > 0 ? Math.max(3, (total / max) * height) : EMPTY_DAY_TRACK;
          const seg = (value: number) => (total > 0 ? `${(value / total) * 100}%` : "0%");
          return (
            <div
              key={point.date}
              className="relative flex min-w-[3px] flex-1 flex-col-reverse overflow-hidden rounded-t-[2px]"
              style={{
                height: barHeight,
                background: total > 0 ? undefined : EMPTY_TILE_BG,
                transition: reduced ? undefined : "height 160ms ease",
              }}
              {...dayTooltipHandlers(point, tooltip)}
            >
              <span style={{ height: seg(point.inputTokens), background: palette.input }} />
              <span style={{ height: seg(point.outputTokens), background: palette.output }} />
              {anyCache ? <span style={{ height: seg(point.cachedTokens ?? 0), background: palette.cache }} /> : null}
            </div>
          );
        })}
      </ChartFrame>
      )}
      {showLegend ? <Legend items={tokenLegendItems(points, palette)} /> : null}
    </div>
  );
}

function CodeBars({
  points,
  height,
  reduced,
  tooltip,
  palette,
  showLegend = true,
}: {
  showLegend?: boolean;
  points: AdeUsageDailyPoint[];
  height: number;
  reduced: boolean;
  tooltip: ReturnType<typeof useDayTooltip>;
  palette: Record<SeriesKey, string>;
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
          const githubTotal = (point.githubAdditions ?? 0) + (point.githubDeletions ?? 0);
          const barHeight = total > 0 ? Math.max(3, (total / max) * height) : githubTotal > 0 ? 0 : EMPTY_DAY_TRACK;
          const seg = (value: number) => (total > 0 ? `${(value / total) * 100}%` : "0%");
          const githubHeight = anyGithub && githubTotal > 0 ? Math.max(2, (githubTotal / max) * height) : 0;
          return (
            <div
              key={point.date}
              className="relative flex min-w-[3px] flex-1 items-end"
              {...dayTooltipHandlers(point, tooltip)}
            >
              {githubHeight > 0 ? (
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t-[2px]"
                  style={{ height: githubHeight, background: `color-mix(in srgb, ${palette.github} 14%, transparent)` }}
                />
              ) : null}
              <span
                className="relative flex w-full flex-col-reverse overflow-hidden rounded-t-[2px]"
                style={{
                  height: barHeight,
                  background: total > 0 ? undefined : EMPTY_TILE_BG,
                  transition: reduced ? undefined : "height 160ms ease",
                }}
              >
                <span style={{ height: seg(point.insertions), background: palette.insertions }} />
                <span style={{ height: seg(point.deletions), background: palette.deletions }} />
              </span>
            </div>
          );
        })}
      </ChartFrame>
      )}
      {showLegend ? <Legend items={codeLegendItems(points, palette)} /> : null}
    </div>
  );
}

function ClientIcon({ client }: { client: AdeUsageClientSurface }) {
  if (client === "mobile") return <DeviceMobile size={13} />;
  if (client === "cli") return <TerminalWindow size={13} />;
  if (client === "web") return <Globe size={13} />;
  return <Monitor size={13} />;
}

/**
 * An older brain still reports the command line as `tui`; fold it into `cli`
 * so the legend never shows a client it has no label for.
 */
function mergeClientSurfaces(clients: AdeUsageClientSummary[]): AdeUsageClientSummary[] {
  const merged = new Map<AdeUsageClientSurface, AdeUsageClientSummary>();
  for (const row of clients) {
    const client = normalizeAdeUsageClientSurface(row.client);
    if (!client) continue;
    const prior = merged.get(client);
    merged.set(client, prior
      ? {
          ...prior,
          interactions: prior.interactions + row.interactions,
          activeDays: Math.max(prior.activeDays, row.activeDays),
          sessions: prior.sessions + row.sessions,
          lastActiveAt: [prior.lastActiveAt, row.lastActiveAt].filter(Boolean).sort().at(-1) ?? null,
        }
      : { ...row, client });
  }
  return [...merged.values()];
}

/**
 * Where the work happened: one thin stacked bar, then a two-column legend
 * where each client's icon, name and share sit together — no reading across
 * the card to match a label to its number.
 */
function ClientMix({ stats }: { stats: AdeUsageStats }) {
  const clients = mergeClientSurfaces(stats.clients ?? [])
    .filter((client) => client.interactions > 0)
    .sort((a, b) => b.interactions - a.interactions);
  const total = clients.reduce((sum, client) => sum + client.interactions, 0);
  if (clients.length === 0) {
    return <TabEmptyHint message="No client activity in this range." />;
  }
  return (
    <div className="usage-tab-body flex min-h-0 flex-1 flex-col justify-center gap-3">
      <div className="usage-split-bar" role="img" aria-label={clients.map((client) => `${CLIENT_LABELS[client.client]} ${Math.round((client.interactions / total) * 100)}%`).join(", ")}>
        {clients.map((client) => (
          <span
            key={client.client}
            style={{ flexGrow: client.interactions, flexBasis: 0, background: clientColor(client.client) }}
            title={`${CLIENT_LABELS[client.client]}: ${client.interactions.toLocaleString()} actions`}
          />
        ))}
      </div>
      <div className="usage-client-legend">
        {clients.slice(0, 4).map((client) => (
          <div
            key={client.client}
            className="usage-client-item"
            title={`${client.interactions.toLocaleString()} actions · ${client.activeDays} active days`}
          >
            <span className="flex" style={{ color: clientColor(client.client) }}>
              <ClientIcon client={client.client} />
            </span>
            <span>{CLIENT_LABELS[client.client]}</span>
            <b>{Math.round((client.interactions / total) * 100)}%</b>
          </div>
        ))}
      </div>
      {clients.length === 1 ? (
        // One client is a full bar that says little; say what it holds.
        <p className="usage-client-caption">{singleClientCaption(clients[0]!)}</p>
      ) : null}
    </div>
  );
}

function singleClientCaption(client: AdeUsageClientSummary): string {
  const actions = `${formatCompact(client.interactions)} ${client.interactions === 1 ? "action" : "actions"}`;
  const days = `${client.activeDays} active ${client.activeDays === 1 ? "day" : "days"}`;
  return `All in ${CLIENT_LABELS[client.client]}: ${actions} over ${days}`;
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="usage-mini-legend">
      {items.map((item) => (
        <span key={item.label}>
          <i style={{ background: item.color }} />
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
          style={{ height: Math.max(4, fraction * height), background: fgTint(8) }}
        />
      ))}
    </div>
  );
}

const EMPTY_BAR_HEIGHTS = [0.35, 0.55, 0.4, 0.7, 0.5, 0.62, 0.44, 0.58, 0.48, 0.66, 0.4, 0.54];
const EMPTY_GRID_COLUMNS = 14;
const EMPTY_GRID_ROWS = 7;
const EMPTY_TILE_BG = fgTint(8);
/** A day with nothing on it: a low track, so the timeline still reads. */
const EMPTY_DAY_TRACK = 2;

/**
 * A day with no data still has a shape. The activity tab previews the grid it
 * is about to fill, the bar tabs preview bars — so an empty module reads as a
 * waiting frame rather than a broken one.
 */
function WarmEmpty({ height, shape }: { height: number; shape: "grid" | "bars" }) {
  return (
    <div className="usage-tab-body flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      {shape === "grid" ? (
        <div
          className="grid opacity-50"
          style={{
            gap: 3,
            gridTemplateRows: `repeat(${EMPTY_GRID_ROWS}, 8px)`,
            gridTemplateColumns: `repeat(${EMPTY_GRID_COLUMNS}, 8px)`,
          }}
          aria-hidden="true"
        >
          {Array.from({ length: EMPTY_GRID_COLUMNS * EMPTY_GRID_ROWS }, (_, index) => (
            <span key={index} className="rounded-[2px]" style={{ background: EMPTY_TILE_BG }} />
          ))}
        </div>
      ) : (
        <div className="flex w-full max-w-[220px] items-end gap-[3px] opacity-40" style={{ height: height * 0.6 }} aria-hidden="true">
          {EMPTY_BAR_HEIGHTS.map((fraction, index) => (
            <span
              key={index}
              className="flex-1 rounded-t-[2px]"
              style={{ height: `${fraction * 100}%`, background: EMPTY_TILE_BG }}
            />
          ))}
        </div>
      )}
      <p className="usage-footnote max-w-[280px]">
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
    // The kit's quiet segmented track: one recessed strip, only the active tab
    // lifted, so the module never competes with the composer above it.
    <div role="tablist" aria-label="Activity views" className="kit-seg">
      {TABS.map((value) => {
        const active = value === tab;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onTabChange(value)}
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
          className="usage-range-select"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.preset} value={option.preset}>
              {option.label}
            </option>
          ))}
        </select>
        <CaretDown size={9} weight="bold" className="pointer-events-none absolute right-2 text-muted-fg" />
      </label>
    );
  }
  return (
    <div className="kit-seg" role="group" aria-label="Time range">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.preset}
          type="button"
          aria-pressed={preset === option.preset}
          onClick={() => onPresetChange(option.preset)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline fact
// ---------------------------------------------------------------------------

/** Turns the derived insight into one short sentence, value emphasised. */
function InsightLine({ insight }: { insight: ActivityInsight }) {
  let lead: string;
  let value: string;
  let trail = "";

  if (insight.kind === "record") {
    lead = insight.weeks == null ? "Your busiest day " : "Busiest day in ";
    value = insight.weeks == null ? "so far" : `${insight.weeks} weeks`;
  } else if (insight.kind === "trend") {
    const up = insight.percent > 0;
    lead = "This week ";
    value = `${up ? "+" : "−"}${Math.abs(insight.percent)}%`;
    trail = " vs last week";
  } else {
    lead = "Busiest day ";
    value = formatDayShort(insight.date);
  }

  return (
    <p className="usage-activity-insight">
      {lead}
      <b>{value}</b>
      {trail}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Lifetime total / streak chip
// ---------------------------------------------------------------------------

/**
 * Shows the measured all-provider lifetime total on the all-time range. Other
 * ranges retain the streak chip because their token total is range-scoped.
 */
function useFooterChip(
  stats: AdeUsageStats | null,
): { icon: "trophy" | "fire"; label: string; title?: string; fresh: boolean } | null {
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
    // The streak is a lifetime run, not a run within the selected range — the
    // host stopped range-filtering it precisely so the number would not change
    // when the filter did. The label stays short; the distinction lives in the
    // tooltip, because "streak" already reads as an unbroken run to date and
    // spelling it out in the chip would crowd the footer it shares.
    if (streak >= 3) {
      return {
        icon: "fire",
        label: `${streak}-day streak`,
        title: `${streak} days in a row with activity, counted across all time — not just this range.`,
        fresh: false,
      };
    }
    return null;
  }, [stats]);
}

function FooterChip({
  chip,
  reduced,
}: {
  chip: { icon: "trophy" | "fire"; label: string; title?: string; fresh: boolean };
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
      title={chip.title}
      className="usage-chip"
    >
      {chip.icon === "trophy" ? <Trophy size={10} weight="fill" /> : <Fire size={10} weight="fill" />}
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
  fillSlot = false,
}: {
  stats: AdeUsageStats | null;
  loading?: boolean;
  variant?: "compact" | "full";
  preset: AdeUsageRangePreset;
  onPresetChange?: (preset: AdeUsageRangePreset) => void;
  showRangeControl?: boolean;
  className?: string;
  /** Stretch the card to the full slot instead of hugging the heatmap. */
  fillSlot?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const palette = SERIES_PALETTE;
  const [tab, setTab] = useState<ActivityTab>(() => readActivityPersisted().tab);
  const [skylineView, setSkylineView] = useState<SkylineView>(readSkylineView);
  const changeSkylineView = useCallback((next: SkylineView) => {
    setSkylineView(next);
    persistSkylineView(next);
  }, []);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const tooltip = useDayTooltip();
  const chip = useFooterChip(stats);

  const compactMode = variant === "compact";
  // The compact card sits under the composer and must stay a quiet strip:
  // a 64px band holds a 7-row grid of 7px cells exactly.
  const chartHeight = compactMode ? 54 : 124;
  const heatmapMaxCell = compactMode ? 6 : 16;
  const maxBars = compactMode ? 60 : 64;
  const chartPoints = useChartPoints(stats?.daily ?? [], maxBars);
  // Date-complete, like the grid below it.
  //
  // `describeActivityInsight` reads its week-over-week windows positionally
  // (`scores.slice(-7)` against `slice(-14, -7)`) and counts a record streak in
  // array steps, so on a series with gaps "the last seven entries" is not "the
  // last seven days" — the headline sentence and the heatmap it sits above were
  // computed from two different shapes of the same range. `useHeatmapCells`
  // already fills the gaps; this hands the sentence the same series.
  // Sorted first: `fillMissingDays` walks the series in order, and on the `all`
  // preset the host appends out-of-order dates after the skeleton.
  const daily = useMemo(
    () => fillMissingDays([...(stats?.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date))),
    [stats?.daily],
  );
  const hasActivity = daily.some(dayHasActivity);
  const insight = useMemo(
    () => (hasActivity ? describeActivityInsight(daily) : null),
    [daily, hasActivity],
  );

  // The card is sized to the heatmap rather than stretched to the slot: a
  // ~53-column grid of 13px cells simply does not fill 820px, and the leftover
  // was showing up as dead space along the card's right edge. Measuring the
  // slot (always full width) instead of the card keeps this off a resize loop.
  const cardPaddingX = compactMode ? CARD_PADDING_X_COMPACT : CARD_PADDING_X_FULL;
  const slotWidth = useMeasuredWidth(slotRef);
  const heatmapCells = useHeatmapCells(stats?.daily ?? []);
  const heatmapAlign = useMemo(() => weekAlignment(heatmapCells), [heatmapCells]);
  const heatmapLayout = useMemo(
    () => computeHeatmapLayout({
      cellCount: heatmapCells.length,
      maxCell: heatmapMaxCell,
      availableWidth: slotWidth > 0 ? Math.max(0, slotWidth - cardPaddingX) : 0,
      leading: heatmapAlign.leading,
      trailing: heatmapAlign.trailing,
      gap: compactMode ? 2 : undefined,
    }),
    [heatmapCells.length, heatmapAlign, heatmapMaxCell, slotWidth, cardPaddingX, compactMode],
  );
  // Held across tabs so switching to Tokens does not resize the card underneath
  // the pointer; the bar charts just fill whatever width the heatmap earned.
  // `fillSlot` hands width to the caller: the new-chat surface lines the card
  // up with the launch shelf above it, and the heatmap centres inside.
  const cardWidth = fillSlot
    ? "100%"
    : slotWidth > 0 && heatmapLayout.width > 0
    ? Math.min(slotWidth, Math.max(MIN_CARD_WIDTH, heatmapLayout.width + cardPaddingX))
    : undefined;

  const changeTab = useCallback((next: ActivityTab) => {
    setTab(next);
    tooltip.hide();
    persistActivityPatch({ tab: next });
  }, [tooltip]);

  const summary = stats?.summary;
  const activeDays = summary?.activeDays;

  // The heatmap is the one view whose height is content-derived, so it opts out
  // of the reserved chart band the fixed-height bar charts still need.
  const heatmapView = tab === "activity" && stats != null && hasActivity;
  // Only the new-chat card (`fillSlot`) offers the skyline; Settings keeps its heat map.
  const skylineOffered = fillSlot && heatmapView;
  const showSkyline = skylineOffered && skylineView === "3d";
  const skyDays = useMemo(() => (skylineOffered ? skylineDays(daily) : []), [daily, skylineOffered]);

  let chart: React.ReactNode;
  const emptyShape = tab === "activity" ? "grid" : "bars";
  if (loading && !stats) {
    chart = <SkeletonChart height={chartHeight} bars={compactMode ? 20 : 32} />;
  } else if (!stats) {
    chart = <WarmEmpty height={chartHeight} shape={emptyShape} />;
  } else if (!hasActivity) {
    chart = <WarmEmpty height={chartHeight} shape={emptyShape} />;
  } else if (showSkyline) {
    chart = (
      <div className="usage-activity-skyline" style={{ height: SKYLINE_HEIGHT }}>
        <ContributionSkyline
          data={skyDays}
          maxWeeks={skylineWeeks(skyDays)}
          view="3d"
          showToggle={false}
          showStats={false}
          showLegend={false}
          unit="contribution"
        />
      </div>
    );
  } else if (tab === "activity") {
    chart = <ActivityHeatmap cells={heatmapCells} layout={heatmapLayout} reduced={reduced} tooltip={tooltip} showKey={!compactMode} gap={compactMode ? 2 : undefined} />;
  } else if (tab === "tokens") {
    chart = <TokenBars points={chartPoints} height={chartHeight} reduced={reduced} tooltip={tooltip} palette={palette} showLegend={!compactMode} />;
  } else if (tab === "code") {
    chart = <CodeBars points={chartPoints} height={chartHeight} reduced={reduced} tooltip={tooltip} palette={palette} showLegend={!compactMode} />;
  } else {
    chart = <ClientMix stats={stats} />;
  }

  return (
    <div ref={slotRef} className={`flex justify-center ${className}`}>
      <section
        ref={cardRef}
        className="kit-card usage-activity max-w-full"
        data-variant={variant}
        style={{ width: cardWidth }}
        aria-label={ariaSummary(stats, preset)}
        data-activity-module
      >
        <div className="usage-activity-head">
          <TabRow tab={tab} onTabChange={changeTab} />
          {compactMode && insight ? <InsightLine insight={insight} /> : null}
          {skylineOffered ? (
            <ContributionSkylineToggle className="usage-activity-view" view={skylineView} onChange={changeSkylineView} />
          ) : null}
          {showRangeControl && onPresetChange ? (
            <RangeControl preset={preset} onPresetChange={onPresetChange} variant={variant} />
          ) : null}
        </div>

        {!compactMode && insight ? <InsightLine insight={insight} /> : null}

        <div
          role="tabpanel"
          aria-label={TAB_LABELS[tab]}
          className={`relative flex min-h-0 flex-col ${
            heatmapView ? "" : compactMode ? "min-h-[54px]" : "min-h-[140px]"
          }`}
        >
          {chart}
          {tooltip.tip ? <DayTooltip tip={tooltip.tip} targetRef={tooltip.targetRef} palette={palette} onDismiss={tooltip.hide} /> : null}
        </div>

        <div className="usage-activity-foot">
          <span className="usage-activity-foot-line">
            {stats ? (
              <>
                <b>{formatTokens(stats.summary.totalTokens)}</b> tokens
                {" · "}
                <b>{formatCompact(sessionsTotal(stats))}</b> sessions
                {activeDays != null ? (
                  <>
                    {" · "}
                    <b>{activeDays}</b> active {activeDays === 1 ? "day" : "days"}
                  </>
                ) : null}
              </>
            ) : loading ? (
              "Loading activity…"
            ) : (
              "No activity yet"
            )}
          </span>
          {compactMode ? (
            stats && hasActivity ? (
              tab === "activity" ? (showSkyline ? null : <HeatmapRampKey />)
                : tab === "tokens" ? <Legend items={tokenLegendItems(chartPoints, palette)} />
                  : tab === "code" ? <Legend items={codeLegendItems(chartPoints, palette)} />
                    : chip ? <FooterChip chip={chip} reduced={reduced} /> : null
            ) : null
          ) : chip ? <FooterChip chip={chip} reduced={reduced} /> : null}
        </div>
      </section>
    </div>
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

  // Width is the launch-shelf slot the parent gives this module, and the card
  // fills it so its edges line up with the shelf above.
  return (
    <ActivityModule
      stats={stats}
      loading={loading}
      variant="compact"
      preset={preset}
      onPresetChange={changePreset}
      className="mt-8 w-full"
      fillSlot
    />
  );
}
