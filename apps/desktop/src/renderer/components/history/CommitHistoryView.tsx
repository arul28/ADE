import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowClockwise, CircleNotch, GitPullRequest, Warning } from "@phosphor-icons/react";
import type {
  GitBranchSummary,
  GitCommitSummary,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { ProviderLogo } from "../shared/ProviderLogos";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { lanePrTagRoutePath } from "../lanes/lanePageModel";
import { boundMachineLanePrs, useLanePrsByLaneId } from "../terminals/useLanePrs";
import { HistoryGitContextMenu } from "./HistoryGitContextMenu";
import { filterCommitsForSearch } from "./historySearch";
import {
  assignCommitOwners,
  branchTipKeep,
  buildCommitGraphLayout,
  COMMIT_GRAPH_COL_WIDTH,
  COMMIT_GRAPH_PAD_LEFT,
  COMMIT_ROW_HEIGHT,
  contractCommitGraph,
  toGraphCommits,
  type CommitGraphLayout,
  type GraphCommit,
  type LaneTip,
} from "./commitGraphLayout";
import { CommitGraphLayer, applyGraphFocus, type GraphPaint } from "./CommitGraphLayer";
import { CommitRefBadges, type RefBadgeActions } from "./CommitRefBadges";
import {
  buildRefBadges,
  commitAgentProvider,
  githubAvatarForEmail,
  githubRepoFromRemote,
  normalizeBranchName,
  shortWhen,
  splitPrSuffix,
  type CommitRefBadge,
} from "./commitRowModel";
import { useCommitViewPrefs, type CommitColumns } from "./commitViewPrefs";

const PAGE_SIZE = 100;
/** Search keeps reading older pages until it has this many matches… */
const SEARCH_TARGET_MATCHES = 60;
/** …or has read this many commits. "Search older" goes further on request. */
const SEARCH_AUTO_SCAN = 3_000;
const SEARCH_PAGE_SIZE = 500;
const SEARCH_DEBOUNCE_MS = 70;
/** Folded to branch tips, older pages are read until this many rows show. */
const FOLD_TARGET_ROWS = 60;

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
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
  if (/^Lane worktree is missing\./i.test(message)) return message;
  if (/git working directory not found:/i.test(message)) {
    return "Lane worktree is missing. Restore or recreate the lane worktree before viewing commits.";
  }
  return message || "Unable to load commit history.";
}

function copyText(text: string): void {
  void window.ade.app.writeClipboardText(text).catch(() => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });
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

/* ───────────────────────── Row ───────────────────────── */

function AuthorAvatar({ name, email }: { name: string; email?: string }) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : githubAvatarForEmail(email);
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-4 w-4 shrink-0 rounded-full"
        style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-fg) 12%, transparent)" }}
      />
    );
  }
  const letter = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[9px] font-semibold text-fg/70"
    >
      {letter}
    </span>
  );
}

