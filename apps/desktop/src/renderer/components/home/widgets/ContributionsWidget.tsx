import { useEffect, useMemo, useState } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type { AdeUsageDailyPoint, GithubContributionCalendar } from "../../../../shared/types";
import { WelcomeCardHead, openUsageDetails } from "../../projects/ProjectWelcomeSidePanels";
import ContributionSkyline, { ContributionSkylineToggle, type ContributionDay } from "../../ui/ContributionSkyline";
import { formatCompact } from "../../../lib/format";
import { useHomeData } from "../homeData";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * Your work as a contribution skyline (the shared ContributionSkyline): a
 * heat map of the days that folds up into an isometric skyline.
 *
 * A day counts what GitHub counts for you (its contribution calendar, every
 * repository, read once with this computer's `gh` login and cached in main)
 * or, when ADE saw more, the commits and pull requests it recorded (git or
 * GitHub, whichever saw more), plus your chats in ADE, which GitHub never
 * sees. The headline total, streaks and busiest day come from that same
 * series. Without `gh` (or on a host with no bridge for it, like the web
 * client) it is ADE's own counts alone, as before. The tooltip names each
 * part, plus the tokens spent. The usage stats are the ones the home page
 * already loaded (this machine, all time).
 *
 * The canvas stops while the card is off screen or the window is hidden.
 * The Add widget gallery always shows the skyline, rising once as it comes
 * into sight; the page's own card keeps the view the user picked.
 */

/** Commits and PRs come from git and from GitHub; the larger of the two, so one PR is not counted twice. */
const commitsOf = (point: AdeUsageDailyPoint) => Math.max(point.commits, point.githubCommits ?? 0);
const prsOf = (point: AdeUsageDailyPoint) => Math.max(point.prs, point.githubPrs ?? 0);

/** How many of the last days the card can show (a year and a bit). */
const DAYS_SHOWN = 380;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One day: GitHub's count or ADE's commits and PRs, whichever is more, plus ADE chats. */
function dayOf(date: string, point: AdeUsageDailyPoint | undefined, github: number | undefined): ContributionDay {
  const commits = point ? commitsOf(point) : 0;
  const prs = point ? prsOf(point) : 0;
  const sessions = point?.sessions ?? 0;
  const fromGithub = github != null && github > 0 && github >= commits + prs;
  const parts = [
    fromGithub ? plural(github, "GitHub contribution") : null,
    sessions > 0 ? plural(sessions, "chat") : null,
    !fromGithub && commits > 0 ? plural(commits, "commit") : null,
    !fromGithub && prs > 0 ? plural(prs, "PR") : null,
    point && point.totalTokens > 0 ? `${formatCompact(point.totalTokens)} tokens` : null,
  ].filter(Boolean);
  return {
    date,
    count: Math.max(github ?? 0, commits + prs) + sessions,
    detail: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}

/** The ADE days and GitHub's calendar as one series, oldest first. */
function contributionDays(daily: readonly AdeUsageDailyPoint[], calendar: GithubContributionCalendar | null): ContributionDay[] {
  const points = new Map(daily.map((point) => [point.date, point]));
  const github = new Map((calendar?.days ?? []).map((day) => [day.date, day.count]));
  const dates = [...new Set([...points.keys(), ...github.keys()])].sort();
  return dates.slice(-DAYS_SHOWN).map((date) => dayOf(date, points.get(date), github.get(date)));
}

/**
 * This computer's GitHub contribution calendar: undefined while it is read,
 * null when there is none (no `gh`, no login, or no bridge for it here).
 * Read again whenever the usage stats reload; main answers from its cache.
 */
function useGithubCalendar(reloadKey: unknown): GithubContributionCalendar | null | undefined {
  const [calendar, setCalendar] = useState<GithubContributionCalendar | null | undefined>(() =>
    window.ade?.usage?.getGithubContributions ? undefined : null);
  useEffect(() => {
    const read = window.ade?.usage?.getGithubContributions;
    if (!read) return undefined;
    let live = true;
    read().then(
      (value) => { if (live) setCalendar(value ?? null); },
      () => { if (live) setCalendar((current) => current ?? null); },
    );
    return () => {
      live = false;
    };
  }, [reloadKey]);
  return calendar;
}

export default function ContributionsWidget({ item }: HomeWidgetProps) {
  const { stats } = useHomeData();
  const visible = useWidgetVisible();
  const preview = useWidgetPreview();
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  // "grid" and "skyline" are what earlier builds stored.
  const view = !preview && (item.settings?.view === "grid" || item.settings?.view === "2d") ? "2d" : "3d";
  const setView = (next: "2d" | "3d") => updateSettings(item.id, { view: next === "2d" ? "grid" : "skyline" });
  const daily = stats && stats !== "unavailable" ? stats.daily : null;
  const calendar = useGithubCalendar(stats);
  const data = useMemo(() => contributionDays(daily ?? [], calendar ?? null), [daily, calendar]);
  const any = data.some((day) => day.count > 0);
  // Both reads settle before the chart draws, so it does not rise once for
  // ADE's days and again when GitHub's land.
  const loading = calendar === undefined || !stats;

  return (
    <section className="kit-card ade-home-card ade-contrib" aria-label="Contributions">
      <WelcomeCardHead icon={SquaresFour} title="Contributions" action={{ label: "Details", onClick: openUsageDetails }}>
        {calendar ? (
          <span className="ade-home-card-scope" title="GitHub's contribution calendar for your account, plus your chats in ADE on this computer.">GitHub + ADE</span>
        ) : (
          <span className="ade-home-card-scope">this machine</span>
        )}
        {any ? <ContributionSkylineToggle className="ade-contrib-view" view={view} onChange={setView} /> : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-contrib-body">
        {loading ? (
          <div className="ade-home-empty"><span>Reading your activity…</span></div>
        ) : stats === "unavailable" && !calendar ? (
          <div className="ade-home-empty"><span>Activity history is unavailable here.</span></div>
        ) : !any ? (
          <div className="ade-home-empty">
            <SquaresFour size={18} aria-hidden />
            <span>Your first chat starts the map.</span>
          </div>
        ) : (
          <ContributionSkyline
            data={data}
            view={view}
            onViewChange={setView}
            showToggle={false}
            unit="contribution"
            paused={!visible}
          />
        )}
      </div>
    </section>
  );
}
