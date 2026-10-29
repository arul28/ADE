import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GitCommitSummary, LaneSummary, OpenProjectBinding, PrSummary } from "../../../../shared/types";
import { isWebClientMode } from "../../../lib/webClientMode";
import { revealLaneWorktree } from "../../../lib/revealLaneWorktree";
import { selectActiveProjectStateKey, useAppStore } from "../../../state/appStore";
import { getLaneAccent } from "../laneColorPalette";
import type { LaneAgent } from "../laneAgents";
import { lanePrTagRoutePath, type LaneTabPrTag } from "../lanePageModel";
import { laneCompareBaseBranch, type LaneRebaseLine } from "../laneRebaseNeeds";
import { LaneBuildOutputNotice } from "./LaneBuildOutputNotice";
import { LaneChangesSection } from "./LaneChangesSection";
import { LaneChatsSection } from "./LaneChatsSection";
import { LaneHistoryFeed } from "./LaneHistoryFeed";
import { LaneIdentity } from "./LaneIdentity";
import { LanePrSection } from "./LanePrSection";
import {
  buildLaneHistory,
  filterLaneHistory,
  selectLaneCommits,
  type LaneHistoryEntry,
  type LaneHistoryFilter,
  type LaneHistoryPr,
} from "./laneHistoryModel";
import {
  buildLaneChatRows,
  isLivePr,
  laneCreatedBy,
  laneOverviewSections,
  splitLanePrs,
} from "./laneOverviewModel";
import { Banner } from "../../ui/notice";
import { OverviewCollapseContext, type OverviewCollapse } from "./sectionUi";
import { historyCommitsPath } from "../../history/historyUrlHydration";
import { useTurnStallClock } from "../../../lib/useTurnStallClock";
import {
  laneHistorySessionsFrom,
  useLaneCommits,
  useLaneOperations,
  useLaneOverviewPrs,
  useLanePrDetail,
  MAX_LANE_COMMITS,
  PRIMARY_COMMIT_PAGE,
  useLaneSessions,
  useLaneUpstream,
} from "./useLaneOverviewData";

/** The overview's content width (780px) plus its 24px side padding. */
const OVERVIEW_MAX_WIDTH = 828;
/** Activity rows shown before "Show all activity". */
export const RECENT_ACTIVITY_COUNT = 8;
const EMPTY_AGENTS: LaneAgent[] = [];
const EMPTY_SECTION_IDS: string[] = [];

/**
 * Set when the lane lives on a machine other than the one the project tab is
 * bound to. Every read the dashboard makes then goes to `pin`, and the lane
 * list it resolves the lane against is that machine's own — never the tab's,
 * where a lane with the same id may be a different lane.
 */
export type LaneDashboardMachine = {
  pin: OpenProjectBinding;
  /** Names the machine in links to other tabs (History) that resolve lanes per machine. */
  machineId?: string;
  machineName: string;
  /** That machine's lanes, as reported by the cross-machine union. */
  lanes: LaneSummary[];
  /** That machine's mapped PR rows. */
  prs: PrSummary[];
};

function openPrPath(pr: Pick<LaneHistoryPr, "linkedPrId" | "number" | "repoOwner" | "repoName">): string | null {
  return lanePrTagRoutePath({
    linkedPrId: pr.linkedPrId,
    githubPrNumber: pr.number,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
  });
}

/**
 * How many activity rows to show and the label of the button under them.
 * Collapsed: the newest eight. Expanded: everything loaded, plus "Show older"
 * while the primary lane has more commits to page in.
 */
export function recentActivityWindow(args: {
  total: number;
  expanded: boolean;
  hasMoreCommits: boolean;
}): { count: number; moreLabel: string | null } {
  if (!args.expanded) {
    const hidden = args.total - RECENT_ACTIVITY_COUNT;
    if (hidden > 0 || args.hasMoreCommits) return { count: RECENT_ACTIVITY_COUNT, moreLabel: "Show all activity" };
    return { count: args.total, moreLabel: null };
  }
  return { count: args.total, moreLabel: args.hasMoreCommits ? "Show older" : null };
}

/**
 * The left column of the Lanes tab: the lane's name and git state, its pull
 * request, its chats, what it changes, and its recent activity.
 * Every read is scoped to this one lane, and a section with nothing to show
 * is left out. The page is only mounted while the tab is active.
 */
