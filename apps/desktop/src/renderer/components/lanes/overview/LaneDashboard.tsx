import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch, Warning } from "@phosphor-icons/react";
import type { GitCommitSummary } from "../../../../shared/types";
import { isWebClientMode } from "../../../lib/webClientMode";
import { revealLaneWorktree } from "../../../lib/revealLaneWorktree";
import { selectActiveProjectStateKey, useAppStore } from "../../../state/appStore";
import { getLaneAccent } from "../laneColorPalette";
import { COLORS } from "../laneDesignTokens";
import type { LaneAgent } from "../laneAgents";
import { lanePrTagRoutePath, type LaneTabPrTag } from "../lanePageModel";
import { laneBranchLabel } from "../sidebar/laneSidebarModel";
import { LaneChangesSection } from "./LaneChangesSection";
import { LaneChatsSection } from "./LaneChatsSection";
import { LaneHistoryFeed } from "./LaneHistoryFeed";
import { LaneIdentity } from "./LaneIdentity";
import { LanePrSection } from "./LanePrSection";
import { LaneStackSection } from "./LaneStackSection";
import {
  buildLaneHistory,
  filterLaneHistory,
  laneRebaseNeed,
  selectLaneCommits,
  type LaneHistoryEntry,
  type LaneHistoryFilter,
  type LaneHistoryPr,
  type LaneNoticeTone,
  type LaneRebaseSource,
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

/** One quiet row when the lane needs a rebase or one went wrong. */
function RebaseNotice({
  label,
  tone,
  source,
  onOpen,
  onDismiss,
}: {
  label: string;
  tone: LaneNoticeTone;
  source: LaneRebaseSource;
  onOpen: () => void;
  onDismiss: (() => void) | null;
}) {
  return (
    <Banner
      layout="inline"
      testId="lane-rebase-notice"
      style={{ margin: "0 -8px" }}
      model={{
        id: `lane-rebase-notice:${source}`,
        tone: tone === "danger" ? "error" : "warning",
        icon: tone === "danger"
          ? <Warning size={13} weight="fill" />
          : <GitBranch size={13} weight="bold" />,
        title: label,
        actions: [{
          label: source === "suggestion" ? "Rebase…" : "Review",
          onClick: onOpen,
        }],
        dismiss: onDismiss
          ? { onDismiss, label: "Dismiss", title: "Dismiss until the base moves again" }
          : false,
      }}
    />
  );
}

/**
 * The left column of the Lanes tab: the lane's name and git state, its pull
 * request, its chats, its stack, what it changes, and its recent activity.
 * Every read is scoped to this one lane, and a section with nothing to show
 * is left out. The page is only mounted while the tab is active.
 */
export function LaneDashboard({
  laneId,
  colorIndex,
  active = true,
  agents = EMPTY_AGENTS,
  colorIndexByLaneId,
  prTagsByLaneId,
  showRebaseSuggestions,
  rebaseError,
  onOpenRebase,
  onDismissRebaseSuggestion,
  onDismissAutoRebase,
  onStartChat,
  onSelectCommit,
  onSelectLane,
  onOpenPrTag,
  onOpenLaneMenu,
}: {
  laneId: string;
  colorIndex: number;
  active?: boolean;
  /** The lane's live roster from the page; a change in it re-reads the chat rows. */
  agents?: LaneAgent[];
  colorIndexByLaneId: ReadonlyMap<string, number>;
  prTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  /** False when the project turned rebase suggestions off. Failures still show. */
  showRebaseSuggestions: boolean;
  rebaseError: string | null;
  onOpenRebase: (laneId: string) => void;
  onDismissRebaseSuggestion: (laneId: string) => void;
  onDismissAutoRebase: (laneId: string) => void;
  onStartChat: ((laneId: string) => void) | null;
  /** Opens a commit in the Git pane next to the overview. */
  onSelectCommit: (commit: GitCommitSummary) => void;
  onSelectLane: (laneId: string) => void;
  onOpenPrTag: (pr: LaneTabPrTag) => void;
  /** Opens the lane's context menu under the given button. */
  onOpenLaneMenu: (laneId: string, anchor: DOMRect) => void;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const lane = useMemo(() => lanes.find((row) => row.id === laneId) ?? null, [laneId, lanes]);
  const snapshot = useAppStore((s) => s.laneSnapshots.find((row) => row.lane.id === laneId) ?? null);
  const primaryLane = useMemo(() => lanes.find((row) => row.laneType === "primary") ?? null, [lanes]);
  const parentLane = useMemo(
    () => (lane?.parentLaneId ? lanes.find((row) => row.id === lane.parentLaneId) ?? null : null),
    [lane?.parentLaneId, lanes],
  );
  const childLanes = useMemo(
    () => lanes.filter((row) => row.parentLaneId === laneId && !row.archivedAt),
    [laneId, lanes],
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
  const agentsKey = agents.map((agent) => `${agent.sessionId}:${agent.activity}:${agent.name}:${agent.lastHint ?? ""}`).sort().join(",");

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

  const prs = useLaneOverviewPrs(lane);
  const { current: currentPr, earlier: earlierPrs } = useMemo(() => {
    const prominent = splitLanePrs(prs.current).current;
    if (!prominent) return { current: null, earlier: prs.all };
    return { current: prominent, earlier: prs.all.filter((pr) => pr.key !== prominent.key) };
  }, [prs]);
  const livePr = isLivePr(currentPr) ? currentPr : null;
  const { detail: prDetail } = useLanePrDetail(livePr, active);
  const upstream = useLaneUpstream(lane, active);
  const { commits, trailerProviderBySha, loaded: commitsLoaded } = useLaneCommits(lane, commitLimit);
  const laneSessions = useLaneSessions(lane ? laneId : null, agentsKey);
  const historySessions = useMemo(
    () => laneHistorySessionsFrom(laneId, laneSessions.chats, laneSessions.terminals),
    [laneId, laneSessions.chats, laneSessions.terminals],
  );
  const chatRows = useMemo(
    () => buildLaneChatRows({ laneId, chats: laneSessions.chats, terminals: laneSessions.terminals }),
    [laneId, laneSessions.chats, laneSessions.terminals],
  );
  const operationsKey = [
    lane?.status?.ahead ?? "",
    lane?.status?.behind ?? "",
    lane?.status?.remoteBehind ?? "",
    lane?.status?.lastCommitAt ?? lane?.lastCommitAt ?? "",
    lane?.branchRef ?? "",
  ].join("|");
  const operations = useLaneOperations(lane ? laneId : null, operationsKey);

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

  const rebase = lane
    ? laneRebaseNeed({
      lane,
      rebaseSuggestion: showRebaseSuggestions ? snapshot?.rebaseSuggestion : null,
      autoRebaseStatus: snapshot?.autoRebaseStatus,
      parentName: parentLane?.name ?? null,
    })
    : null;
  // A plain "behind" count is already in the status line.
  const notice = rebase && rebase.tone !== "muted" ? rebase : null;

  const openChat = useCallback((sessionId: string) => {
    // The Work tab stays mounted, so its listener focuses the chat; the
    // navigate switches the visible tab.
    window.dispatchEvent(new CustomEvent("ade:work:select-session", { detail: { sessionId, laneId } }));
    navigate(`/work?${new URLSearchParams({ sessionId, laneId }).toString()}`);
  }, [laneId, navigate]);

  const openPr = useCallback((pr: Pick<LaneHistoryPr, "linkedPrId" | "number" | "repoOwner" | "repoName">) => {
    const path = openPrPath(pr);
    if (path) navigate(path);
  }, [navigate]);

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
    // The Files tab follows the selected lane, so select it first.
    selectLane(laneId);
    navigate("/files", openFilePath ? { state: { openFilePath, laneId } } : undefined);
  }, [laneId, navigate, selectLane]);

  if (!lane) {
    return <div className="h-full" data-testid="lane-dashboard" />;
  }

  const baseLabel = laneBranchLabel(parentLane?.branchRef ?? lane.baseRef) || "base";
  const sections = laneOverviewSections({
    prs: prs.all,
    chatCount: chatRows.length,
    hasParent: parentLane != null,
    childCount: childLanes.length,
    livePrFileCount: prDetail?.files.length ?? 0,
    laneCommitCount: laneCommits.length,
  });
  const dismissNotice = notice?.source === "suggestion"
    ? () => onDismissRebaseSuggestion(laneId)
    : notice?.source === "auto-rebase"
      ? () => onDismissAutoRebase(laneId)
      : null;
  const canReveal = !isWebClientMode() && !isRemoteProject && Boolean(lane.worktreePath) && Boolean(window.ade?.lanes?.revealWorktree);
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
            parentLane={parentLane}
            upstream={upstream}
            createdBy={createdBy}
            active={active}
            canReveal={canReveal}
            onStartChat={onStartChat ? () => onStartChat(laneId) : null}
            onOpenFiles={() => openFiles()}
            onReveal={() => { void revealLaneWorktree(lane.id); }}
            onOpenMenu={(anchor) => onOpenLaneMenu(laneId, anchor)}
            onSelectLane={onSelectLane}
          />
          {notice ? (
            <RebaseNotice
              label={notice.label}
              tone={notice.tone}
              source={notice.source}
              onOpen={() => onOpenRebase(laneId)}
              onDismiss={dismissNotice}
            />
          ) : null}
          {rebaseError ? (
            <div className="-mx-2 truncate rounded-md px-2 py-2 text-[12.5px]" style={{ color: COLORS.danger, background: "color-mix(in srgb, var(--color-error) 7%, transparent)" }} title={rebaseError}>
              {rebaseError}
            </div>
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

        {sections.stack ? (
          <LaneStackSection
            lane={lane}
            parent={parentLane}
            children={childLanes}
            colorIndexByLaneId={colorIndexByLaneId}
            prTagsByLaneId={prTagsByLaneId}
            onSelectLane={onSelectLane}
            onOpenPr={onOpenPrTag}
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
