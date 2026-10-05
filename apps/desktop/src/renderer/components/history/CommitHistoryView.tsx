import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowClockwise, CircleNotch, Warning } from "@phosphor-icons/react";
import type {
  GitBranchSummary,
  GitCommitSummary,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
} from "../../../shared/types";
import { BranchIcon } from "../ui/vcsIcons";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { lanePrTagRoutePath } from "../lanes/lanePageModel";
import { boundMachineLanePrs, useLanePrsByLaneId } from "../terminals/useLanePrs";
import { filterCommitsForSearch } from "./historySearch";
import {
  assignCommitOwners,
  branchTipKeep,
  buildCommitGraphLayout,
  COMMIT_GRAPH_COL_WIDTH,
  COMMIT_GRAPH_PAD_LEFT,
  COMMIT_ROW_HEIGHT,
  computeDividerAfterRow,
  contractCommitGraph,
  laneForkWaitsForStatus,
  toGraphCommits,
  type CommitGraphLayout,
  type GraphCommit,
  type LaneTip,
} from "./commitGraphLayout";
import { CommitGraphLayer, applyGraphFocus, type GraphPaint } from "./CommitGraphLayer";
import type { RefBadgeActions } from "./CommitRefBadges";
import { CommitRow, type RowMenuContext } from "./CommitRow";
import {
  buildRefBadges,
  githubRepoFromRemote,
  isBaseLinePrimary,
  normalizeBranchName,
  prsForLaneBranch,
} from "./commitRowModel";
import { useCommitViewPrefs } from "./commitViewPrefs";
import { copyText, stripIpcErrorPrefix } from "./historyClipboard";
import { showToast } from "../app/toast/toastStore";
import { useAppStore } from "../../state/appStore";

const PAGE_SIZE = 100;
/** Search keeps reading older pages until it has this many matches… */
const SEARCH_TARGET_MATCHES = 60;
/** …or has read this many commits. "Search older" goes further on request. */
const SEARCH_AUTO_SCAN = 3_000;
const SEARCH_PAGE_SIZE = 500;
const SEARCH_DEBOUNCE_MS = 70;
/** Folded to branch tips, older pages are read until this many rows show. */
const FOLD_TARGET_ROWS = 60;
/** The band between a lane's own commits and its base history. */
const DIVIDER_HEIGHT = 30;

/** Below this width the author and SHA columns fold away; above the second they return. */
const COMPACT_ENTER_PX = 560;
const COMPACT_EXIT_PX = 620;
/** Below this the author shows as an avatar only. */
const MEDIUM_ENTER_PX = 760;
const MEDIUM_EXIT_PX = 800;
/** The graph column never takes more than this many lanes of width; wider history is clipped. */
const MAX_GRAPH_COLUMNS = 6;
/** Wide enough for a second ref badge. */
const WIDE_ENTER_PX = 980;
const WIDE_EXIT_PX = 920;

function formatTimelineError(err: unknown): string {
  const message = stripIpcErrorPrefix(err);
  if (/^Lane worktree is missing\./i.test(message)) return message;
  if (/git working directory not found:/i.test(message)) {
    return "Lane worktree is missing. Restore or recreate the lane worktree before viewing commits.";
  }
  return message || "Unable to load commit history.";
}

/** Same person across rows, by email when git has one. */
function authorKey(commit: GitCommitSummary): string {
  return (commit.authorEmail || commit.authorName).toLowerCase();
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms, debounced]);
  return debounced;
}

/** Compact mode with hysteresis, so a pane resting on the threshold does not flicker. */
type WidthClass = { compact: boolean; medium: boolean; wide: boolean };

