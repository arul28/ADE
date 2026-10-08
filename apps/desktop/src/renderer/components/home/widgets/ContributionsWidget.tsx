import { useEffect, useMemo, useRef, useState } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type { AdeUsageDailyPoint } from "../../../../shared/types";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { openUsageDetails } from "../../projects/ProjectWelcomeSidePanels";
import { ActivityHeatmap, computeHeatmapLayout, useHeatmapCells, weekAlignment } from "../../usage/ActivityHeatmap";
import { formatCompact } from "../../../lib/format";
import { useHomeData } from "../homeData";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * A GitHub-style contribution map of your work in ADE: chats, commits and PRs
 * per day, from the usage stats the home page already loaded (this machine,
 * all time). Streaks come from the same stats. No reads of its own.
 */

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function describe(point: AdeUsageDailyPoint): string {
  const parts = [
    point.sessions > 0 ? `${point.sessions} chat${point.sessions === 1 ? "" : "s"}` : null,
    point.commits > 0 ? `${point.commits} commit${point.commits === 1 ? "" : "s"}` : null,
    point.prs > 0 ? `${point.prs} PR${point.prs === 1 ? "" : "s"}` : null,
    point.totalTokens > 0 ? `${formatCompact(point.totalTokens)} tokens` : null,
  ].filter(Boolean);
  return `${dayLabel(point.date)} · ${parts.length > 0 ? parts.join(" · ") : "No activity"}`;
}

export default function ContributionsWidget({ item }: HomeWidgetProps) {
  const { stats } = useHomeData();
  const daily = stats && stats !== "unavailable" ? stats.daily : null;
  const summary = stats && stats !== "unavailable" ? stats.summary : null;
  // A year at most: the map is a "recent" picture, and the card is small.
  const lastYear = useMemo(() => (daily ? daily.slice(-371) : []), [daily]);
  const cells = useHeatmapCells(lastYear);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [hover, setHover] = useState<AdeUsageDailyPoint | null>(null);
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setWidth(Math.floor(rect.width));
        setHeight(Math.floor(rect.height));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const align = weekAlignment(cells);
  // Fit seven rows into the card's height, and as many weeks as its width allows.
  const maxCell = Math.max(6, Math.min(16, Math.floor((height - 6 * 3) / 7)));
  const layout = useMemo(
    () => computeHeatmapLayout({ cellCount: cells.length, maxCell, availableWidth: width, leading: align.leading, trailing: align.trailing }),
    [align.leading, align.trailing, cells.length, maxCell, width],
  );
  const activeDays = lastYear.filter((point) => point.sessions > 0 || point.commits > 0 || point.totalTokens > 0).length;
  const yearChats = lastYear.reduce((sum, point) => sum + point.sessions, 0);
  const yearCommits = lastYear.reduce((sum, point) => sum + point.commits, 0);
  const streak = summary?.currentStreakDays ?? 0;
  const longest = summary?.longestStreakDays ?? 0;
  const roomy = item.size === "l" || item.size === "m";

  return (
    <section className="kit-card ade-home-card ade-contrib" aria-label="Contributions" data-size={item.size}>
      <WelcomeCardHead icon={SquaresFour} title="Contributions" action={{ label: "Details", onClick: openUsageDetails }}>
        <span className="ade-home-card-scope">this machine</span>
      </WelcomeCardHead>
      <div className="kit-card-body ade-contrib-body">
        {stats === "unavailable" ? (
          <div className="ade-home-empty"><span>Activity history is unavailable here.</span></div>
        ) : !stats ? (
          <div className="ade-home-empty"><span>Reading your activity…</span></div>
        ) : cells.length === 0 ? (
          <div className="ade-home-empty">
            <SquaresFour size={18} aria-hidden />
            <span>Your first chat starts the map.</span>
          </div>
        ) : (
          <>
            <dl className="ade-contrib-facts">
              <div><dt className="kit-eyebrow">Streak</dt><dd className="kit-num">{streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : "—"}</dd></div>
              <div><dt className="kit-eyebrow">Longest</dt><dd className="kit-num">{longest > 0 ? `${longest} days` : "—"}</dd></div>
              <div><dt className="kit-eyebrow">Active days</dt><dd className="kit-num">{activeDays}</dd></div>
              {roomy || item.size === "w" ? (
                <div><dt className="kit-eyebrow">Chats · commits</dt><dd className="kit-num">{formatCompact(yearChats)} · {formatCompact(yearCommits)}</dd></div>
              ) : null}
            </dl>
            <div ref={hostRef} className="ade-contrib-map">
              {width > 0 ? (
                <ActivityHeatmap
                  cells={cells}
                  layout={layout}
                  reduced
                  showKey={false}
                  tooltip={{
                    show: (point) => setHover(point),
                    hide: () => setHover(null),
                    toggle: (point) => setHover((current) => (current?.date === point.date ? null : point)),
                  }}
                />
              ) : null}
            </div>
            <div className="ade-contrib-readout kit-num" aria-live="polite">
              {hover ? describe(hover) : `Last ${Math.min(cells.length, layout.visible)} days`}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
