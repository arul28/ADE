import { useMemo } from "react";
import { GitMerge, RocketLaunch } from "@phosphor-icons/react";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { formatCompact } from "../../../lib/format";
import { localDayKey } from "../../usage/ActivityHeatmap";
import { useHomeData } from "../homeData";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * What you shipped since Monday: PRs merged in the open project (from the PR
 * snapshot the page already holds), and chats, commits and lines changed on
 * this machine (from the usage stats). No reads of its own.
 */

function startOfWeek(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Monday-start week: Sunday counts as the end of the previous week.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

export default function ShippedWidget({ item }: HomeWidgetProps) {
  const { stats, prs, projectName, projectRoot, openPrs } = useHomeData();
  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const weekKey = localDayKey(weekStart);
  const merged = useMemo(
    () => prs.recent.filter((pr) => pr.mergedAt && Date.parse(pr.mergedAt) >= weekStart.getTime()),
    [prs.recent, weekStart],
  );
  const local = useMemo(() => {
    if (!stats || stats === "unavailable") return null;
    const week = stats.daily.filter((point) => point.date >= weekKey);
    return {
      chats: week.reduce((sum, point) => sum + point.sessions, 0),
      commits: week.reduce((sum, point) => sum + point.commits, 0),
      insertions: week.reduce((sum, point) => sum + point.insertions, 0),
      deletions: week.reduce((sum, point) => sum + point.deletions, 0),
    };
  }, [stats, weekKey]);
  const showList = item.size !== "s" || merged.length <= 2;

  return (
    <section className="kit-card ade-home-card ade-shipped" aria-label="Shipped this week" data-size={item.size}>
      <WelcomeCardHead icon={RocketLaunch} title="Shipped this week" action={openPrs ? { label: "PRs", onClick: openPrs } : null}>
        <span className="ade-home-card-scope">since {weekStart.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
      </WelcomeCardHead>
      <div className="kit-card-body ade-shipped-body">
        <dl className="ade-shipped-stats">
          <div>
            <dd className="kit-num">{projectRoot ? merged.length : "—"}</dd>
            <dt title={projectName ? `Merged in ${projectName}` : "Open a project to count its merges"}>PRs merged</dt>
          </div>
          <div><dd className="kit-num">{local ? formatCompact(local.commits) : "—"}</dd><dt>commits</dt></div>
          <div><dd className="kit-num">{local ? formatCompact(local.chats) : "—"}</dd><dt>chats</dt></div>
          {item.size !== "s" ? (
            <div>
              <dd className="kit-num ade-shipped-lines">
                {local ? <><i>+{formatCompact(local.insertions)}</i> <b>−{formatCompact(local.deletions)}</b></> : "—"}
              </dd>
              <dt>lines</dt>
            </div>
          ) : null}
        </dl>
        {showList ? (
          merged.length === 0 ? (
            <div className="ade-home-empty">
              <GitMerge size={16} aria-hidden />
              <span>{projectRoot ? (prs.loaded ? "No merges yet this week." : "Reading pull requests…") : "Open a project to list its merges."}</span>
            </div>
          ) : (
            <div className="ade-home-scroll" role="list">
              {merged.map((pr) => (
                <button key={pr.id} type="button" role="listitem" className="kit-row ade-shipped-row" onClick={openPrs} title={pr.title}>
                  <GitMerge size={13} weight="bold" className="ade-shipped-icon" aria-hidden />
                  <span className="ade-shipped-title">{pr.title}</span>
                  <span className="kit-num ade-shipped-num">#{pr.number}</span>
                </button>
              ))}
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}