export function LaneDashboard({
  laneId,
  colorIndex,
  active = true,
  agents = EMPTY_AGENTS,
  prTagsByLaneId,
  rebaseLine,
  onRebase,
  rebaseError,
  onStartChat,
  onSelectCommit,
  onOpenLaneMenu,
  machine = null,
}: {
  laneId: string;
  colorIndex: number;
  active?: boolean;
  /** The lane's live roster from the page; a change in it re-reads the chat rows. */
  agents?: LaneAgent[];
  prTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  /** The quiet "3 behind main" line, when the lane needs a rebase. */
  rebaseLine: LaneRebaseLine | null;
  /** Runs the rebase the line offers. */
  onRebase: () => void;
  rebaseError: string | null;
  onStartChat: ((laneId: string) => void) | null;
  /** Opens a commit in the Git pane next to the overview. */
  onSelectCommit: (commit: GitCommitSummary) => void;
  /** Opens the lane's context menu under the given button. */
  onOpenLaneMenu: (laneId: string, anchor: DOMRect) => void;
  /** The lane's machine, when it is not the tab's. See {@link LaneDashboardMachine}. */
  machine?: LaneDashboardMachine | null;
}) {
  const navigate = useNavigate();
  const boundLanes = useAppStore((s) => s.lanes);
  const boundLaneStatusStale = useAppStore((s) => s.laneStatusStale);
  const lanes = machine?.lanes ?? boundLanes;
  const pin = machine?.pin ?? null;
  const selectLane = useAppStore((s) => s.selectLane);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const lane = useMemo(() => lanes.find((row) => row.id === laneId) ?? null, [laneId, lanes]);
  const primaryLane = useMemo(() => lanes.find((row) => row.laneType === "primary") ?? null, [lanes]);
  // What the lane is compared to: its open PR's base, else its own base.
  const openPrBaseBranch = useMemo(
    () => (prTagsByLaneId.get(laneId) ?? [])
      .find((pr) => pr.laneRole !== "previous" && (pr.state === "open" || pr.state === "draft"))?.baseBranch ?? null,
    [laneId, prTagsByLaneId],
  );

  // Folded sections, saved per project like the sidebar's folded groups, so
  // a section stays folded as you move between lanes.
  const projectKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const collapsedSectionIds = useAppStore(
    (s) => (projectKey ? s.workViewByProject[projectKey]?.lanesCollapsedSectionIds : undefined) ?? EMPTY_SECTION_IDS,
  );
  const collapse = useMemo<OverviewCollapse>(() => ({
    isCollapsed: (key) => collapsedSectionIds.includes(key),
    toggle: (key) => {
      if (!projectKey) return;
      const next = collapsedSectionIds.includes(key)
        ? collapsedSectionIds.filter((id) => id !== key)
        : [...collapsedSectionIds, key];
      setWorkViewState(projectKey, { lanesCollapsedSectionIds: next });
    },
  }), [collapsedSectionIds, projectKey, setWorkViewState]);

  // Chats started, ended or changed state when this moves; the rows re-read then.
  // Another machine's hints change on every cross-machine refresh while a chat
  // works, and each change would cost two remote reads, so a pinned lane keys on
  // state alone.
  const agentsKey = agents
    .map((agent) => `${agent.sessionId}:${agent.activity}:${agent.name}${pin ? "" : `:${agent.lastHint ?? ""}`}`)
    .sort()
    .join(",");

  const [filter, setFilter] = useState<LaneHistoryFilter>("all");
  const [expanded, setExpanded] = useState(false);
  const [commitLimit, setCommitLimit] = useState(PRIMARY_COMMIT_PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFilter("all");
    setExpanded(false);
    setCommitLimit(PRIMARY_COMMIT_PAGE);
    // A new lane starts at its top, not where the last lane was scrolled to.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [laneId]);

  const prs = useLaneOverviewPrs(lane, machine?.prs ?? null);
  const { current: currentPr, earlier: earlierPrs } = useMemo(() => {
    const prominent = splitLanePrs(prs.current).current;
    if (!prominent) return { current: null, earlier: prs.all };
    return { current: prominent, earlier: prs.all.filter((pr) => pr.key !== prominent.key) };
  }, [prs]);
  const livePr = isLivePr(currentPr) ? currentPr : null;
  const { detail: prDetail } = useLanePrDetail(livePr, active, pin);
  const upstream = useLaneUpstream(lane, active, pin);
  const { commits, trailerProviderBySha, loaded: commitsLoaded } = useLaneCommits(lane, commitLimit, pin);
  const laneSessions = useLaneSessions(lane ? laneId : null, agentsKey, pin);
  const historySessions = useMemo(
    () => laneHistorySessionsFrom(laneId, laneSessions.chats, laneSessions.terminals),
    [laneId, laneSessions.chats, laneSessions.terminals],
  );
  // A subagent's wake can turn overdue with no new rows, so the row labels
  // follow a clock that ticks at stall and wake deadlines.
  const chatClockMs = useTurnStallClock(laneSessions.terminals);
  const chatRows = useMemo(
    () => buildLaneChatRows({ laneId, chats: laneSessions.chats, terminals: laneSessions.terminals, nowMs: chatClockMs }),
    [chatClockMs, laneId, laneSessions.chats, laneSessions.terminals],
  );
  const operationsKey = [
    lane?.status?.ahead ?? "",
    lane?.status?.behind ?? "",
    lane?.status?.remoteBehind ?? "",
    lane?.status?.lastCommitAt ?? lane?.lastCommitAt ?? "",
    lane?.branchRef ?? "",
  ].join("|");
  const operations = useLaneOperations(lane ? laneId : null, operationsKey, pin);

  const history = useMemo(() => {
    if (!lane) return [];
    return buildLaneHistory({
      lane,
      commits,
      trailerProviderBySha,
      prs: prs.all,
      sessions: historySessions,
      operations,
    });
  }, [commits, historySessions, lane, operations, prs.all, trailerProviderBySha]);
  const filtered = useMemo(() => filterLaneHistory(history, filter), [filter, history]);
  // The primary lane's commit list is paged, so a full page may hide older rows.
  const hasMoreCommits = lane?.laneType === "primary"
    && commits.length >= commitLimit
    && commits.length < MAX_LANE_COMMITS;
  const activityWindow = recentActivityWindow({ total: filtered.length, expanded, hasMoreCommits });
  const visible = useMemo(() => filtered.slice(0, activityWindow.count), [filtered, activityWindow.count]);
  const laneCommits = useMemo(
    () => (lane && lane.laneType !== "primary" ? selectLaneCommits(commits, lane) : []),
    [commits, lane],
  );
  const createdBy = useMemo(() => (lane ? laneCreatedBy(lane, historySessions) : null), [historySessions, lane]);


  const openChat = useCallback((sessionId: string) => {
    // The Work tab stays mounted, so its listener focuses the chat; the
    // navigate switches the visible tab.
    // `binding` names another machine's lane, so Work can reach a chat that
    // is not in its roster instead of falling back to the tab's machine.
    window.dispatchEvent(new CustomEvent("ade:work:select-session", {
      detail: { sessionId, laneId, ...(pin ? { binding: pin } : {}) },
    }));
    navigate(`/work?${new URLSearchParams({ sessionId, laneId }).toString()}`);
  }, [laneId, navigate, pin]);

  const openPr = useCallback((pr: Pick<LaneHistoryPr, "linkedPrId" | "number" | "repoOwner" | "repoName">) => {
    // Another machine's linked PR id is a row in THAT machine's database; the
    // PRs tab resolves ids against the tab's machine, so open it by number.
    const path = openPrPath(pin ? { ...pr, linkedPrId: null } : pr);
    if (path) navigate(path);
  }, [navigate, pin]);

  const openEntry = useCallback((entry: LaneHistoryEntry) => {
    const target = entry.target;
    if (!target) return;
    if (target.kind === "chat") openChat(target.sessionId);
    else if (target.kind === "pr") openPr(target);
    else if (target.kind === "commit") {
      const commit = commits.find((row) => row.sha === target.sha);
      if (commit) onSelectCommit(commit);
    }
  }, [commits, onSelectCommit, openChat, openPr]);

  const openFiles = useCallback((openFilePath?: string) => {
    if (pin) {
      // Files pins itself to the lane's machine from the request. Selecting the
      // bare id here would select the tab machine's lane with that id.
      navigate("/files", { state: { laneId, filesPin: pin, ...(openFilePath ? { openFilePath } : {}) } });
      return;
    }
    // The Files tab follows the selected lane, so select it first.
    selectLane(laneId);
    navigate("/files", openFilePath ? { state: { openFilePath, laneId } } : undefined);
  }, [laneId, navigate, pin, selectLane]);

  if (!lane) {
    return <div className="h-full" data-testid="lane-dashboard" />;
  }

  const baseLabel = rebaseLine?.baseBranch ?? laneCompareBaseBranch(lane, openPrBaseBranch);
  const sections = laneOverviewSections({
    prs: prs.all,
    chatCount: chatRows.length,
    livePrFileCount: prDetail?.files.length ?? 0,
    laneCommitCount: laneCommits.length,
  });
  // Reveal resolves the lane on the tab's machine, so it is never offered for
  // a lane on another machine.
  const canReveal = !machine && !isWebClientMode() && !isRemoteProject && Boolean(lane.worktreePath) && Boolean(window.ade?.lanes?.revealWorktree);
  const accent = getLaneAccent(lane, colorIndex);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto" data-testid="lane-dashboard">
      {/* One rhythm: 20px 24px page padding and 24px between sections (12px,
          a hairline, 12px). The order puts what you can act on first. */}
      <OverviewCollapseContext.Provider value={collapse}>
      <div className="mx-auto flex flex-col gap-3 px-6 pb-12 pt-5" style={{ maxWidth: OVERVIEW_MAX_WIDTH }}>
        <div className="flex min-w-0 flex-col gap-3">
          <LaneIdentity
            lane={lane}
            accent={accent}
            primaryLane={primaryLane}
            compareBase={baseLabel}
            rebaseLine={rebaseLine}
            onRebase={onRebase}
            upstream={upstream}
            createdBy={createdBy}
            active={active}
            pin={pin}
            machineId={machine?.machineId ?? null}
            canReveal={canReveal}
            revealUnavailableReason={machine ? `On ${machine.machineName}` : null}
            onStartChat={onStartChat ? () => onStartChat(laneId) : null}
            onOpenFiles={() => openFiles()}
            onOpenHistory={() => navigate(historyCommitsPath(laneId, machine?.machineId))}
            onReveal={() => { void revealLaneWorktree(lane.id); }}
            onOpenMenu={(anchor) => onOpenLaneMenu(laneId, anchor)}
            // A lane on another machine carries that machine's own read.
            statusStale={!machine && boundLaneStatusStale}
          />
          <LaneBuildOutputNotice laneId={laneId} pin={pin} active={active} />
          {rebaseError ? (
            <Banner
              layout="inline"
              model={{
                id: "lane-rebase-error",
                tone: "error",
                title: rebaseError,
                report: { surface: "lane_rebase" },
              }}
            />
          ) : null}
        </div>

        {sections.pr && currentPr ? (
          <LanePrSection
            current={currentPr}
            earlier={earlierPrs}
            detail={livePr ? prDetail : null}
            baseLabel={baseLabel}
            onOpenPr={openPr}
          />
        ) : null}

        {sections.chats ? <LaneChatsSection rows={chatRows} onOpenChat={openChat} /> : null}

        {sections.changes === "pr-files" && prDetail ? (
          <LaneChangesSection kind="pr-files" files={prDetail.files} onOpenFile={(path) => openFiles(path)} />
        ) : sections.changes === "commits" ? (
          <LaneChangesSection
            kind="commits"
            commits={laneCommits}
            baseLabel={baseLabel}
            trailerProviderBySha={trailerProviderBySha}
            onSelectCommit={onSelectCommit}
          />
        ) : null}

        {/* Hidden once loading finds nothing at all, like every other section. */}
        {commitsLoaded && history.length === 0 ? null : (
        <LaneHistoryFeed
          entries={visible}
          totalCount={filtered.length}
          filter={filter}
          onFilterChange={setFilter}
          moreLabel={activityWindow.moreLabel}
          onShowMore={() => {
            if (!expanded) setExpanded(true);
            else setCommitLimit((limit) => limit + PRIMARY_COMMIT_PAGE);
          }}
          onOpen={openEntry}
          loaded={commitsLoaded}
        />
        )}
      </div>
      </OverviewCollapseContext.Provider>
    </div>
  );
}
