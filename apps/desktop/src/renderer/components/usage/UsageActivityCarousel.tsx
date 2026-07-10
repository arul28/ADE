import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  DeviceMobile,
  Globe,
  Monitor,
  TerminalWindow,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type {
  AdeUsageClientSurface,
  AdeUsageDailyPoint,
  AdeUsageRangePreset,
  AdeUsageStats,
} from "../../../shared/types";
import { formatTokens } from "../../lib/format";
import { useAppStore } from "../../state/appStore";

const STORAGE_KEY = "ade.stats.carousel.v1";
const CLIENT_COLORS: Record<AdeUsageClientSurface, string> = {
  desktop: "#8B7CFF",
  mobile: "#F472B6",
  tui: "#4ADE80",
  web: "#38BDF8",
  api: "#FBBF24",
};
const CLIENT_LABELS: Record<AdeUsageClientSurface, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tui: "ADE Code",
  web: "Web",
  api: "API",
};
const SLIDES = ["activity", "tokens", "code", "clients"] as const;
type Slide = (typeof SLIDES)[number];

const RANGE_OPTIONS: Array<{ preset: AdeUsageRangePreset; label: string }> = [
  { preset: "today", label: "Day" },
  { preset: "7d", label: "Week" },
  { preset: "30d", label: "Month" },
  { preset: "year", label: "Year" },
];

type PersistedState = { slide: Slide; preset: AdeUsageRangePreset };

function readPersistedState(): PersistedState {
  if (typeof localStorage === "undefined") return { slide: "activity", preset: "7d" };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<PersistedState>;
    return {
      slide: SLIDES.includes(parsed.slide as Slide) ? parsed.slide as Slide : "activity",
      preset: RANGE_OPTIONS.some((option) => option.preset === parsed.preset) ? parsed.preset! : "7d",
    };
  } catch {
    return { slide: "activity", preset: "7d" };
  }
}

function persistState(value: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Preferences are best-effort in hardened/private browser contexts.
  }
}

function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return Math.floor(value).toLocaleString();
}

