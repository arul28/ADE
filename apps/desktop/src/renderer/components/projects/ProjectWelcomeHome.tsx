import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartBar, GitMerge, GitPullRequest, Gauge, Pulse, type Icon } from "@phosphor-icons/react";
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
import { usageLeftLevel, usageLeftLevelColor } from "../usage/usageDesign";
import { fillMissingDays } from "../usage/ActivityHeatmap";
import { dayMetric } from "../usage/UsageWeekCompare";
import { formatCountdownShort } from "../usage/usageWindowFormat";
import { formatCompact } from "../../lib/format";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { welcomeRelativeTime } from "./ProjectWelcomeWebRows";
import { FitList } from "../home/HomeFitList";
import type { HomeHeadline } from "../home/homeHeadline";
import {
  RunningList,
  WelcomeCardHead,
  desktopMachineRows,
  openMachines,
  openUsageDetails,
  useRunningChats,
  webMachineRows,
  type MachineRow,
  type UsageGroup,
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


// ── hero ───────────────────────────────────────────────────────────

export function WelcomeHero({
  actions,
  headline,
  onHeadline,
  machinesOnline,
  machinesTotal,
}: {
  actions: ReactNode;
  /** The data-built line under the greeting; null while its sources load. */
  headline: HomeHeadline | null;
  onHeadline?: (target: NonNullable<HomeHeadline["target"]>) => void;
  machinesOnline: number;
  machinesTotal: number;
}) {
  const { status } = useAccountStatus();
  const firstName = status.signedIn ? status.name?.trim().split(/\s+/)[0] || null : null;
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const target = headline?.target;
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
        <p className="ade-home-line" data-tone={headline?.kind === "blocked" ? "attention" : undefined} data-kind={headline?.kind}>
          {headline == null ? " " : target && onHeadline ? (
            <button type="button" className="ade-home-line-link" onClick={() => onHeadline(target)}>
              {headline.text}
            </button>
          ) : headline.text}
        </p>
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

// ── working now ────────────────────────────────────────────────────

export function RunningCard({ onOpenActivity, stacked = true }: { onOpenActivity: () => void; stacked?: boolean }) {
  const running = useRunningChats();
  // Stacked under Projects it takes no room while nothing runs; on its own it
  // says so instead of leaving a hole in the grid.
  if (running.length === 0 && stacked) return null;
  return (
    <section className="kit-card ade-home-card ade-home-running" aria-label="Working now">
      <WelcomeCardHead icon={Pulse} title="Working now" count={running.length > 0 ? running.length : null} action={{ label: "Activity", onClick: onOpenActivity }} />
      <div className="kit-card-body" data-flush="true">
        <RunningList items={running} onMore={onOpenActivity} />
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

type Metric = "tokens" | "cost";
type DayBar = { date: string; sessions: number; tokens: number; cost: number };

function lastDays(daily: readonly AdeUsageDailyPoint[], count: number): DayBar[] {
  const filled = fillMissingDays(daily);
  const bars = filled
    .slice(-count)
    .map((day) => ({
      date: day.date,
      sessions: day.sessions,
      tokens: day.totalTokens,
      cost: dayMetric(day, "cost"),
    }));
  while (bars.length < count) bars.unshift({ date: "", sessions: 0, tokens: 0, cost: 0 });
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

function formatActivityValue(metric: Metric, value: number): string {
  return metric === "cost" ? `$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}` : formatCompact(value);
}

const METRIC_UNIT: Record<Metric, string> = { tokens: "tokens", cost: "spent" };

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
      <WelcomeCardHead icon={ChartBar} title="Activity & usage" action={{ label: "Details", onClick: openUsageDetails }}>
        <span className="ade-home-card-scope" title="Usage recorded on this computer. Another machine's work shows once it is online and synced.">this machine</span>
        <div className="kit-seg ade-home-metric" role="group" aria-label="Measure">
          {(["tokens", "cost"] as Metric[]).map((option) => (
            <button key={option} type="button" aria-pressed={metric === option} onClick={() => setMetric(option)}>
              {option === "tokens" ? "Tokens" : "Cost"}
            </button>
          ))}
        </div>
      </WelcomeCardHead>
      <div className="kit-card-body ade-home-activity-body">
        <div className="ade-home-activity-side">
          <div>
            <div className="kit-eyebrow">Last 14 days</div>
            <div className="ade-home-activity-figure">
              <span className="kit-stat">{stats ? formatActivityValue(metric, total) : "—"}</span>
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
        <div className="ade-home-bars" role="img" aria-label={`${formatActivityValue(metric, total)} ${METRIC_UNIT[metric]} over the last 14 days`}>
          {bars.map((bar, index) => {
            const height = (value(bar) / max) * 100;
            const isToday = index === bars.length - 1;
            return (
              <div key={`${bar.date}-${index}`} className="ade-home-bar-col" title={bar.date ? `${dayLabel(bar.date)} · ${formatActivityValue(metric, value(bar))}` : undefined}>
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

export type HomeUsageGroups = { groups: UsageGroup[]; bridgeMissing: boolean; loaded: boolean };

export function LimitsMachinesCard({ machineRows, webMode, usage }: { machineRows: MachineRow[]; webMode: boolean; usage: HomeUsageGroups }) {
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
      <WelcomeCardHead icon={Gauge} title="Limits & machines" action={{ label: "Details", onClick: openUsageDetails }} />
      <div className="kit-card-body ade-home-limits-body">
        {usage.bridgeMissing ? null : (
          <div className="ade-home-rings">
            {rings.length === 0 ? (
              <span className="ade-home-muted">{usage.loaded ? "No provider limits reported yet." : "Reading limits…"}</span>
            ) : (
              rings.map(({ provider, line, accounts }) => {
                const Logo = usageProviderLogo(provider);
                const left = Math.round(Math.max(0, Math.min(100, line.percentLeft)));
                const level = usageLeftLevel(left);
                const color = usageLeftLevelColor(level, providerColor(provider, theme));
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
                    <span className="ade-home-ring-reset kit-num">resets {formatCountdownShort(line.resetsInMs)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
        <FitList className="ade-home-machine-fit" listClassName="ade-home-machine-list" ariaLabel="Machines" more={{ onMore: () => openMachines(webMode) }}>
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
        </FitList>
      </div>
    </section>
  );
}

// ── pull requests ──────────────────────────────────────────────────

export type PrBucket = "failing" | "changes" | "review" | "pending" | "ready" | "draft" | "open" | "merged" | "closed";

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
export type HomePr = {
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

export function prBucket(pr: HomePr): PrBucket {
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
export type HomePullRequests = { open: HomePr[]; recent: HomePr[]; loaded: boolean; viewer: string | null };

export function usePullRequests(projectRoot: string | null): HomePullRequests {
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
  prs,
  onOpenPrs,
}: {
  projectName: string | null;
  projectRoot: string | null;
  prs: HomePullRequests;
  onOpenPrs?: () => void;
}) {
  const { open, recent, loaded } = prs;
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
      <WelcomeCardHead icon={GitPullRequest} title="Pull requests" count={open.length > 0 ? open.length : null} action={onOpenPrs ? { label: "PRs", onClick: onOpenPrs } : null}>
        {projectName ? <span className="ade-home-card-scope">{projectName}</span> : null}
      </WelcomeCardHead>
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
              <FitList
                more={onOpenPrs ? { onMore: onOpenPrs } : {
                  dialog: {
                    title: "Pull requests",
                    render: () => (
                      <>
                        {open.map((pr) => <PullRequestRow key={pr.id} pr={pr} />)}
                        {recent.length > 0 ? <div className="kit-eyebrow ade-home-pr-divider">Merged this week</div> : null}
                        {recent.map((pr) => <PullRequestRow key={pr.id} pr={pr} />)}
                      </>
                    ),
                  },
                }}
              >
                {open.map((pr) => <PullRequestRow key={pr.id} pr={pr} onOpen={onOpenPrs} />)}
                {recent.length > 0 ? <div className="kit-eyebrow ade-home-pr-divider" data-fit-head>Merged this week</div> : null}
                {recent.map((pr) => <PullRequestRow key={pr.id} pr={pr} onOpen={onOpenPrs} />)}
              </FitList>
            )}
          </>
        )}
      </div>
    </section>
  );
}