function useWidthClass(ref: React.RefObject<HTMLElement | null>, enabled: boolean): WidthClass {
  const [state, setState] = useState<WidthClass>({ compact: false, medium: false, wide: false });
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setState((prev) => {
        const compact = prev.compact ? width < COMPACT_EXIT_PX : width < COMPACT_ENTER_PX;
        const medium = prev.medium ? width < MEDIUM_EXIT_PX : width < MEDIUM_ENTER_PX;
        const wide = prev.wide ? width > WIDE_EXIT_PX : width > WIDE_ENTER_PX;
        return compact === prev.compact && medium === prev.medium && wide === prev.wide
          ? prev
          : { compact, medium, wide };
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return state;
}

/* ───────────────────────── View ───────────────────────── */

type CommitHistoryViewProps = {
  laneId: string | null;
  /** The lane's machine when it is not this tab's (null: the tab's machine). */
  pin?: OpenProjectBinding | null;
  remoteMachineName?: string | null;
  laneName: string | null;
  laneHasWorktree?: boolean;
  /** Lanes of the machine the focused lane lives on, for ownership and colours. */
  lanes: LaneSummary[];
  selectedSha: string | null;
  onSelectCommit: (commit: GitCommitSummary, ownerLaneId: string | null) => void;
  /**
   * The lane whose work the selected commit is (null: base history), once the
   * loaded rows contain it — however it was selected (a deep link, a parent
   * link, a remount, a kept selection across a scope switch).
   */
  onSelectionOwner: (sha: string, ownerLaneId: string | null) => void;
  onOpenCommit: (commit: GitCommitSummary) => void;
  onFocusLane: (laneId: string) => void;
  /** Lanes, on this lane's machine. */
  onOpenLane: (laneId: string) => void;
  refreshToken?: number;
  active?: boolean;
};

export function CommitHistoryView({
  laneId,
  pin = null,
  remoteMachineName = null,
  laneName,
  laneHasWorktree = false,
  lanes,
  selectedSha,
  onSelectCommit,
  onSelectionOwner,
  onOpenCommit,
  onFocusLane,
  onOpenLane,
  refreshToken = 0,
  active = true,
}: CommitHistoryViewProps) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusStyleRef = useRef<HTMLStyleElement>(null);
  const loadSeq = useRef(0);
  const scope = useCommitViewPrefs((s) => s.scope);
  const fold = useCommitViewPrefs((s) => s.fold);
  const columns = useCommitViewPrefs((s) => s.columns);
  const rawSearch = useCommitViewPrefs((s) => s.search);
  const search = useDebounced(rawSearch.trim(), SEARCH_DEBOUNCE_MS);
  const { compact, medium, wide } = useWidthClass(rootRef, Boolean(laneId));

  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ owner: string; name: string } | null>(null);
  // Transient action results are events, so they go through the shared toast.
  const notify = useCallback((text: string, isError: boolean) => {
    showToast({ id: "history-commit-action", tone: isError ? "error" : "info", title: text });
  }, []);
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  /** Scroll anchor captured before a refresh replaces the rows. */
  const anchorRef = useRef<{ sha: string; delta: number } | null>(null);
  /** The lane whose newest commit was opened on arrival; cleared when the lane changes. */
  const autoSelectedRef = useRef<string | null>(null);
  /** The lane and scope the loaded rows belong to, so a switch never acts on the previous view's rows. */
  const rowsViewRef = useRef<string | null>(null);
  const viewKey = laneId ? `${laneId}\u0000${scope}` : null;
  /**
   * A view whose first rows must re-check the selection: a scope switch keeps
   * the selected commit, which the new rows may not contain. (A lane switch
   * clears the selection; a commit a URL names there is kept.)
   */
  const recheckViewRef = useRef<string | null>(null);
  /** undefined until the first reset, so mounting (a deep link) is not a scope switch. */
  const prevLaneRef = useRef<string | null | undefined>(undefined);

  /* ── Loading ── */

  const readPage = useCallback(
    (skip: number, limit: number) =>
      window.ade.git.listRecentCommits({ laneId: laneId!, limit, skip, scope }, pin),
    [laneId, pin, scope],
  );

  /** (Re)read from the top, keeping as many commits as were loaded. */
  const reload = useCallback(async (opts: { keepAnchor: boolean }) => {
    if (!laneId) return;
    const seq = ++loadSeq.current;
    const target = Math.max(PAGE_SIZE, commitsRef.current.length);
    setLoading(true);
    setError(null);
    try {
      const [first, branchRows] = await Promise.all([
        readPage(0, Math.min(500, target)),
        window.ade.git.listBranches({ laneId }, pin).catch(() => [] as GitBranchSummary[]),
      ]);
      let rows = first;
      while (rows.length < target && rows.length % 500 === 0 && rows.length > 0) {
        const more = await readPage(rows.length, Math.min(500, target - rows.length));
        if (loadSeq.current !== seq) return;
        rows = rows.concat(more);
        if (more.length === 0) break;
      }
      if (loadSeq.current !== seq) return;
      if (opts.keepAnchor) {
        const el = scrollRef.current;
        if (el) {
          const geometry = layoutRef.current;
          let topIndex = Math.floor(el.scrollTop / COMMIT_ROW_HEIGHT);
          while (topIndex > 0 && geometry.rowTop(topIndex) > el.scrollTop) topIndex -= 1;
          const sha = graphRowsRef.current[topIndex]?.commit.sha;
          if (sha) anchorRef.current = { sha, delta: el.scrollTop - geometry.rowTop(topIndex) };
        }
      }
      rowsViewRef.current = `${laneId}\u0000${scope}`;
      setCommits(rows);
      setBranches(branchRows);
      setHasMore(rows.length >= target);
    } catch (err) {
      if (loadSeq.current !== seq) return;
      setError(formatTimelineError(err));
      setCommits([]);
      setBranches([]);
      setHasMore(false);
    } finally {
      if (loadSeq.current === seq) setLoading(false);
    }
  }, [laneId, pin, readPage, scope]);

  const loadOlder = useCallback(async (pageSize = PAGE_SIZE) => {
    if (!laneId || loadingMore || loading || !hasMore) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const skip = commitsRef.current.length;
      const rows = await readPage(skip, pageSize);
      if (loadSeq.current !== seq) return;
      setCommits((prev) => {
        const seen = new Set(prev.map((c) => c.sha));
        return prev.concat(rows.filter((c) => !seen.has(c.sha)));
      });
      setHasMore(rows.length >= pageSize);
    } catch (err) {
      if (loadSeq.current === seq) notify(formatTimelineError(err), true);
    } finally {
      if (loadSeq.current === seq) setLoadingMore(false);
    }
  }, [hasMore, laneId, loading, loadingMore, notify, readPage]);

  // A new lane or scope starts over from the top.
  useEffect(() => {
    loadSeq.current += 1;
    // `setCommits([])` lands after the reload effect reads the ref, so clear
    // it here too: otherwise the first load sizes itself off the previous
    // lane's loaded rows and re-reads pages that no longer apply.
    commitsRef.current = [];
    setCommits([]);
    setBranches([]);
    setHasMore(false);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
    anchorRef.current = null;
    rowsViewRef.current = null;
    recheckViewRef.current = prevLaneRef.current === laneId && laneId ? `${laneId}\u0000${scope}` : null;
    prevLaneRef.current = laneId;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [laneId, scope]);
  useEffect(() => {
    autoSelectedRef.current = null;
  }, [laneId]);

  useEffect(() => {
    if (!active || !laneId) return;
    void reload({ keepAnchor: commitsRef.current.length > 0 });
    // `reload` changes with lane and scope, which the reset above already handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, laneId, scope, refreshToken]);

  useEffect(() => {
    if (!laneId) return;
    let cancelled = false;
    void window.ade.git.getOriginRemote({ laneId }, pin)
      .then((remote) => {
        if (!cancelled) setRepo(githubRepoFromRemote(remote.remoteUrl));
      })
      .catch(() => {
        if (!cancelled) setRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, pin]);

  /* ── Lanes, owners, colours ── */

  const focusLane = useMemo(() => lanes.find((lane) => lane.id === laneId) ?? null, [lanes, laneId]);
  // This machine's lane status not measured within the freshness window (a
  // read is out, or failed). A lane on another machine (`pin`) comes from that
  // machine's own read, not from this store.
  const storeStatusStale = useAppStore((s) => s.laneStatusStale);
  const statusStale = !pin && storeStatusStale;
  const liveLanes = useMemo(() => lanes.filter((lane) => !lane.archivedAt), [lanes]);
  const laneColor = useMemo(() => {
    const map = new Map<string, string>();
    liveLanes.forEach((lane, index) => map.set(lane.id, getLaneAccent(lane, index)));
    return map;
  }, [liveLanes]);
  const lanesByBranch = useMemo(() => {
    const map = new Map<string, LaneSummary>();
    for (const lane of liveLanes) {
      const name = normalizeBranchName(lane.branchRef);
      if (name && !map.has(name)) map.set(name, lane);
    }
    return map;
  }, [liveLanes]);
  // Primary is the base line only while it sits on its base branch; on a
  // feature branch it is a lane like any other.
  const baseLinePrimaryId = useMemo(
    () => liveLanes.find((lane) => isBaseLinePrimary(lane))?.id ?? null,
    [liveLanes],
  );

  const branchTip = useCallback((name: string): string | null => {
    const local = branches.find((b) => !b.isRemote && b.name === name);
    if (local?.lastCommitSha) return local.lastCommitSha;
    return branches.find((b) => b.isRemote && b.name === name)?.lastCommitSha ?? null;
  }, [branches]);

  const headSha = useMemo(() => {
    const current = branches.find((b) => b.isCurrent && !b.isRemote)?.lastCommitSha;
    if (current) return current;
    return scope === "lane" ? commits[0]?.sha ?? null : null;
  }, [branches, commits, scope]);

  const focusIsBaseLine = focusLane != null && focusLane.id === baseLinePrimaryId;
  const baseName = normalizeBranchName(focusIsBaseLine ? focusLane.branchRef : focusLane?.baseRef);
  // The neutral line: the lane's base, or — when that base is itself a lane's
  // branch (a stack, or Primary on a feature branch) — that lane's own base,
  // followed down to a branch no lane owns as its work.
  const trunkName = useMemo(() => {
    let name = baseName;
    const seen = new Set<string>();
    for (let lane = lanesByBranch.get(name); lane && lane.id !== baseLinePrimaryId && !seen.has(lane.id); lane = lanesByBranch.get(name)) {
      seen.add(lane.id);
      const next = normalizeBranchName(lane.baseRef);
      if (!next || next === name) break;
      name = next;
    }
    return name;
  }, [baseLinePrimaryId, baseName, lanesByBranch]);
  const baseSha = trunkName ? branchTip(trunkName) : null;
  // The owner keys of the focused lane's base and of the neutral line, so a
  // row can tell whether it is on the focused lane's own line.
  const baseOwnerKey = useMemo(() => {
    const baseLane = baseName ? lanesByBranch.get(baseName) ?? null : null;
    return baseLane?.id ?? (baseName ? `base:${baseName}` : null);
  }, [baseName, lanesByBranch]);
  const baseTipLoaded = Boolean(baseSha && commits.some((c) => c.sha === baseSha));
  // Without the base tip loaded, the fork point comes from `ahead`, which may
  // not be measured yet. A stale count would put the divider (and the lane's
  // colour) on the wrong rows, so both wait for the measured value. Only a
  // lane that draws a band waits; the base line does not.
  const forkWaitsForStatus = laneForkWaitsForStatus({
    statusStale,
    baseTipLoaded,
    hasLane: focusLane != null,
    baseLinePrimary: focusIsBaseLine,
  });
  const trunkOwnerKey = useMemo(() => {
    const trunkLane = trunkName ? lanesByBranch.get(trunkName) ?? null : null;
    return trunkLane?.id ?? (trunkName ? `base:${trunkName}` : null);
  }, [lanesByBranch, trunkName]);
  const owners = useMemo(() => {
    if (commits.length === 0) return new Map<string, string>();
    const baseKey = trunkOwnerKey ?? `base:${trunkName}`;
    let baseFrom = baseTipLoaded ? baseSha : null;
    // A lane behind its base never reaches the base tip; its fork point is
    // `ahead` first-parent steps below its head.
    if (!baseFrom && !forkWaitsForStatus && focusLane && !focusIsBaseLine && trunkName === baseName && headSha && focusLane.status) {
      const bySha = new Map(commits.map((c) => [c.sha, c]));
      let sha: string | undefined = headSha;
      for (let step = 0; sha && step < Math.max(0, focusLane.status.ahead); step += 1) sha = bySha.get(sha)?.parents[0];
      if (sha && bySha.has(sha)) baseFrom = sha;
    }
    const base: LaneTip | null = baseFrom ? { key: baseKey, sha: baseFrom } : null;
    const tips: LaneTip[] = [];
    if (focusLane && headSha && !focusIsBaseLine && !forkWaitsForStatus) tips.push({ key: focusLane.id, sha: headSha });
    for (const lane of liveLanes) {
      if (lane.id === focusLane?.id || lane.id === baseLinePrimaryId) continue;
      const sha = branchTip(normalizeBranchName(lane.branchRef));
      if (sha) tips.push({ key: lane.id, sha });
    }
    return assignCommitOwners({ commitsNewestFirst: commits, base, tips });
  }, [baseLinePrimaryId, baseName, baseSha, baseTipLoaded, branchTip, commits, focusIsBaseLine, focusLane, forkWaitsForStatus, headSha, liveLanes, trunkName, trunkOwnerKey]);

  // Colour means "a lane's own work". The base line (main, or the Primary
  // lane on it) is neutral so no lane colour can be mistaken for it; other
  // branches are fainter still.
  const colorOf = useCallback((owner: string): string => {
    if (owner !== baseLinePrimaryId) {
      const lane = laneColor.get(owner);
      if (lane) return lane;
    }
    if (owner.startsWith("col:")) return "color-mix(in srgb, var(--color-fg) 24%, transparent)";
    return "color-mix(in srgb, var(--color-fg) 46%, transparent)";
  }, [baseLinePrimaryId, laneColor]);

  /* ── Refs and PRs ── */

  const lanePrMap = useLanePrsByLaneId();
  const prsByLaneId = useMemo(() => {
    const map = new Map<string, PrSummary>();
    if (pin) return map;
    for (const lane of liveLanes) {
      const prs = prsForLaneBranch(boundMachineLanePrs(lanePrMap, lane.id), lane);
      const live = prs.find((pr) => pr.state === "open" || pr.state === "draft") ?? prs[0];
      if (live) map.set(lane.id, live);
    }
    return map;
  }, [lanePrMap, liveLanes, pin]);

  const badgesBySha = useMemo(
    () => buildRefBadges({ branches, lanesByBranch, prsByLaneId, focusLaneId: laneId }),
    [branches, lanesByBranch, prsByLaneId, laneId],
  );
  const refsBySha = useMemo(() => {
    const map = new Map<string, GitBranchSummary[]>();
    for (const b of branches) {
      const sha = b.lastCommitSha?.trim();
      if (!sha) continue;
      const list = map.get(sha) ?? [];
      list.push(b);
      map.set(sha, list);
    }
    return map;
  }, [branches]);

  /* ── Visible graph ── */

  const matches = useMemo(
    () => (search ? new Set(filterCommitsForSearch(commits, refsBySha, search).map((c) => c.sha)) : null),
    [commits, refsBySha, search],
  );

  const graphRows: GraphCommit[] = useMemo(() => {
    if (matches) return contractCommitGraph(commits, (commit) => matches.has(commit.sha));
    if (fold === "tips") {
      const refShas = new Set(badgesBySha.keys());
      return contractCommitGraph(commits, branchTipKeep(commits, refShas, new Set(headSha ? [headSha] : [])));
    }
    return toGraphCommits(commits);
  }, [badgesBySha, commits, fold, headSha, matches]);
  const graphRowsRef = useRef(graphRows);
  graphRowsRef.current = graphRows;

  // "This lane": a band sits under the lane's oldest own commit, where its
  // base history starts. Base commits merged into the lane can sit above it;
  // they are drawn as base. A lane with no commits of its own gets the band
  // on top.
  const ownLaneId = scope === "lane" && focusLane && !focusIsBaseLine && !forkWaitsForStatus ? focusLane.id : null;
  const dividerAfterRow = useMemo(
    () => computeDividerAfterRow({ rows: graphRows, owners, ownLaneId, searching: matches != null }),
    [graphRows, matches, owners, ownLaneId],
  );

  // The base branch keeps column 0 so every lane branches off to its right.
  const layout: CommitGraphLayout = useMemo(
    () => buildCommitGraphLayout(graphRows, {
      trunkSha: scope === "lanes" ? baseSha : null,
      gapAfterRow: dividerAfterRow,
      gapHeight: DIVIDER_HEIGHT,
    }),
    [baseSha, dividerAfterRow, graphRows, scope],
  );

  // One author for everything loaded says nothing per row; with several, a
  // row names its author only where it changes.
  const singleAuthor = useMemo(() => {
    const first = graphRows[0]?.commit;
    return first ? graphRows.every((row) => authorKey(row.commit) === authorKey(first)) : true;
  }, [graphRows]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const graphWidth = Math.min(layout.graphWidth, COMMIT_GRAPH_PAD_LEFT * 2 + MAX_GRAPH_COLUMNS * COMMIT_GRAPH_COL_WIDTH);

  const ownerKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of layout.nodes) map.set(node.sha, owners.get(node.sha) ?? `col:${node.column}`);
    return map;
  }, [layout, owners]);

  const paint: GraphPaint = useMemo(() => ({
    ownerOf: (sha) => ownerKeys.get(sha) ?? owners.get(sha) ?? "other",
    colorOf,
    headSha,
  }), [colorOf, headSha, ownerKeys, owners]);

  // Search reads older pages on its own until it has enough to show.
  useEffect(() => {
    if (!active || !matches || !hasMore || loading || loadingMore) return;
    if (matches.size >= SEARCH_TARGET_MATCHES || commits.length >= SEARCH_AUTO_SCAN) return;
    void loadOlder(SEARCH_PAGE_SIZE);
  }, [active, commits.length, hasMore, loadOlder, loading, loadingMore, matches]);

  // Folding leaves few rows per page; keep reading until the view is filled.
  useEffect(() => {
    if (!active || matches || fold !== "tips" || !hasMore || loading || loadingMore) return;
    if (graphRows.length >= FOLD_TARGET_ROWS || commits.length >= SEARCH_AUTO_SCAN) return;
    void loadOlder(SEARCH_PAGE_SIZE);
  }, [active, commits.length, fold, graphRows.length, hasMore, loadOlder, loading, loadingMore, matches]);

  /* ── Virtual rows ── */

  const rowCount = graphRows.length;
  const gapAfter = layout.gap?.afterRow ?? null;
  /** Virtual index → commit row, the divider band, or the footer. */
  const itemAt = useCallback((index: number): { kind: "row"; row: number } | { kind: "divider" } | { kind: "footer" } => {
    if (gapAfter != null) {
      if (index === gapAfter + 1) return { kind: "divider" };
      if (index > gapAfter + 1) index -= 1;
    }
    return index < rowCount ? { kind: "row", row: index } : { kind: "footer" };
  }, [gapAfter, rowCount]);
  const virtualIndexOf = useCallback(
    (row: number) => (gapAfter != null && row > gapAfter ? row + 1 : row),
    [gapAfter],
  );
  const virtualizer = useVirtualizer({
    count: rowCount + 1 + (gapAfter != null ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (itemAt(index).kind === "divider" ? DIVIDER_HEIGHT : COMMIT_ROW_HEIGHT),
    getItemKey: (index) => {
      const item = itemAt(index);
      return item.kind === "row" ? graphRows[item.row]!.commit.sha : `__${item.kind}__`;
    },
    overscan: 16,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [gapAfter, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();

  // Put the anchored commit back where it was after a refresh.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const index = graphRows.findIndex((row) => row.commit.sha === anchor.sha);
    if (index >= 0 && scrollRef.current) scrollRef.current.scrollTop = layout.rowTop(index) + anchor.delta;
  }, [graphRows, layout]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || matches) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < COMMIT_ROW_HEIGHT * 8) void loadOlder();
  }, [loadOlder, matches]);

  /* ── Selection, keyboard, hover focus ── */

  const selectedIndex = useMemo(
    () => (selectedSha ? graphRows.findIndex((row) => row.commit.sha === selectedSha) : -1),
    [graphRows, selectedSha],
  );

  // The lane whose work a row is; null for base history. The base-line
  // Primary's rows are base history unless Primary is the lane on screen.
  const laneOwnerOf = useCallback((sha: string): string | null => {
    const owner = owners.get(sha);
    if (!owner || !laneColor.has(owner)) return null;
    return owner === baseLinePrimaryId && owner !== laneId ? null : owner;
  }, [baseLinePrimaryId, laneColor, laneId, owners]);

  // The selected commit's owner, from the rows that hold it.
  const loadedShas = useMemo(() => new Set(commits.map((c) => c.sha)), [commits]);
  useEffect(() => {
    if (!selectedSha || !viewKey || rowsViewRef.current !== viewKey || !loadedShas.has(selectedSha)) return;
    onSelectionOwner(selectedSha, laneOwnerOf(selectedSha));
  }, [laneOwnerOf, loadedShas, onSelectionOwner, selectedSha, viewKey]);

  const selectIndex = useCallback((index: number) => {
    const row = graphRowsRef.current[index];
    if (row) onSelectCommit(row.commit, laneOwnerOf(row.commit.sha));
  }, [laneOwnerOf, onSelectCommit]);

  const openIndex = useCallback((index: number) => {
    const row = graphRowsRef.current[index];
    if (!row) return;
    onSelectCommit(row.commit, laneOwnerOf(row.commit.sha));
    onOpenCommit(row.commit);
  }, [laneOwnerOf, onOpenCommit, onSelectCommit]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const count = graphRowsRef.current.length;
    if (count === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = selectedIndex < 0
        ? 0
        : Math.max(0, Math.min(count - 1, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)));
      selectIndex(next);
      virtualizer.scrollToIndex(virtualIndexOf(next), { align: "auto" });
    } else if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      openIndex(selectedIndex);
    }
  }, [openIndex, selectIndex, selectedIndex, virtualIndexOf, virtualizer]);

  const focusOwner = useCallback((owner: string | null) => {
    applyGraphFocus(rootRef.current, focusStyleRef.current, owner);
  }, []);

  const onPointerOver = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const hit = target.closest?.(".chv-hit") as HTMLElement | null;
    if (hit) focusOwner(hit.getAttribute("data-owner"));
    else if (!target.closest?.("button")) focusOwner(null);
  }, [focusOwner]);

  const onGraphClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest?.("[data-row]")?.getAttribute("data-row");
    if (row != null) selectIndex(Number(row));
  }, [selectIndex]);

  // Arriving on a lane opens its newest commit, so the details pane is never
  // blank. After a scope switch, a selection the new rows do not show gives
  // way to the newest one the same way; one they still show is kept.
  useEffect(() => {
    if (!laneId || !viewKey || graphRows.length === 0 || rowsViewRef.current !== viewKey) return;
    const newest = () => Math.max(0, headSha ? graphRows.findIndex((row) => row.commit.sha === headSha) : 0);
    if (recheckViewRef.current === viewKey) {
      recheckViewRef.current = null;
      autoSelectedRef.current = laneId;
      const kept = selectedSha ? graphRows.findIndex((row) => row.commit.sha === selectedSha) : -1;
      if (kept < 0) selectIndex(newest());
      else virtualizer.scrollToIndex(virtualIndexOf(kept), { align: "center" });
      return;
    }
    if (selectedSha || autoSelectedRef.current === laneId) return;
    autoSelectedRef.current = laneId;
    selectIndex(newest());
  }, [graphRows, headSha, laneId, selectIndex, selectedSha, viewKey, virtualIndexOf, virtualizer]);

  /* ── Row actions ── */

  const openPr = useCallback((target: { number: number; linkedPrId: string | null; owner: string; name: string }) => {
    const path = lanePrTagRoutePath({
      linkedPrId: target.linkedPrId,
      githubPrNumber: target.number,
      repoOwner: target.owner,
      repoName: target.name,
    });
    if (path) navigate(path);
  }, [navigate]);

  const badgeActions: RefBadgeActions = useMemo(() => ({
    onOpenLane,
    onFocusLane,
    onOpenPr: (badge) => {
      if (!badge.pr) return;
      openPr({ number: badge.pr.githubPrNumber, linkedPrId: badge.pr.unmapped ? null : badge.pr.id, owner: badge.pr.repoOwner, name: badge.pr.repoName });
    },
    onCopy: (text) => {
      void copyText(text)
        .then(() => notify("Branch name copied", false))
        .catch(() => notify("Could not copy branch name", true));
    },
    onFocusOwner: focusOwner,
  }), [focusOwner, notify, onFocusLane, onOpenLane, openPr]);

  const openPrNumber = useMemo(
    () => (repo ? (number: number) => openPr({ number, linkedPrId: null, owner: repo.owner, name: repo.name }) : null),
    [openPr, repo],
  );
  const colorOfLane = useCallback((id: string) => laneColor.get(id) ?? null, [laneColor]);
  const ownerOfLane = useCallback((id: string) => (laneColor.has(id) ? id : null), [laneColor]);

  // A row's git actions act on the lane whose work it is; base rows and
  // branches no lane owns act on the focused lane.
  const laneTipShas = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of liveLanes) {
      const sha = lane.id === laneId ? headSha : branchTip(normalizeBranchName(lane.branchRef));
      if (sha) map.set(lane.id, sha);
    }
    return map;
  }, [branchTip, headSha, laneId, liveLanes]);
  const laneHasOwnWorktree = useCallback(
    (id: string) => !pin && Boolean(liveLanes.find((lane) => lane.id === id)?.worktreePath?.trim()),
    [liveLanes, pin],
  );

  const worktreeMissing = error != null && /worktree is missing/i.test(error);
  const commitGitActionsEnabled = Boolean(laneId) && laneHasWorktree && !worktreeMissing;
  const onRowNotice = useCallback((message: string) => {
    notify(message, false);
    void reload({ keepAnchor: true });
  }, [notify, reload]);
  const onRowError = useCallback((message: string) => notify(message, true), [notify]);
  const rowMenu: RowMenuContext = useMemo(() => ({
    remoteMachineName,
    onNotice: onRowNotice,
    onError: onRowError,
    navigate: (path: string) => navigate(path),
  }), [navigate, onRowError, onRowNotice, remoteMachineName]);

  /* ── Render ── */

  if (!laneId) return <div className="flex-1" />;

  const firstItem = virtualItems[0] ? itemAt(virtualItems[0].index) : null;
  const lastItem = virtualItems.length ? itemAt(virtualItems[virtualItems.length - 1]!.index) : null;
  const firstRow = firstItem?.kind === "row" ? firstItem.row : Math.max(0, (gapAfter ?? 0));
  const lastRow = lastItem?.kind === "row" ? lastItem.row : rowCount - 1;
  const behind = Math.max(0, focusLane?.status?.behind ?? 0);
  const initialLoading = loading && commits.length === 0 && !error;

  let footer: React.ReactNode;
  if (loadingMore) {
    footer = (
      <span className="inline-flex items-center gap-1.5">
        <CircleNotch size={12} className="animate-spin" />
        {matches ? `Searching ${commits.length.toLocaleString()} commits` : "Loading older commits"}
      </span>
    );
  } else if (matches) {
    footer = (
      <>
        <span>{matches.size.toLocaleString()} {matches.size === 1 ? "match" : "matches"} in {commits.length.toLocaleString()} commits</span>
        {hasMore ? (
          <button type="button" className="rounded-[5px] px-1.5 py-0.5 text-fg/80 hover:bg-fg/[0.06] hover:text-fg" onClick={() => void loadOlder(SEARCH_PAGE_SIZE)}>
            Search older
          </button>
        ) : null}
      </>
    );
  } else {
    footer = (
      <>
        <span>
          {commits.length.toLocaleString()} commits
          {fold === "tips" && rowCount < commits.length ? ` · ${(commits.length - rowCount).toLocaleString()} folded` : ""}
        </span>
        {hasMore ? (
          <button type="button" className="rounded-[5px] px-1.5 py-0.5 text-fg/80 hover:bg-fg/[0.06] hover:text-fg" onClick={() => void loadOlder()}>
            Load older
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div ref={rootRef} className="chv relative flex min-h-0 flex-1 flex-col" data-testid="commit-history">
      <style ref={focusStyleRef} />
      <style>{`.chv .chv-tile g, .chv .chv-row { transition: opacity 120ms ease-out; } .chv .chv-tile .chv-edge { transition: stroke-width 120ms ease-out; }`}</style>
      {loading && commits.length > 0 ? (
        <div role="progressbar" aria-label="Refreshing commits" className="absolute inset-x-0 top-0 z-[2] h-px overflow-hidden">
          <div className="h-full w-1/3 animate-[chv-sweep_1.1s_ease-in-out_infinite] bg-[var(--color-accent)]" />
          <style>{`@keyframes chv-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }`}</style>
        </div>
      ) : null}
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Warning size={20} className="text-[var(--color-warning)]" />
          <p className="max-w-[420px] text-[13px] text-fg/85">{error}</p>
          {!worktreeMissing ? (
            <button
              type="button"
              onClick={() => void reload({ keepAnchor: false })}
              className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] text-fg/80 hover:bg-fg/[0.06] hover:text-fg"
            >
              <ArrowClockwise size={13} />
              Try again
            </button>
          ) : null}
        </div>
      ) : initialLoading ? (
        <div className="flex-1 overflow-hidden" aria-busy aria-label={laneName ? `Loading ${laneName}` : "Loading commits"}>
          {Array.from({ length: 14 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-3" style={{ height: COMMIT_ROW_HEIGHT, opacity: 1 - index * 0.06 }}>
              <span className="h-2 w-2 shrink-0 rounded-full bg-fg/[0.08]" />
              <span className="h-2.5 rounded bg-fg/[0.06]" style={{ width: `${38 + ((index * 37) % 40)}%` }} />
              <span className="ml-auto h-2.5 w-16 rounded bg-fg/[0.04]" />
            </div>
          ))}
        </div>
      ) : rowCount === 0 && !matches ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-fg">No commits yet</div>
      ) : (
        <div
          ref={scrollRef}
          role="grid"
          aria-label={laneName ? `Commits of ${laneName}` : "Commits"}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={onScroll}
          onPointerOver={onPointerOver}
          onPointerLeave={() => focusOwner(null)}
          onClick={onGraphClick}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            <CommitGraphLayer layout={layout} paint={paint} firstRow={firstRow} lastRow={lastRow} width={graphWidth} />
            {virtualItems.map((item) => {
              const kind = itemAt(item.index);
              if (kind.kind === "divider") {
                return (
                  <div
                    key="__divider__"
                    className="absolute left-0 right-0 flex items-center gap-2 pr-3 text-[11.5px]"
                    style={{ height: DIVIDER_HEIGHT, transform: `translateY(${item.start}px)`, paddingLeft: graphWidth + 8 }}
                    data-testid="history-base-divider"
                  >
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium text-fg/75">
                      <BranchIcon size={11} className="opacity-70" />
                      {baseName || "base"}
                    </span>
                    {behind > 0 ? (
                      <span className={`shrink-0 tabular-nums text-muted-fg/70 transition-opacity duration-150${statusStale ? " opacity-50" : ""}`} data-stale={statusStale || undefined}>{behind.toLocaleString()} behind</span>
                    ) : null}
                    <span aria-hidden className="h-px min-w-0 flex-1 bg-fg/[0.07]" />
                  </div>
                );
              }
              if (kind.kind === "footer") {
                return (
                  <div
                    key="__footer__"
                    className="absolute left-0 right-0 flex items-center gap-2 px-3 text-[11.5px] text-muted-fg/70"
                    style={{ height: COMMIT_ROW_HEIGHT, transform: `translateY(${item.start}px)`, paddingLeft: Math.max(12, graphWidth) }}
                  >
                    {rowCount === 0 && matches && !loadingMore && !hasMore ? <span>No commits match</span> : footer}
                  </div>
                );
              }
              const rowIndex = kind.row;
              const row = graphRows[rowIndex]!;
              const commit = row.commit;
              const owner = paint.ownerOf(commit.sha);
              // "This lane" only ever walks HEAD, so every row is on it. In
              // "All lanes", a row is on the focused lane only when it is the
              // lane's own commit or base history — never another lane's.
              const rowLaneId = laneOwnerOf(commit.sha);
              const actionLaneId = rowLaneId ?? laneId;
              const commitOnLaneHistory = scope === "lane"
                || rowLaneId != null
                || (baseOwnerKey != null && owner === baseOwnerKey)
                || (trunkOwnerKey != null && owner === trunkOwnerKey);
              // The first row under the divider starts a new run of authors.
              const prevCommit = rowIndex > 0 && rowIndex !== (gapAfter ?? -2) + 1 ? graphRows[rowIndex - 1]!.commit : null;
              return (
                  <CommitRow
                    key={commit.sha}
                    commit={commit}
                    index={rowIndex}
                    start={item.start}
                    graphWidth={graphWidth}
                    owner={owner}
                    selected={rowIndex === selectedIndex}
                    muted={ownLaneId != null && owners.get(commit.sha) !== ownLaneId}
                    author={singleAuthor ? "hidden" : !prevCommit || authorKey(prevCommit) !== authorKey(commit) ? "shown" : "blank"}
                    isHead={commit.sha === headSha}
                    actionLaneId={actionLaneId}
                    actionIsHead={commit.sha === (rowLaneId ? laneTipShas.get(rowLaneId) : headSha)}
                    actionHasWorktree={rowLaneId && rowLaneId !== laneId ? laneHasOwnWorktree(rowLaneId) && commitGitActionsEnabled : commitGitActionsEnabled}
                    commitOnLaneHistory={commitOnLaneHistory}
                    badges={badgesBySha.get(commit.sha)}
                    columns={columns}
                    compact={compact}
                    medium={medium}
                    wide={wide}
                    focusLaneId={laneId}
                    menu={rowMenu}
                    badgeActions={badgeActions}
                    colorOfLane={colorOfLane}
                    ownerOfLane={ownerOfLane}
                    onSelect={selectIndex}
                    onOpen={openIndex}
                    onOpenPrNumber={openPrNumber}
                  />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