function ShaCell({ commit }: { commit: GitCommitSummary }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${commit.sha}`}
      onClick={(event) => {
        event.stopPropagation();
        copyText(commit.sha);
        setCopied(true);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "w-[64px] shrink-0 rounded-[5px] px-1 text-left font-mono text-[11px] tabular-nums transition-colors duration-100",
        copied ? "text-[var(--color-success)]" : "text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg",
      )}
    >
      {copied ? "copied" : commit.shortSha}
    </button>
  );
}

type RowMenuContext = {
  laneId: string;
  hasWorktree: boolean;
  remoteMachineName: string | null;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  navigate: (path: string) => void;
};

type RowProps = {
  commit: GitCommitSummary;
  index: number;
  start: number;
  graphWidth: number;
  owner: string;
  selected: boolean;
  isHead: boolean;
  badges: CommitRefBadge[] | undefined;
  columns: CommitColumns;
  compact: boolean;
  medium: boolean;
  wide: boolean;
  focusLaneId: string | null;
  menu: RowMenuContext;
  badgeActions: RefBadgeActions;
  colorOfLane: (laneId: string) => string | null;
  ownerOfLane: (laneId: string) => string | null;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onOpenPrNumber: ((pr: number) => void) | null;
};

const CommitRow = React.memo(function CommitRow({
  commit,
  index,
  start,
  graphWidth,
  owner,
  selected,
  isHead,
  badges,
  columns,
  compact,
  medium,
  wide,
  focusLaneId,
  menu,
  badgeActions,
  colorOfLane,
  ownerOfLane,
  onSelect,
  onOpen,
  onOpenPrNumber,
}: RowProps) {
  const agent = commitAgentProvider(commit);
  const { text, pr } = splitPrSuffix(commit.subject);
  return (
    <HistoryGitContextMenu
      laneId={menu.laneId}
      commit={commit}
      isHead={isHead}
      hasWorktree={menu.hasWorktree}
      remoteMachineName={menu.remoteMachineName}
      onNotice={menu.onNotice}
      onError={menu.onError}
      navigate={menu.navigate}
    >
    <div
      role="row"
      aria-selected={selected}
      data-owner={owner}
      data-sha={commit.sha}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onOpen(index)}
      className={cn(
        "chv-row absolute left-0 right-0 flex cursor-default items-center gap-2 pr-2",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
          : "hover:bg-white/[0.035]",
      )}
      style={{ height: COMMIT_ROW_HEIGHT, transform: `translateY(${start}px)` }}
    >
      {selected ? <span aria-hidden className="absolute bottom-1 left-0 top-1 w-[2px] rounded-r bg-[var(--color-accent)]" /> : null}
      <span className="shrink-0" style={{ width: graphWidth }} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {badges && badges.length > 0 ? (
          <CommitRefBadges
            badges={badges}
            max={wide ? 2 : 1}
            colorOfLane={colorOfLane}
            ownerOfLane={ownerOfLane}
            focusLaneId={focusLaneId}
            actions={badgeActions}
          />
        ) : null}
        {agent ? (
          <span className="inline-flex shrink-0" title={`Co-authored by ${agent.name}`}>
            <ProviderLogo family={agent.provider} size={13} />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate text-[12.5px]",
            isHead ? "font-medium text-fg" : "text-fg/90",
          )}
        >
          {text}
        </span>
        {pr != null ? (
          onOpenPrNumber ? (
            <button
              type="button"
              title={`Open PR #${pr}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenPrNumber(pr);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-[5px] px-1 text-[11px] tabular-nums text-muted-fg/80 transition-colors duration-100 hover:bg-white/[0.06] hover:text-fg"
            >
              <GitPullRequest size={11} aria-hidden />
              {pr}
            </button>
          ) : (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/70">#{pr}</span>
          )
        ) : null}
      </span>
      {columns.author && !compact ? (
        <span
          className={cn("flex shrink-0 items-center gap-1.5 overflow-hidden", medium ? "w-4" : "w-[132px]")}
          title={commit.authorEmail ? `${commit.authorName} <${commit.authorEmail}>` : commit.authorName}
        >
          <AuthorAvatar name={commit.authorName} email={commit.authorEmail} />
          {medium ? null : <span className="min-w-0 truncate text-[12px] text-muted-fg">{commit.authorName}</span>}
        </span>
      ) : null}
      {columns.date ? (
        <span
          className="w-[52px] shrink-0 text-right text-[11.5px] tabular-nums text-muted-fg/70"
          title={new Date(commit.authoredAt).toLocaleString()}
        >
          {shortWhen(commit.authoredAt)}
        </span>
      ) : null}
      {columns.sha && !compact ? <ShaCell commit={commit} /> : null}
    </div>
    </HistoryGitContextMenu>
  );
});

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
  onOpenCommit: (commit: GitCommitSummary) => void;
  onFocusLane: (laneId: string) => void;
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
  onOpenCommit,
  onFocusLane,
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
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [repo, setRepo] = useState<{ owner: string; name: string } | null>(null);
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  /** Scroll anchor captured before a refresh replaces the rows. */
  const anchorRef = useRef<{ sha: string; delta: number } | null>(null);

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
          const topIndex = Math.floor(el.scrollTop / COMMIT_ROW_HEIGHT);
          const sha = graphRowsRef.current[topIndex]?.commit.sha;
          if (sha) anchorRef.current = { sha, delta: el.scrollTop - topIndex * COMMIT_ROW_HEIGHT };
        }
      }
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
  }, [laneId, pin, readPage]);

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
      if (loadSeq.current === seq) setNotice({ text: formatTimelineError(err), error: true });
    } finally {
      if (loadSeq.current === seq) setLoadingMore(false);
    }
  }, [hasMore, laneId, loading, loadingMore, readPage]);

  // A new lane or scope starts over from the top.
  useEffect(() => {
    loadSeq.current += 1;
    setCommits([]);
    setBranches([]);
    setHasMore(false);
    setError(null);
    setNotice(null);
    setLoading(false);
    setLoadingMore(false);
    anchorRef.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [laneId, scope]);

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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 5000 : 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /* ── Lanes, owners, colours ── */

  const focusLane = useMemo(() => lanes.find((lane) => lane.id === laneId) ?? null, [lanes, laneId]);
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
  const primaryLane = useMemo(() => liveLanes.find((lane) => lane.laneType === "primary") ?? null, [liveLanes]);

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

  const baseName = normalizeBranchName(focusLane?.laneType === "primary" ? focusLane.branchRef : focusLane?.baseRef);
  const baseSha = baseName ? branchTip(baseName) : null;
  const owners = useMemo(() => {
    if (commits.length === 0) return new Map<string, string>();
    const baseLane = baseName ? lanesByBranch.get(baseName) ?? null : null;
    const baseKey = baseLane?.id ?? `base:${baseName}`;
    let baseFrom = baseSha && commits.some((c) => c.sha === baseSha) ? baseSha : null;
    // A lane behind its base never reaches the base tip; its fork point is
    // `ahead` first-parent steps below its head.
    if (!baseFrom && focusLane && focusLane.laneType !== "primary" && headSha && focusLane.status) {
      const bySha = new Map(commits.map((c) => [c.sha, c]));
      let sha: string | undefined = headSha;
      for (let step = 0; sha && step < Math.max(0, focusLane.status.ahead); step += 1) sha = bySha.get(sha)?.parents[0];
      if (sha && bySha.has(sha)) baseFrom = sha;
    }
    const base: LaneTip | null = baseFrom ? { key: baseKey, sha: baseFrom } : null;
    const tips: LaneTip[] = [];
    if (focusLane && headSha && focusLane.laneType !== "primary") tips.push({ key: focusLane.id, sha: headSha });
    for (const lane of liveLanes) {
      if (lane.id === focusLane?.id || lane.laneType === "primary") continue;
      const sha = branchTip(normalizeBranchName(lane.branchRef));
      if (sha) tips.push({ key: lane.id, sha });
    }
    return assignCommitOwners({ commitsNewestFirst: commits, base, tips });
  }, [baseName, baseSha, branchTip, commits, focusLane, headSha, lanesByBranch, liveLanes]);

  const colorOf = useCallback((owner: string): string => {
    const lane = laneColor.get(owner);
    if (lane) return `color-mix(in srgb, ${lane} 86%, var(--color-bg))`;
    if (owner.startsWith("base:")) {
      const primary = primaryLane ? laneColor.get(primaryLane.id) : null;
      return primary ? `color-mix(in srgb, ${primary} 86%, var(--color-bg))` : "color-mix(in srgb, var(--color-fg) 55%, transparent)";
    }
    return "color-mix(in srgb, var(--color-fg) 32%, transparent)";
  }, [laneColor, primaryLane]);

  /* ── Refs and PRs ── */

  const lanePrMap = useLanePrsByLaneId();
  const prsByLaneId = useMemo(() => {
    const map = new Map<string, PrSummary>();
    if (pin) return map;
    for (const lane of liveLanes) {
      const prs = boundMachineLanePrs(lanePrMap, lane.id);
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

  // The base branch keeps column 0 so every lane branches off to its right.
  const layout: CommitGraphLayout = useMemo(
    () => buildCommitGraphLayout(graphRows, scope === "lanes" ? baseSha : null),
    [baseSha, graphRows, scope],
  );

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
  const virtualizer = useVirtualizer({
    count: rowCount + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    getItemKey: (index) => graphRows[index]?.commit.sha ?? "__footer__",
    overscan: 16,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Put the anchored commit back where it was after a refresh.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const index = graphRows.findIndex((row) => row.commit.sha === anchor.sha);
    if (index >= 0 && scrollRef.current) scrollRef.current.scrollTop = index * COMMIT_ROW_HEIGHT + anchor.delta;
  }, [graphRows]);

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

  const laneOwnerOf = useCallback((sha: string): string | null => {
    const owner = owners.get(sha);
    return owner && laneColor.has(owner) ? owner : null;
  }, [laneColor, owners]);

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
      virtualizer.scrollToIndex(next, { align: "auto" });
    } else if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      openIndex(selectedIndex);
    }
  }, [openIndex, selectIndex, selectedIndex, virtualizer]);

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

  // The first load of a lane opens its newest commit, so the details pane is never blank.
  const autoSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!laneId || selectedSha || graphRows.length === 0 || autoSelectedRef.current === laneId) return;
    autoSelectedRef.current = laneId;
    const index = Math.max(0, headSha ? graphRows.findIndex((row) => row.commit.sha === headSha) : 0);
    selectIndex(index);
  }, [graphRows, headSha, laneId, selectIndex, selectedSha]);

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
    onOpenLane: (id) => {
      const params = new URLSearchParams({ laneId: id });
      navigate(`/lanes?${params.toString()}`);
    },
    onFocusLane,
    onOpenPr: (badge) => {
      if (!badge.pr) return;
      openPr({ number: badge.pr.githubPrNumber, linkedPrId: badge.pr.unmapped ? null : badge.pr.id, owner: badge.pr.repoOwner, name: badge.pr.repoName });
    },
    onCopy: (text) => {
      copyText(text);
      setNotice({ text: "Branch name copied", error: false });
    },
    onFocusOwner: focusOwner,
  }), [focusOwner, navigate, onFocusLane, openPr]);

  const openPrNumber = useMemo(
    () => (repo ? (number: number) => openPr({ number, linkedPrId: null, owner: repo.owner, name: repo.name }) : null),
    [openPr, repo],
  );
  const colorOfLane = useCallback((id: string) => laneColor.get(id) ?? null, [laneColor]);
  const ownerOfLane = useCallback((id: string) => (laneColor.has(id) ? id : null), [laneColor]);

  const worktreeMissing = error != null && /worktree is missing/i.test(error);
  const commitGitActionsEnabled = Boolean(laneId) && laneHasWorktree && !worktreeMissing;
  const onRowNotice = useCallback((message: string) => {
    setNotice({ text: message, error: false });
    void reload({ keepAnchor: true });
  }, [reload]);
  const onRowError = useCallback((message: string) => setNotice({ text: message, error: true }), []);
  const rowMenu: RowMenuContext = useMemo(() => ({
    laneId: laneId ?? "",
    hasWorktree: commitGitActionsEnabled,
    remoteMachineName,
    onNotice: onRowNotice,
    onError: onRowError,
    navigate: (path: string) => navigate(path),
  }), [commitGitActionsEnabled, laneId, navigate, onRowError, onRowNotice, remoteMachineName]);

  /* ── Render ── */

  if (!laneId) return <div className="flex-1" />;

  const firstRow = virtualItems[0]?.index ?? 0;
  const lastRow = Math.min(rowCount - 1, virtualItems[virtualItems.length - 1]?.index ?? 0);
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
          <button type="button" className="rounded-[5px] px-1.5 py-0.5 text-fg/80 hover:bg-white/[0.06] hover:text-fg" onClick={() => void loadOlder(SEARCH_PAGE_SIZE)}>
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
          <button type="button" className="rounded-[5px] px-1.5 py-0.5 text-fg/80 hover:bg-white/[0.06] hover:text-fg" onClick={() => void loadOlder()}>
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
      {notice ? (
        <div
          className={cn(
            "absolute bottom-3 left-1/2 z-[3] -translate-x-1/2 truncate rounded-[8px] border border-white/[0.08] bg-[var(--color-card)] px-3 py-1.5 text-[12px] shadow-lg",
            notice.error ? "text-[var(--color-error)]" : "text-fg/85",
          )}
          style={{ maxWidth: "80%" }}
          title={notice.text}
        >
          {notice.text}
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
              className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] text-fg/80 hover:bg-white/[0.06] hover:text-fg"
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
              <span className="h-2 w-2 shrink-0 rounded-full bg-white/[0.08]" />
              <span className="h-2.5 rounded bg-white/[0.06]" style={{ width: `${38 + ((index * 37) % 40)}%` }} />
              <span className="ml-auto h-2.5 w-16 rounded bg-white/[0.04]" />
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
              if (item.index >= rowCount) {
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
              const row = graphRows[item.index]!;
              const commit = row.commit;
              return (
                  <CommitRow
                    key={commit.sha}
                    commit={commit}
                    index={item.index}
                    start={item.start}
                    graphWidth={graphWidth}
                    owner={paint.ownerOf(commit.sha)}
                    selected={item.index === selectedIndex}
                    isHead={commit.sha === headSha}
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