function duration(value: number): string {
  const minutes = Math.max(0, Math.round(value / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function dayValue(point: AdeUsageDailyPoint): number {
  return point.totalTokens + point.sessions * 4_000 + (point.interactions ?? 0) * 1_500;
}

function ChartEmpty({ loading, label }: { loading?: boolean; label: string }) {
  return (
    <div className="flex h-[92px] items-center justify-center text-[11px] text-muted-fg/55">
      {loading ? (
        <div className="flex items-center gap-1.5" aria-label="Loading activity">
          {[0, 1, 2].map((index) => (
            <span key={index} className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-300/60" style={{ animationDelay: `${index * 130}ms` }} />
          ))}
        </div>
      ) : label}
    </div>
  );
}

function ActivityHeatmap({ points, compactMode }: { points: AdeUsageDailyPoint[]; compactMode: boolean }) {
  const cells = useMemo(() => {
    const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const max = Math.max(1, ...ordered.map(dayValue));
    return ordered.map((point) => ({
      point,
      intensity: Math.max(0, Math.min(1, dayValue(point) / max)),
    }));
  }, [points]);
  if (!cells.some(({ point }) => dayValue(point) > 0)) return <ChartEmpty label="Activity will appear after your first ADE session." />;

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center">
      <div
        className="grid w-full justify-start gap-[3px] overflow-hidden"
        style={{ gridAutoFlow: "column", gridTemplateRows: `repeat(7, ${compactMode ? 8 : 10}px)`, gridAutoColumns: compactMode ? 8 : 10 }}
        aria-label="ADE activity heatmap"
      >
        {cells.map(({ point, intensity }, index) => (
          <motion.span
            key={point.date}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.22, delay: Math.min(0.36, index * 0.006) }}
            className="rounded-[2px]"
            style={{
              background: intensity === 0
                ? "color-mix(in srgb, var(--color-fg) 7%, transparent)"
                : `color-mix(in srgb, #60A5FA ${Math.round(28 + intensity * 72)}%, var(--color-card))`,
            }}
            title={`${point.date}: ${formatTokens(point.totalTokens)} tokens · ${point.sessions} sessions · ${point.interactions ?? 0} actions`}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-muted-fg/45">
        <span>{cells[0]?.point.date.slice(5)}</span>
        <span>{compact(points.reduce((sum, point) => sum + point.sessions, 0))} sessions</span>
        <span>{cells.at(-1)?.point.date.slice(5)}</span>
      </div>
    </div>
  );
}

function BarChart({
  points,
  mode,
}: {
  points: AdeUsageDailyPoint[];
  mode: "tokens" | "code";
}) {
  const chartPoints = useMemo(() => {
    const source = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const maxBars = 48;
    if (source.length <= maxBars) return source;
    const size = Math.ceil(source.length / maxBars);
    const compacted: AdeUsageDailyPoint[] = [];
    for (let index = 0; index < source.length; index += size) {
      const chunk = source.slice(index, index + size);
      const last = chunk.at(-1);
      if (!last) continue;
      compacted.push({
        date: last.date,
        inputTokens: chunk.reduce((sum, point) => sum + point.inputTokens, 0),
        outputTokens: chunk.reduce((sum, point) => sum + point.outputTokens, 0),
        totalTokens: chunk.reduce((sum, point) => sum + point.totalTokens, 0),
        commits: chunk.reduce((sum, point) => sum + point.commits, 0),
        prs: chunk.reduce((sum, point) => sum + point.prs, 0),
        insertions: chunk.reduce((sum, point) => sum + point.insertions, 0),
        deletions: chunk.reduce((sum, point) => sum + point.deletions, 0),
        filesChanged: chunk.reduce((sum, point) => sum + point.filesChanged, 0),
        sessions: chunk.reduce((sum, point) => sum + point.sessions, 0),
        durationMs: chunk.reduce((sum, point) => sum + (point.durationMs ?? 0), 0),
        interactions: chunk.reduce((sum, point) => sum + (point.interactions ?? 0), 0),
      });
    }
    return compacted;
  }, [points]);
  const values = chartPoints.map((point) => mode === "tokens" ? point.totalTokens : point.insertions + point.deletions);
  const max = Math.max(1, ...values);
  if (!values.some((value) => value > 0)) return <ChartEmpty label={mode === "tokens" ? "No token usage in this range." : "No code movement in this range."} />;

  return (
    <div className="flex h-[104px] items-end gap-[3px] border-b border-white/[0.06] pt-2" aria-label={mode === "tokens" ? "Token usage chart" : "Code movement chart"}>
      {chartPoints.map((point, index) => {
        const primary = mode === "tokens" ? point.inputTokens : point.insertions;
        const secondary = mode === "tokens" ? point.outputTokens : point.deletions;
        const total = Math.max(0, primary + secondary);
        const height = Math.max(total > 0 ? 3 : 0, (total / max) * 92);
        const secondaryPct = total > 0 ? (secondary / total) * 100 : 0;
        return (
          <motion.div
            key={`${point.date}-${index}`}
            className="group relative min-w-[3px] flex-1 overflow-hidden rounded-t-[2px]"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height, opacity: 1 }}
            transition={{ duration: 0.45, delay: Math.min(0.4, index * 0.012), ease: [0.2, 0.8, 0.2, 1] }}
            style={{ background: mode === "tokens" ? "#3B82F6" : "#34D399" }}
            title={mode === "tokens"
              ? `${point.date}: ${formatTokens(primary)} input · ${formatTokens(secondary)} output`
              : `${point.date}: +${compact(primary)} · -${compact(secondary)}`}
          >
            <span
              className="absolute inset-x-0 bottom-0"
              style={{ height: `${secondaryPct}%`, background: mode === "tokens" ? "#A78BFA" : "#FB7185" }}
            />
          </motion.div>
        );
      })}
    </div>
  );
}

function ClientMix({ stats }: { stats: AdeUsageStats }) {
  const clients = (stats.clients ?? []).filter((client) => client.interactions > 0);
  const total = clients.reduce((sum, client) => sum + client.interactions, 0);
  if (!total) return <ChartEmpty label="Client mix starts tracking with your next action." />;
  const Icon = ({ client }: { client: AdeUsageClientSurface }) => {
    if (client === "mobile") return <DeviceMobile size={12} />;
    if (client === "tui") return <TerminalWindow size={12} />;
    if (client === "web") return <Globe size={12} />;
    return <Monitor size={12} />;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.05]">
        {clients.map((client) => (
          <motion.span
            key={client.client}
            initial={{ width: 0 }}
            animate={{ width: `${(client.interactions / total) * 100}%` }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            style={{ background: CLIENT_COLORS[client.client] }}
            title={`${CLIENT_LABELS[client.client]}: ${client.interactions.toLocaleString()} actions`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-2">
        {clients.slice(0, 4).map((client) => (
          <div key={client.client} className="flex items-center gap-2 text-[10px]">
            <span className="flex" style={{ color: CLIENT_COLORS[client.client] }}><Icon client={client.client} /></span>
            <span className="min-w-0 flex-1 truncate text-fg/65">{CLIENT_LABELS[client.client]}</span>
            <span className="font-mono text-fg/85">{Math.round((client.interactions / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function slideTitle(slide: Slide): { title: string; detail: string } {
  switch (slide) {
    case "tokens": return { title: "AI token flow", detail: "Input and output by day" };
    case "code": return { title: "Code movement", detail: "Additions and deletions" };
    case "clients": return { title: "Where you use ADE", detail: "Desktop, mobile, terminal, and web" };
    default: return { title: "ADE activity", detail: "Your daily rhythm" };
  }
}

export function UsageActivityCarousel({
  stats,
  loading = false,
  compactMode = false,
  preset: controlledPreset,
  onPresetChange,
  className = "",
}: {
  stats: AdeUsageStats | null;
  loading?: boolean;
  compactMode?: boolean;
  preset?: AdeUsageRangePreset;
  onPresetChange?: (preset: AdeUsageRangePreset) => void;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const initial = useMemo(readPersistedState, []);
  const [slide, setSlide] = useState<Slide>(initial.slide);
  const [internalPreset, setInternalPreset] = useState<AdeUsageRangePreset>(initial.preset);
  const [direction, setDirection] = useState(1);
  const preset = controlledPreset ?? internalPreset;
  const title = slideTitle(slide);
  const summary = stats?.summary;

  const changeSlide = useCallback((delta: number) => {
    const current = SLIDES.indexOf(slide);
    const next = SLIDES[(current + delta + SLIDES.length) % SLIDES.length]!;
    setDirection(delta >= 0 ? 1 : -1);
    setSlide(next);
    persistState({ slide: next, preset });
  }, [preset, slide]);

  const changePreset = useCallback((next: AdeUsageRangePreset) => {
    setInternalPreset(next);
    persistState({ slide, preset: next });
    onPresetChange?.(next);
  }, [onPresetChange, slide]);

  return (
    <section
      className={`relative overflow-hidden rounded-xl border border-white/[0.07] shadow-[0_18px_60px_rgba(0,0,0,0.16)] ${compactMode ? "px-3 py-2.5" : "p-4"} ${className}`}
      style={{ background: "color-mix(in srgb, var(--color-card) 88%, transparent)" }}
      data-usage-activity-carousel
    >
      <div className="pointer-events-none absolute -top-20 left-1/3 h-36 w-52 rounded-full bg-violet-500/[0.10] blur-3xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0 text-left">
          <div className="truncate text-[12px] font-semibold text-fg/90">{title.title}</div>
          <div className="mt-0.5 truncate text-[9px] text-muted-fg/50">{title.detail}</div>
        </div>
        <div className="flex shrink-0 items-center rounded-md bg-white/[0.035] p-0.5">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.preset}
              type="button"
              onClick={() => changePreset(option.preset)}
              className={`rounded px-1.5 py-1 text-[9px] font-medium transition-colors ${preset === option.preset ? "bg-white/[0.10] text-fg" : "text-muted-fg/55 hover:text-fg/80"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`relative mt-2 ${compactMode ? "min-h-[100px]" : "min-h-[120px]"}`}>
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={slide}
            custom={direction}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: direction * 28, filter: "blur(4px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: direction * -28, filter: "blur(4px)" }}
            transition={{ duration: reduceMotion ? 0.08 : 0.26, ease: [0.2, 0.8, 0.2, 1] }}
            className="absolute inset-0 flex min-h-0 flex-col"
          >
            {!stats ? <ChartEmpty loading={loading} label="Stats are unavailable." /> : null}
            {stats && slide === "activity" ? <ActivityHeatmap points={stats.daily} compactMode={compactMode} /> : null}
            {stats && slide === "tokens" ? <BarChart points={stats.daily} mode="tokens" /> : null}
            {stats && slide === "code" ? <BarChart points={stats.daily} mode="code" /> : null}
            {stats && slide === "clients" ? <ClientMix stats={stats} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="relative mt-1 flex items-center justify-between gap-3 border-t border-white/[0.05] pt-2">
        <button type="button" onClick={() => changeSlide(-1)} aria-label="Previous activity chart" className="rounded-md p-1 text-muted-fg/45 transition-colors hover:bg-white/[0.05] hover:text-fg">
          <CaretLeft size={13} />
        </button>
        <div className="flex min-w-0 items-center justify-center gap-4 text-center">
          <span className="text-[9px] text-muted-fg/50"><b className="font-mono text-fg/85">{formatTokens(summary?.totalTokens ?? 0)}</b> tokens</span>
          <span className="text-[9px] text-muted-fg/50"><b className="font-mono text-fg/85">{compact((summary?.chatSessions ?? 0) + (summary?.terminalSessions ?? 0))}</b> sessions</span>
          {!compactMode ? <span className="text-[9px] text-muted-fg/50"><b className="font-mono text-fg/85">{duration(summary?.trackedAdeDurationMs ?? 0)}</b> active</span> : null}
        </div>
        <button type="button" onClick={() => changeSlide(1)} aria-label="Next activity chart" className="rounded-md p-1 text-muted-fg/45 transition-colors hover:bg-white/[0.05] hover:text-fg">
          <CaretRight size={13} />
        </button>
      </div>
    </section>
  );
}

const workStatsCache = new Map<string, AdeUsageStats>();

export function WorkUsageActivityCarousel() {
  const projectRoot = useAppStore((state) => state.project?.rootPath ?? state.projectBinding?.rootPath ?? "project");
  const initial = useMemo(readPersistedState, []);
  const [preset, setPreset] = useState<AdeUsageRangePreset>(initial.preset);
  const cacheKey = `${projectRoot}:${preset}`;
  const [stats, setStats] = useState<AdeUsageStats | null>(() => workStatsCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(!stats);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    const cached = workStatsCache.get(cacheKey) ?? null;
    setStats(cached);
    setLoading(!cached);
    let retry: number | null = null;
    let retryCount = 0;

    const load = async () => {
      try {
        const result = await window.ade?.usage?.getAdeStats?.({ preset });
        if (!result || requestRef.current !== request) return;
        workStatsCache.set(cacheKey, result);
        setStats(result);
        if (result.freshness?.state === "refreshing" && retryCount < 2) {
          retryCount += 1;
          retry = window.setTimeout(() => void load(), 2_800);
        }
      } catch {
        // The composer stays available when remote stats are temporarily
        // unavailable; retain the last successful snapshot if there is one.
      } finally {
        if (requestRef.current === request) setLoading(false);
      }
    };
    void load();
    return () => {
      if (retry != null) window.clearTimeout(retry);
    };
  }, [cacheKey, preset]);

  return (
    <UsageActivityCarousel
      stats={stats}
      loading={loading}
      compactMode
      preset={preset}
      onPresetChange={setPreset}
      className="w-full max-w-[820px]"
    />
  );
}
