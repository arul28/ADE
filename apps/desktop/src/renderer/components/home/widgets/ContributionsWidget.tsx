import { useMemo } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type { AdeUsageDailyPoint } from "../../../../shared/types";
import { WelcomeCardHead, openUsageDetails } from "../../projects/ProjectWelcomeSidePanels";
import ContributionSkyline, { ContributionSkylineToggle, type ContributionDay } from "../../ui/ContributionSkyline";
import { formatCompact } from "../../../lib/format";
import { useHomeData } from "../homeData";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * Your work in ADE as a contribution skyline (the shared ContributionSkyline):
 * a heat map of the days that folds up into an isometric skyline. A day
 * counts its chats, commits and pull requests (git or GitHub, whichever saw
 * more); its tooltip names each, plus the tokens spent. From the usage stats
 * the home page already loaded (this machine, all time); no reads of its own.
 * The canvas stops while the card is off screen or the window is hidden.
 * The Add widget gallery always shows the skyline, rising once as it comes
 * into sight; the page's own card keeps the view the user picked.
 */

/** Commits and PRs come from git and from GitHub; the larger of the two, so one PR is not counted twice. */
const commitsOf = (point: AdeUsageDailyPoint) => Math.max(point.commits, point.githubCommits ?? 0);
const prsOf = (point: AdeUsageDailyPoint) => Math.max(point.prs, point.githubPrs ?? 0);

function detail(point: AdeUsageDailyPoint): string | undefined {
  const commits = commitsOf(point);
  const prs = prsOf(point);
  const parts = [
    point.sessions > 0 ? `${point.sessions} chat${point.sessions === 1 ? "" : "s"}` : null,
    commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"}` : null,
    prs > 0 ? `${prs} PR${prs === 1 ? "" : "s"}` : null,
    point.totalTokens > 0 ? `${formatCompact(point.totalTokens)} tokens` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
  const data = useMemo((): ContributionDay[] => (daily ?? []).slice(-380).map((point) => ({
    date: point.date,
    count: point.sessions + commitsOf(point) + prsOf(point),
    detail: detail(point),
  })), [daily]);
  const any = data.some((day) => day.count > 0);

  return (
    <section className="kit-card ade-home-card ade-contrib" aria-label="Contributions">
      <WelcomeCardHead icon={SquaresFour} title="Contributions" action={{ label: "Details", onClick: openUsageDetails }}>
        <span className="ade-home-card-scope">this machine</span>
        {any ? <ContributionSkylineToggle className="ade-contrib-view" view={view} onChange={setView} /> : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-contrib-body">
        {stats === "unavailable" ? (
          <div className="ade-home-empty"><span>Activity history is unavailable here.</span></div>
        ) : !stats ? (
          <div className="ade-home-empty"><span>Reading your activity…</span></div>
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
