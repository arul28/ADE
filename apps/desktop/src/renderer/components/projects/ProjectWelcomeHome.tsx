import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChartBar, GitMerge, GitPullRequest, Gauge, Pulse, type Icon } from "@phosphor-icons/react";
import type {
  AdeUsageDailyPoint,
  AdeUsageStats,
  GitHubPrListItem,
  GitHubPrSnapshot,
  PrSummary,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../../lib/prReadCache";
import { useAccountStatus } from "../../lib/account";
import { useAppStore } from "../../state/appStore";
import { usageProviderLogo } from "../terminals/ToolLogos";
import { providerColor } from "../usage/providerColors";
import { fillMissingDays } from "../usage/ActivityHeatmap";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { welcomeRelativeTime } from "./ProjectWelcomeWebRows";
import {
  RunningList,
  desktopMachineRows,
  openMachines,
  openUsageDetails,
  usageLevel,
  useRunningChats,
  useUsageGroups,
  webMachineRows,
  type MachineRow,
} from "./ProjectWelcomeSidePanels";

// ---------------------------------------------------------------------------
// The home screen's cards. The page is a dashboard that fits the window: each
// card answers one question at a glance — what is running, how much have I
// done, how much headroom is left and where, which pull requests need me — and
// links to the full surface instead of listing everything here.
//
// Cost: every card reads state the renderer already holds (the Activity
// stream, the usage snapshot subscription, the remote-runtime snapshot). The
// only extra read is one 30-day stats query on mount and on usage updates.
// Nothing here polls or animates.
// ---------------------------------------------------------------------------

function greetingFor(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatCompact(value: number): string {
  return COMPACT.format(value);
}

// ── hero ───────────────────────────────────────────────────────────

export function WelcomeHero({
  actions,
  runningCount,
  needsYouCount,
  machinesOnline,
  machinesTotal,
}: {
  actions: ReactNode;
  runningCount: number;
  needsYouCount: number;
  machinesOnline: number;
  machinesTotal: number;
}) {
  const { status } = useAccountStatus();
  const firstName = status.signedIn ? status.name?.trim().split(/\s+/)[0] || null : null;
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const working = runningCount - needsYouCount;
  const line =
    needsYouCount > 0
      ? `${needsYouCount} chat${needsYouCount === 1 ? " needs" : "s need"} you${working > 0 ? `, ${working} ${working === 1 ? "is" : "are"} working` : ""}.`
      : working > 0
        ? `${working} chat${working === 1 ? " is" : "s are"} working right now.`
        : "Nothing running. Pick up where you left off.";
  return (
    <header className="ade-home-hero">
      <div className="ade-home-hero-text">
        <div className="kit-eyebrow ade-home-eyebrow">
          {date}
          {machinesTotal > 1 ? ` · ${machinesOnline} of ${machinesTotal} machines online` : null}
        </div>
        <h1 className="ade-home-title">
          {greetingFor(now.getHours())}
          {firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="ade-home-line" data-tone={needsYouCount > 0 ? "attention" : undefined}>{line}</p>
      </div>
      <div className="ade-home-actions">{actions}</div>
    </header>
  );
}

export function HomeAction({
  icon: IconGlyph,
  label,
  onClick,
  primary,
  disabled,
  title,
  tour,
}: {
  icon: Icon;
  label: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  tour?: string;
}) {
  return (
    <button
      type="button"
      className="ade-home-action"
      data-primary={primary || undefined}
      data-tour={tour}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <IconGlyph size={14} weight={primary ? "bold" : "regular"} aria-hidden />
      <span className="ade-home-action-label">{label}</span>
    </button>
  );
}

// ── shared card head ───────────────────────────────────────────────

function CardHead({
  icon: IconGlyph,
  title,
  count,
  action,
  children,
}: {
  icon: Icon;
  title: string;
  count?: number | null;
  action?: { label: string; onClick: () => void } | null;
  children?: ReactNode;
}) {
  return (
    <div className="kit-card-head">
      <IconGlyph size={14} weight="regular" aria-hidden />
      <span>{title}</span>
      {count != null ? <span className="kit-card-head-count">{count}</span> : null}
      {children}
      {action ? (
        <button type="button" className="kit-card-head-action" onClick={action.onClick}>
          {action.label}
          <ArrowRight size={11} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ── working now ────────────────────────────────────────────────────

export function RunningCard({ onOpenActivity }: { onOpenActivity: () => void }) {
  const running = useRunningChats();
  if (running.length === 0) return null;
  return (
    <section className="kit-card ade-home-card ade-home-running" aria-label="Working now">
      <CardHead icon={Pulse} title="Working now" count={running.length} action={{ label: "Activity", onClick: onOpenActivity }} />
      <div className="kit-card-body ade-home-scroll" data-flush="true">
        <RunningList items={running} />
      </div>
    </section>
  );
}

// ── activity & usage ───────────────────────────────────────────────

const ACTIVITY_DAYS = 14;

export type RecentStats = AdeUsageStats | null | "unavailable";

/**
 * Usage stats for this machine, all time (the card slices the last 28 days);
 * null while loading. The first read can come back before the provider ledger
 * is complete, so a later usage update (the ledger landing) reloads it.
 */
export function useRecentStats(): RecentStats {
  const [stats, setStats] = useState<RecentStats>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const getStats = window.ade?.usage?.getAdeStats;
    if (!getStats) {
      setStats("unavailable");
      return;
    }
    const request = ++requestRef.current;
    try {
      // The same read the new-chat Activity card makes, so both agree and the
      // main process answers from one cache.
      const result = await getStats({ preset: "all" });
      if (requestRef.current === request) setStats(result ?? "unavailable");
    } catch {
      if (requestRef.current === request) setStats((current) => current ?? "unavailable");
    }
  }, []);
  useEffect(() => {
    void load();
    const unsubscribe = window.ade?.usage?.onUpdate?.(() => void load());
    return () => unsubscribe?.();
  }, [load]);
  return stats;
}

type Metric = "tokens" | "cost" | "code";
type DayBar = { date: string; sessions: number; tokens: number; cost: number; code: number };

function dayCost(day: AdeUsageDailyPoint): number {
  const providers = (day as { providers?: Record<string, { costUsd?: number }> }).providers;
  if (!providers) return 0;
  return Object.values(providers).reduce((sum, entry) => sum + (entry?.costUsd ?? 0), 0);
}

function lastDays(daily: readonly AdeUsageDailyPoint[], count: number): DayBar[] {
  const filled = fillMissingDays(daily);
  const bars = filled
    .slice(-count)
    .map((day) => ({
      date: day.date,
      sessions: day.sessions,
      tokens: day.totalTokens,
      cost: dayCost(day),
      code: (day.insertions ?? 0) + (day.deletions ?? 0),
    }));
  while (bars.length < count) bars.unshift({ date: "", sessions: 0, tokens: 0, cost: 0, code: 0 });
  return bars;
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function weekdayInitial(date: string): string {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "narrow" });
}

function formatMetric(metric: Metric, value: number): string {
  return metric === "cost" ? `$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}` : formatCompact(value);
}

const METRIC_UNIT: Record<Metric, string> = { tokens: "tokens", cost: "spent", code: "lines changed" };

export function ActivityUsageCard({ stats }: { stats: RecentStats }) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const daily = stats && stats !== "unavailable" ? stats.daily : null;
  const bars = useMemo(() => (daily ? lastDays(daily, ACTIVITY_DAYS) : []), [daily]);
  const previous = useMemo(() => (daily ? lastDays(daily, ACTIVITY_DAYS * 2).slice(0, ACTIVITY_DAYS) : []), [daily]);
  if (stats === "unavailable") return null;

  const value = (bar: DayBar) => bar[metric];
  const total = bars.reduce((sum, bar) => sum + value(bar), 0);
  const before = previous.reduce((sum, bar) => sum + value(bar), 0);
  const delta = before > 0 ? Math.round(((total - before) / before) * 100) : null;
  const max = Math.max(1e-9, ...bars.map(value));
  const busiest = bars.reduce<DayBar | null>((best, bar) => (!best || value(bar) > value(best) ? bar : best), null);
  const today = bars.at(-1);
  const summary = stats ? stats.summary : null;
  const todayCost = summary ? summary.observedProviderCostTodayUsd + (summary.adeRuntimeCostTodayUsd ?? 0) : 0;
  const streak = summary?.currentStreakDays ?? 0;

  return (
    <section className="kit-card ade-home-card ade-home-activity" aria-label="Activity and usage">
      <CardHead icon={ChartBar} title="Activity & usage" action={{ label: "Details", onClick: openUsageDetails }}>
        <span className="ade-home-card-scope" title="Usage recorded on this computer. Another machine's work shows once it is online and synced.">this machine</span>
        <div className="kit-seg ade-home-metric" role="group" aria-label="Measure">
          {(["tokens", "cost"] as Metric[]).map((option) => (
            <button key={option} type="button" aria-pressed={metric === option} onClick={() => setMetric(option)}>
              {option === "code" ? "Code" : option === "tokens" ? "Tokens" : "Cost"}
            </button>
          ))}
        </div>
      </CardHead>
      <div className="kit-card-body ade-home-activity-body">
        <div className="ade-home-activity-side">
          <div>
            <div className="kit-eyebrow">Last 14 days</div>
            <div className="ade-home-activity-figure">
              <span className="kit-stat">{stats ? formatMetric(metric, total) : "—"}</span>
            </div>
            <div className="ade-home-activity-unit">
              {METRIC_UNIT[metric]}
              {delta != null ? (
                <span className="kit-tag" data-tone={delta >= 0 ? "ok" : "warn"}>
                  {delta >= 0 ? "↑" : "↓"} {Math.abs(delta)}%
                </span>
              ) : null}
            </div>
          </div>
          <dl className="ade-home-facts">
            <div>
              <dt className="kit-eyebrow">Today</dt>
              <dd className="kit-num">{today ? formatCompact(today.tokens) : "—"} <span>tokens</span></dd>
            </div>
            <div>
              <dt className="kit-eyebrow">Spent today</dt>
              <dd className="kit-num">${todayCost.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="kit-eyebrow">Chats today</dt>
              <dd className="kit-num">{today?.sessions ?? 0}</dd>
            </div>
            <div>
              <dt className="kit-eyebrow">Streak</dt>
              <dd className="kit-num">{streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : "—"}</dd>
            </div>
          </dl>
        </div>
        <div className="ade-home-bars" role="img" aria-label={`${formatMetric(metric, total)} ${METRIC_UNIT[metric]} over the last 14 days`}>
          {bars.map((bar, index) => {
            const height = (value(bar) / max) * 100;
            const isToday = index === bars.length - 1;
            return (
              <div key={`${bar.date}-${index}`} className="ade-home-bar-col" title={bar.date ? `${dayLabel(bar.date)} · ${formatMetric(metric, value(bar))}` : undefined}>
                <div className="ade-home-bar-track">
                  <div
                    className="ade-home-bar"
                    data-today={isToday || undefined}
                    data-peak={bar === busiest && value(bar) > 0 ? true : undefined}
                    style={{ height: `${Math.max(value(bar) > 0 ? 3 : 0, height)}%` }}
                  />
                </div>
                <span className="ade-home-bar-label">{weekdayInitial(bar.date)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── limits & machines ──────────────────────────────────────────────

function Ring({ percentLeft, color }: { percentLeft: number; color: string }) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75;
  const filled = (arc * Math.max(0, Math.min(100, percentLeft))) / 100;
  return (
    <svg viewBox="0 0 44 44" className="ade-home-ring" aria-hidden>
      <circle cx="22" cy="22" r={radius} className="ade-home-ring-track" strokeDasharray={`${arc} ${circumference}`} transform="rotate(135 22 22)" />
      <circle
        cx="22"
        cy="22"
        r={radius}
        className="ade-home-ring-fill"
        style={{ stroke: color }}
        strokeDasharray={`${filled} ${circumference}`}
        transform="rotate(135 22 22)"
      />
    </svg>
  );
}

function compactReset(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

export function useMachineRows(
  webMode: boolean,
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null,
  webMachines: readonly WebMachineEntry[],
): MachineRow[] {
  return useMemo(
    () => (webMode ? webMachineRows(webMachines) : desktopMachineRows(remoteSnapshot)),
    [remoteSnapshot, webMachines, webMode],
  );
}

const MACHINE_STATE_LABEL: Record<MachineRow["dot"], string> = {
  online: "Online",
  busy: "Connecting",
  available: "Available",
  offline: "Offline",
};

export function LimitsMachinesCard({ machineRows, webMode }: { machineRows: MachineRow[]; webMode: boolean }) {
  const usage = useUsageGroups();
  const theme = useAppStore((s) => s.theme);
  const machines = machineRows.length > 0
    ? machineRows
    : [{ key: "this-machine", name: "This machine", dot: "online" as const, detail: "Running ADE" }];
  const rings = usage.groups.map((group) => {
    const tightest = group.lines.reduce((best, line) => (line.percentLeft < best.percentLeft ? line : best), group.lines[0]!);
    return { provider: group.provider, line: tightest, accounts: group.lines.length };
  });
  return (
    <section className="kit-card ade-home-card ade-home-limits" aria-label="Limits and machines">
      <CardHead icon={Gauge} title="Limits & machines" action={{ label: "Details", onClick: openUsageDetails }} />
      <div className="kit-card-body ade-home-limits-body">
        {usage.bridgeMissing ? null : (
          <div className="ade-home-rings">
            {rings.length === 0 ? (
              <span className="ade-home-muted">{usage.loaded ? "No provider limits reported yet." : "Reading limits…"}</span>
            ) : (
              rings.map(({ provider, line, accounts }) => {
                const Logo = usageProviderLogo(provider);
                const left = Math.round(Math.max(0, Math.min(100, line.percentLeft)));
                const level = usageLevel(left);
                const color = level === "crit" ? "var(--kit-crit)" : level === "warn" ? "var(--kit-warn)" : providerColor(provider, theme);
                return (
                  <button key={provider} type="button" className="ade-home-ring-item" onClick={openUsageDetails} title={line.title}>
                    <span className="ade-home-ring-wrap">
                      <Ring percentLeft={left} color={color} />
                      <span className="ade-home-ring-logo"><Logo size={14} /></span>
                    </span>
                    <span className="ade-home-ring-value kit-num" data-level={level}>{left}%</span>
                    <span className="ade-home-ring-name">
                      {line.providerLabel}
                      {accounts > 1 ? ` ×${accounts}` : ""}
                    </span>
                    <span className="ade-home-ring-reset kit-num">resets {compactReset(line.resetsInMs)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
        <div className="ade-home-machine-list" role="list" aria-label="Machines">
          {machines.map((row) => (
            <button
              key={row.key}
              type="button"
              role="listitem"
              className="ade-home-machine-row"
              data-state={row.dot}
              onClick={() => openMachines(webMode)}
              title={`${row.name} — ${row.detail}`}
            >
              <span className="ade-home-machine-name">{row.name}</span>
              <span className="ade-home-machine-detail">{row.dot === "online" ? row.detail : null}</span>
              <span className="ade-home-machine-state" data-state={row.dot}>{MACHINE_STATE_LABEL[row.dot]}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── pull requests ──────────────────────────────────────────────────

type PrBucket = "failing" | "changes" | "review" | "pending" | "ready" | "draft" | "open" | "merged" | "closed";

const PR_BUCKET: Record<PrBucket, { order: number; label: string; tone?: "ok" | "warn" | "crit" }> = {
  failing: { order: 0, label: "Checks failing", tone: "crit" },
  changes: { order: 1, label: "Changes asked", tone: "warn" },
  review: { order: 2, label: "In review", tone: "warn" },
  pending: { order: 3, label: "Checks running" },
  ready: { order: 4, label: "Ready", tone: "ok" },
  open: { order: 5, label: "Open" },
  draft: { order: 6, label: "Draft" },
  merged: { order: 7, label: "Merged" },
  closed: { order: 8, label: "Closed" },
};

/** One row: a GitHub PR, with ADE's check/review rollup when a lane tracks it. */
type HomePr = {
  id: string;
  number: number;
  title: string;
  repo: string;
  state: GitHubPrListItem["state"];
  isDraft: boolean;
  updatedAt: string;
  mergedAt: string | null;
  author: string | null;
  laneName: string | null;
  additions: number | null;
  deletions: number | null;
  tracked: PrSummary | null;
};

function prBucket(pr: HomePr): PrBucket {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  const tracked = pr.tracked;
  if (tracked?.checksStatus === "failing") return "failing";
  if (tracked?.reviewStatus === "changes_requested") return "changes";
  if (pr.isDraft || pr.state === "draft") return "draft";
  if (tracked?.checksStatus === "pending") return "pending";
  if (tracked?.reviewStatus === "requested") return "review";
  if (tracked && (tracked.checksStatus === "passing" || tracked.reviewStatus === "approved")) return "ready";
  return "open";
}

const RECENT_PR_WINDOW_MS = 7 * 86_400_000;

/**
 * The open project's pull requests, straight from GitHub: the same snapshot
 * the PRs tab reads (main refetches open PRs once they are two minutes old and
 * closed history after ten), joined to ADE's tracked PRs for checks and review
 * state. Reloads on PR
 * events and when the window regains focus — never on a timer of its own.
 */
function usePullRequests(projectRoot: string | null): { open: HomePr[]; recent: HomePr[]; loaded: boolean; viewer: string | null } {
  const [data, setData] = useState<{ snapshot: GitHubPrSnapshot | null; tracked: PrSummary[] } | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    const bridge = window.ade?.prs;
    if (!projectRoot || !bridge?.getGitHubSnapshot) {
      setData({ snapshot: null, tracked: [] });
      return undefined;
    }
    let timer: number | null = null;
    const load = async () => {
      const request = ++requestRef.current;
      const [snapshot, tracked] = await Promise.all([
        // One page of closed history (cached ten minutes in main) brings the
        // week's merges with it; open PRs come in the same snapshot.
        getGitHubSnapshotCoalesced({ automaticRefresh: true, includeExternalClosed: true, historyPageLimit: 1 }, { projectRoot }).catch(() => null),
        listPrsCoalesced({ projectRoot }).catch(() => [] as PrSummary[]),
      ]);
      if (requestRef.current === request) setData({ snapshot, tracked: tracked ?? [] });
    };
    const soon = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 1000);
    };
    void load();
    // PR events arrive in bursts during a sync; one reload per quiet second.
    const unsubscribe = bridge.onEvent?.(soon);
    window.addEventListener("focus", soon);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener("focus", soon);
    };
  }, [projectRoot]);
  return useMemo(() => {
    const snapshot = data?.snapshot ?? null;
    const trackedById = new Map((data?.tracked ?? []).map((pr) => [pr.id, pr]));
    const items = snapshot ? [...snapshot.repoPullRequests, ...snapshot.externalPullRequests] : [];
    const seen = new Set<string>();
    const prs: HomePr[] = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      prs.push({
        id: item.id,
        number: item.githubPrNumber,
        title: item.title,
        repo: item.scope === "external" ? `${item.repoOwner}/${item.repoName}` : item.repoName,
        state: item.state,
        isDraft: item.isDraft,
        updatedAt: item.updatedAt,
        mergedAt: item.mergedAt ?? null,
        author: item.author,
        laneName: item.linkedLaneName,
        additions: item.additions ?? null,
        deletions: item.deletions ?? null,
        tracked: item.linkedPrId ? trackedById.get(item.linkedPrId) ?? null : null,
      });
    }
    const viewer = snapshot?.viewerLogin ?? null;
    // Yours first among open PRs: what you authored or a lane of yours tracks.
    const mine = (pr: HomePr) => (pr.tracked != null || (viewer != null && pr.author === viewer) ? 0 : 1);
    const open = prs
      .filter((pr) => pr.state === "open" || pr.state === "draft")
      .sort((a, b) => (mine(a) - mine(b)) || (PR_BUCKET[prBucket(a)].order - PR_BUCKET[prBucket(b)].order) || b.updatedAt.localeCompare(a.updatedAt));
    const cutoff = Date.now() - RECENT_PR_WINDOW_MS;
    const recent = prs
      .filter((pr) => pr.state === "merged" && Date.parse(pr.mergedAt || pr.updatedAt) >= cutoff)
      .sort((a, b) => (b.mergedAt || b.updatedAt).localeCompare(a.mergedAt || a.updatedAt));
    return { open, recent, loaded: data != null, viewer };
  }, [data]);
}

/** GitHub's own state colours, as a `data-state` the stylesheet maps per theme. */
function prState(pr: HomePr): "open" | "draft" | "merged" | "closed" {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.isDraft || pr.state === "draft") return "draft";
  return "open";
}

function PrAuthor({ login }: { login: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!login || failed) return <span className="ade-home-pr-avatar" data-fallback="true">{login?.slice(0, 1).toUpperCase() ?? "?"}</span>;
  return (
    <img
      className="ade-home-pr-avatar"
      src={`https://avatars.githubusercontent.com/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}?size=40`}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function PullRequestRow({ pr, onOpen }: { pr: HomePr; onOpen?: () => void }) {
  const bucket = PR_BUCKET[prBucket(pr)];
  const state = prState(pr);
  const settled = state === "merged" || state === "closed";
  const when = welcomeRelativeTime(settled ? pr.mergedAt || pr.updatedAt : pr.updatedAt);
  const tracked = pr.tracked;
  const StateIcon = state === "merged" ? GitMerge : GitPullRequest;
  return (
    <button
      type="button"
      role="listitem"
      className="kit-row ade-home-pr-row"
      data-settled={settled || undefined}
      onClick={onOpen}
      title={tracked?.checksReason ? `${pr.title} — ${tracked.checksReason}` : pr.title}
    >
      <span className="ade-home-pr-icon" data-state={state} aria-label={state}>
        <StateIcon size={14} weight="bold" />
      </span>
      <span className="ade-home-pr-text">
        <span className="ade-home-pr-title">{pr.title}</span>
        <span className="ade-home-pr-sub">
          <PrAuthor login={pr.author} />
          <span className="kit-num">
            #{pr.number}
            {pr.laneName ? ` · ${pr.laneName}` : pr.author ? ` · ${pr.author}` : ""}
            {when ? ` · ${when}` : ""}
          </span>
          {!settled && pr.additions != null ? (
            <span className="kit-num ade-home-pr-diff">
              <i>+{pr.additions}</i> <b>−{pr.deletions ?? 0}</b>
            </span>
          ) : null}
        </span>
      </span>
      <span className="ade-home-pr-pill" data-tone={settled ? state : bucket.tone ?? state}>{bucket.label}</span>
    </button>
  );
}

export function PullRequestsCard({
  projectName,
  projectRoot,
  onOpenPrs,
}: {
  projectName: string | null;
  projectRoot: string | null;
  onOpenPrs?: () => void;
}) {
  const { open, recent, loaded } = usePullRequests(projectRoot);
  const counts = useMemo(() => {
    const result = { failing: 0, review: 0, ready: 0 };
    for (const pr of open) {
      const bucket = prBucket(pr);
      if (bucket === "failing") result.failing += 1;
      else if (bucket === "review" || bucket === "changes") result.review += 1;
      else if (bucket === "ready") result.ready += 1;
    }
    return result;
  }, [open]);
  return (
    <section className="kit-card ade-home-card ade-home-prs" aria-label="Pull requests">
      <CardHead icon={GitPullRequest} title="Pull requests" count={open.length > 0 ? open.length : null} action={onOpenPrs ? { label: "PRs", onClick: onOpenPrs } : null}>
        {projectName ? <span className="ade-home-card-scope">{projectName}</span> : null}
      </CardHead>
      <div className="kit-card-body ade-home-prs-body" data-flush="true">
        {projectRoot == null ? (
          <div className="ade-home-empty">
            <GitPullRequest size={18} aria-hidden />
            <span>Open a project to see its pull requests and checks.</span>
          </div>
        ) : (
          <>
            <dl className="ade-home-pr-stats">
              <div data-tone={counts.failing > 0 ? "crit" : undefined}><dd className="kit-num">{counts.failing}</dd><dt>failing</dt></div>
              <div data-tone={counts.review > 0 ? "warn" : undefined}><dd className="kit-num">{counts.review}</dd><dt>in review</dt></div>
              <div data-tone={counts.ready > 0 ? "ok" : undefined}><dd className="kit-num">{counts.ready}</dd><dt>ready</dt></div>
              <div><dd className="kit-num">{recent.length}</dd><dt>merged · 7d</dt></div>
            </dl>
            {open.length === 0 && recent.length === 0 ? (
              <div className="ade-home-empty">
                <GitPullRequest size={18} aria-hidden />
                <span>{loaded ? "No pull requests this week." : "Reading pull requests…"}</span>
              </div>
            ) : (
              <div className="ade-home-scroll" role="list">
                {open.map((pr) => <PullRequestRow key={pr.id} pr={pr} onOpen={onOpenPrs} />)}
                {recent.length > 0 ? <div className="kit-eyebrow ade-home-pr-divider">Merged this week</div> : null}
                {recent.map((pr) => <PullRequestRow key={pr.id} pr={pr} onOpen={onOpenPrs} />)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
