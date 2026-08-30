/**
 * CI / Checks — the pipeline surface.
 *
 * ## The three things this file is responsible for
 *
 * 1. **Never showing a layout it is about to replace.** The dependency graph
 *    arrives from an async service call. Rendering the flat, `checks`-derived
 *    fallback while that call is in flight meant the user watched two to three
 *    seconds of the wrong layout and then a jarring snap into a DAG. Now the
 *    resolution has three explicit outcomes — charted / resolving / no graph —
 *    and only the *final* one of those is ever a flat list. While it resolves we
 *    render a skeleton in the graph's own footprint, and a cached graph renders
 *    instantly with no fetch at all.
 *
 * 2. **Staying inside the GitHub quota.** The graph endpoint is expensive: on
 *    the service side it re-reads the Actions runs page, the per-run jobs, the
 *    combined status and the check-runs page — the same reads the detail pane's
 *    own loop already made. So this tab adds **no** poll loop of its own; it
 *    fetches the graph's *shape* at most once per PR head SHA (plus one bounded
 *    retry if CI had not started yet), caches it across mounts, and re-derives
 *    live state from the `checks`/`actionRuns` props the pane already polls. The
 *    fetch is gated on the shared poll governor, and a rejection is never cached
 *    — an unreadable answer must not be stored wearing the costume of an empty
 *    one. See docs/features/pull-requests/README.md, "Keeping automatic GitHub
 *    reads inside the quota".
 *
 * 3. **Keeping React Flow out of the first-load bundle.** The canvas is behind
 *    `React.lazy`; nothing in this file may import `@xyflow/react`.
 */

import React from "react";
import {
  ArrowClockwise,
  ArrowsClockwise,
  ListBullets,
  Path,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

import type {
  PrActionRun,
  PrCheck,
  PrChecksStatus,
  PrCheckLogExcerpt,
  PrPipelineState,
  PrRerunChecksTarget,
  PrWorkflowGraph,
  PrWorkflowGraphNode,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, RADII, SANS_FONT, SPACING } from "../../lanes/laneDesignTokens";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { PrCommandPalettes, type PaletteCheck } from "../shared/PrCommandPalettes";
import { PrSection, prFlatButton } from "../shared/prSection";
import {
  PrCheckLogDrawer,
  type PrCheckLogDrawerState,
} from "../shared/PrCheckLogDrawer";
import {
  buildUnifiedChecks,
  checkElapsedMs,
  pipelineStateOf,
  type UnifiedCheckItem,
} from "../shared/prUnifiedChecks";
import { fetchCheckLogForState, fetchWorkflowGraph } from "./prChecksApi";
import {
  buildLogExcerptMarkdown,
  deriveFallbackGraph,
  failingNodes,
  graphBuckets,
  graphUnavailableCopy,
  hydrateWorkflowGraph,
  nodeElapsedMs,
  pipelineElapsedMs,
  readStoredChecksView,
  resolveLogJobId,
  writeStoredChecksView,
  type ChecksView,
} from "./prChecksModel";
import {
  checksGraphCacheKey,
  fetchChecksGraphOnce,
  invalidateChecksGraphCache,
  isChartedGraph,
  readChecksGraphCache,
  shouldRefetchOnFirstActionRun,
  writeChecksGraphCache,
} from "./prChecksGraphCache";
import { groupChecksForList, rowLabel } from "./prChecksListModel";
import { PrChecksGraphSkeleton } from "./PrChecksGraphSkeleton";
import { OpenOnGitHubButton, STATE_COLOR, STATE_LABEL, StateIcon, fmtMs, tint } from "./prChecksVisuals";

/**
 * React Flow is ~100 KB of JavaScript plus a stylesheet, and the PR detail pane
 * is reachable from the web client's first-loaded bundle (it is not its own
 * route). `scripts/check-webclient-entry.mjs` caps the entry graph at 1000 KB
 * raw and rejects any eagerly linked chunk whose name matches /graph/, so this
 * boundary is enforced by the build, not by convention.
 */
const PrChecksGraphCanvas = React.lazy(() => import("./PrChecksGraphCanvas"));

const LIVE_TICK_MS = 1_000;

/**
 * Automatic graph reads allowed per head SHA before the tab stops asking.
 *
 * Two, so a single transient failure still recovers on its own, and a PR whose
 * Actions read never succeeds costs at most two reads instead of one every time
 * the poll governor changes state.
 */
const MAX_AUTO_GRAPH_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Live clock — only ticks while something is actually moving.
// ---------------------------------------------------------------------------

function useLiveNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function SegButton({
  active, onClick, children, testId, icon: Glyph,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
  icon?: Icon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className="inline-flex h-[22px] items-center gap-1 rounded px-2.5 text-[11px] font-medium"
      style={{
        border: "none",
        cursor: "pointer",
        borderRadius: RADII.sm,
        fontFamily: SANS_FONT,
        background: active ? COLORS.cardBgSolid : "transparent",
        color: active ? COLORS.textPrimary : COLORS.textMuted,
      }}
    >
      {Glyph ? <Glyph size={11} /> : null}
      {children}
    </button>
  );
}

function SmallButton({
  onClick, children, tone = "neutral", disabled = false, testId, title,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "warn";
  disabled?: boolean;
  testId?: string;
  title?: string;
}) {
  const toneColor = tone === "warn" ? COLORS.warning : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="shrink-0"
      style={{
        ...prFlatButton(toneColor ? { tone: toneColor } : undefined),
        height: 26,
        color: toneColor ?? COLORS.textSecondary,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------

function StripSegment({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="flex flex-col gap-[2px] pr-[18px]">
      <span
        className="text-[9.5px] uppercase"
        style={{ letterSpacing: "0.09em", color: COLORS.textDim, fontFamily: SANS_FONT }}
      >
        {label}
      </span>
      <span
        className="text-[14px] font-semibold tabular-nums"
        style={{ color: color ?? COLORS.textPrimary, fontFamily: SANS_FONT }}
      >
        {value}
      </span>
    </div>
  );
}

/** Pass/fail of every workflow run on this PR, oldest → newest. */
function RunHistorySparkline({ runs }: { runs: PrActionRun[] }) {
  const ordered = React.useMemo(
    () => [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-24),
    [runs],
  );
  if (ordered.length < 2) return null;
  return (
    <span
      className="flex h-[14px] items-end gap-[2px]"
      data-testid="pr-checks-run-sparkline"
      title={`${ordered.length} runs on this PR`}
    >
      {ordered.map((run) => {
        // The canonical ladder, not a local one: the hand-rolled copy this
        // replaces called a queued run "running" and an unknown conclusion
        // "skipped", so the sparkline disagreed with every other surface.
        const state: PrPipelineState = pipelineStateOf(run);
        // Height is a second, non-colour channel: a failure is a tall bar.
        const height = state === "passed" ? 6 : state === "failed" ? 14 : 10;
        return (
          <i
            key={run.id}
            className="block w-[3px] rounded-[1px]"
            style={{ height, background: STATE_COLOR[state] }}
          />
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Flat row — one check, one line
// ---------------------------------------------------------------------------

const CheckRow = React.memo(function CheckRow({
  name, label, state, elapsedMs, detailsUrl, selected, onSelect, badge, divided,
}: {
  /** Full, unabbreviated name — the stable identity for tests and tooling. */
  name: string;
  /** What the user reads; the section header already carries the workflow. */
  label: string;
  state: PrPipelineState;
  elapsedMs: number | null;
  detailsUrl: string | null;
  selected?: boolean;
  onSelect?: () => void;
  badge?: string | null;
  divided?: boolean;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? Boolean(selected) : undefined}
      onClick={onSelect}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.();
        }
      } : undefined}
      data-testid="pr-checks-row"
      data-check-name={name}
      data-state={state}
      className="group flex items-center gap-2 py-[6px] pl-1 pr-1.5 text-[11.5px]"
      style={{
        borderTop: divided ? `1px solid ${COLORS.borderMuted}` : undefined,
        background: selected ? tint(COLORS.accent, 9) : "transparent",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <StateIcon state={state} />
      <span
        className="min-w-0 flex-1 truncate"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
        title={name}
      >
        {label}
      </span>
      {badge ? (
        <span
          className="shrink-0 text-[9.5px] uppercase"
          style={{ letterSpacing: "0.06em", color: COLORS.textDim, fontFamily: MONO_FONT }}
        >
          {badge}
        </span>
      ) : null}
      {detailsUrl ? <OpenOnGitHubButton url={detailsUrl} name={name} /> : null}
      <span
        className="w-[58px] shrink-0 text-right text-[10px] tabular-nums"
        style={{
          color: state === "running" ? COLORS.warning : COLORS.textDim,
          fontFamily: MONO_FONT,
        }}
      >
        {fmtMs(elapsedMs) ?? STATE_LABEL[state]}
      </span>
    </div>
  );
});

/**
 * One honest sentence about why there is no dependency graph, with the retry a
 * user can press when the reason was "GitHub did not answer".
 */
function GraphUnavailableNote({
  copy, onRetry,
}: { copy: string; onRetry?: () => void }) {
  return (
    <div
      className="mb-2 flex items-start gap-2 text-[11px]"
      style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
      data-testid="pr-checks-graph-unavailable-note"
    >
      <WarningCircle size={13} style={{ color: COLORS.textDim, flexShrink: 0, marginTop: 1 }} />
      <span className="min-w-0">{copy}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="pr-checks-graph-retry"
          className="ml-auto shrink-0"
          style={{ ...prFlatButton(), height: 22, fontSize: 10.5 }}
        >
          <ArrowClockwise size={11} /> Retry
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

/**
 * The subset of the shared PR poll governor this tab needs.
 *
 * Optional so the component is renderable in isolation, but in the app
 * `PrDetailPane` always supplies it: every automatic GitHub read on this
 * surface stands down together, and a graph fetch that ignored the brake would
 * be exactly the un-governed foreground reader the 2026-08-17 quota incident was
 * about.
 */
export type PrChecksPollGovernor = {
  isGithubPollStoodDown: () => boolean;
  noteGithubReadFailure: () => void;
  noteGithubReadSuccess: () => void;
  /** Changes only when a stand-down arms or clears — the retry signal. */
  githubPollGeneration: number;
};

const UNGOVERNED: PrChecksPollGovernor = {
  isGithubPollStoodDown: () => false,
  noteGithubReadFailure: () => {},
  noteGithubReadSuccess: () => {},
  githubPollGeneration: 0,
};

/**
 * How the graph's *shape* resolved for one PR head SHA.
 *
 * `unreachable` is deliberately distinct from a resolved graph that happens to
 * have no edges: one means "GitHub would not tell us", the other means "there is
 * genuinely nothing to chart". Collapsing them is what let a failed read look
 * like a settled empty answer.
 */
type ChecksGraphState = {
  key: string;
  status: "resolving" | "resolved" | "unreachable";
  /** `null` = the runtime answered and there is no graph. */
  serviceGraph: PrWorkflowGraph | null;
};

export type PrChecksTabProps = {
  pr: {
    id: string;
    projectId: string;
    repoOwner: string;
    repoName: string;
    githubPrNumber: number;
    headSha?: string | null;
  };
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  actionBusy: boolean;
  /**
   * The canonical rollup. `buckets` folds `graph.externalChecks` into its
   * counts, so with no Actions run three preview-bot successes rendered
   * "Passed 3/3" in green — contradicting the header pill on the same screen.
   */
  checksStatus?: PrChecksStatus | null;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  focusedCheckId?: string | null;
  onFocusedCheckConsumed?: () => void;
  /** Bumped by the `g k` chord in `PrDetailPane` to open the checks palette. */
  paletteRequest?: number;
  /** Opens the lane's most recent Work chat with the failing log prefilled. */
  onFixInChat?: (excerpt: PrCheckLogExcerpt) => void;
  /** Shared brake for every automatic GitHub read on the PRs surface. */
  pollGovernor?: PrChecksPollGovernor;
};

export function PrChecksTab({
  pr,
  checks,
  actionRuns,
  actionBusy,
  checksStatus,
  onRerunChecks,
  focusedCheckId,
  onFocusedCheckConsumed,
  paletteRequest = 0,
  onFixInChat,
  pollGovernor = UNGOVERNED,
}: PrChecksTabProps) {
  const { isGithubPollStoodDown, noteGithubReadFailure, noteGithubReadSuccess, githubPollGeneration } =
    pollGovernor;

  const [view, setView] = React.useState<ChecksView>(() => readStoredChecksView(pr.projectId) ?? "graph");
  const [drawer, setDrawer] = React.useState<PrCheckLogDrawerState | null>(null);
  /**
   * The user asked for this job's log explicitly. A passed job does not fetch
   * one on open — most jobs pass, so that alone keeps the common case off the
   * GitHub budget entirely.
   */
  const [forceLog, setForceLog] = React.useState(false);
  const [excerpt, setExcerpt] = React.useState<PrCheckLogExcerpt | null>(null);
  const [logLoading, setLogLoading] = React.useState(false);
  const [logError, setLogError] = React.useState<string | null>(null);
  const { copy, copied, reset: resetCopied } = useCopyToClipboard({ timeout: 1600 });
  const [selectedAttempt, setSelectedAttempt] = React.useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [focusedFailureIdx, setFocusedFailureIdx] = React.useState(0);
  const autoOpenedForPrRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setView(readStoredChecksView(pr.projectId) ?? "graph");
  }, [pr.projectId]);

  const selectView = React.useCallback((next: ChecksView) => {
    setView(next);
    writeStoredChecksView(pr.projectId, next);
  }, [pr.projectId]);

  // ---- attempts ---------------------------------------------------------
  const attempts = React.useMemo(() => {
    const seen = new Set<number>();
    for (const run of actionRuns) seen.add(run.runAttempt ?? 1);
    return Array.from(seen).sort((a, b) => a - b);
  }, [actionRuns]);
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1]! : 1;
  const viewingLatestAttempt = selectedAttempt == null || selectedAttempt === latestAttempt;
  const hasActionRuns = actionRuns.length > 0;

  React.useEffect(() => {
    if (selectedAttempt != null && !attempts.includes(selectedAttempt)) {
      setSelectedAttempt(null);
    }
  }, [attempts, selectedAttempt]);

  const attemptRuns = React.useMemo(
    () => (viewingLatestAttempt ? actionRuns : actionRuns.filter((r) => (r.runAttempt ?? 1) === selectedAttempt)),
    [actionRuns, selectedAttempt, viewingLatestAttempt],
  );

  const unified = React.useMemo(
    () => buildUnifiedChecks(checks, attemptRuns),
    [checks, attemptRuns],
  );

  // ---- graph shape resolution -------------------------------------------
  // One fetch per (PR, head SHA), cached across mounts, plus at most one bounded
  // retry when CI reports its first run. No timer, ever.
  const graphKey = checksGraphCacheKey(pr.id, pr.headSha);
  const [graphState, setGraphState] = React.useState<ChecksGraphState>(() => {
    const cached = readChecksGraphCache(graphKey);
    return cached
      ? { key: graphKey, status: "resolved", serviceGraph: cached.graph }
      : { key: graphKey, status: "resolving", serviceGraph: null };
  });
  const requestTokenRef = React.useRef(0);
  const actionRunRetryRef = React.useRef<string | null>(null);
  // Automatic attempts already spent on this head SHA. The graph read is the
  // most expensive read on this surface (~14 REST requests), and a PR whose
  // Actions read always fails — Actions disabled, a token that can't read
  // Actions, a deleted head SHA — fails every single time. Without this cap the
  // governor's own recovery signal re-arms the fetch effect, so the failure
  // path would issue a fresh full read roughly every 30s for as long as the tab
  // stays open. Pressing Retry is exempt and resets the count.
  const autoAttemptsRef = React.useRef<{ key: string; failures: number }>({ key: graphKey, failures: 0 });

  const loadGraph = React.useCallback((
    key: string,
    options: { bypassCache?: boolean; userInitiated?: boolean } = {},
  ) => {
    if (options.bypassCache) invalidateChecksGraphCache(key);
    const cached = options.bypassCache ? null : readChecksGraphCache(key);
    if (cached) {
      // The whole point of the cache: re-opening the tab is free, both in
      // GitHub requests and in perceived latency.
      requestTokenRef.current += 1;
      setGraphState({ key, status: "resolved", serviceGraph: cached.graph });
      return;
    }
    // Automatic reads consult the shared brake and their own attempt budget. A
    // Retry the user pressed is exempt from both on purpose — the reserve
    // exists for the work the user came to do.
    const attempts = autoAttemptsRef.current;
    const outOfAttempts = attempts.key === key && attempts.failures >= MAX_AUTO_GRAPH_ATTEMPTS;
    if (!options.userInitiated && (outOfAttempts || isGithubPollStoodDown())) {
      setGraphState((prev) => ({
        key,
        status: "unreachable",
        serviceGraph: prev.key === key ? prev.serviceGraph : null,
      }));
      return;
    }
    if (options.userInitiated) autoAttemptsRef.current = { key, failures: 0 };

    const token = (requestTokenRef.current += 1);
    setGraphState((prev) => ({
      key,
      status: "resolving",
      // Hold the graph we already have for this same key: a refresh must never
      // blank or relayout a graph that is still correct.
      serviceGraph: prev.key === key ? prev.serviceGraph : null,
    }));

    void fetchChecksGraphOnce(key, () => fetchWorkflowGraph({ prId: pr.id }))
      .then((value) => {
        if (requestTokenRef.current !== token) return;
        writeChecksGraphCache(key, value);
        noteGithubReadSuccess();
        setGraphState({ key, status: "resolved", serviceGraph: value });
      })
      .catch(() => {
        if (requestTokenRef.current !== token) return;
        // Deliberately NOT cached. Storing a rejection as "no graph here" is the
        // failed-read-that-looks-empty bug that let a 5s loop run for an hour.
        noteGithubReadFailure();
        const spent = autoAttemptsRef.current;
        autoAttemptsRef.current = spent.key === key
          ? { key, failures: spent.failures + 1 }
          : { key, failures: 1 };
        setGraphState((prev) => ({
          key,
          status: "unreachable",
          serviceGraph: prev.key === key ? prev.serviceGraph : null,
        }));
      });
  }, [isGithubPollStoodDown, noteGithubReadFailure, noteGithubReadSuccess, pr.id]);

  React.useEffect(() => {
    actionRunRetryRef.current = null;
    autoAttemptsRef.current = { key: graphKey, failures: 0 };
  }, [graphKey]);

  // Runs on mount, on head-SHA change, and when the governor's stand-down
  // changes state (so a recovered GitHub is picked up without a timer).
  React.useEffect(() => {
    loadGraph(graphKey);
  }, [graphKey, loadGraph, githubPollGeneration]);

  // CI had not started when we first asked, and now it has. Exactly one extra
  // attempt per head SHA — the ref is what stops an uncharted answer from
  // re-arming this effect into a loop.
  React.useEffect(() => {
    // Only a *resolved* uncharted answer is evidence that we charted nothing
    // because CI had not started. A read that failed is evidence of nothing, and
    // retrying it here would spend a request the governor just braked.
    if (graphState.key !== graphKey || graphState.status !== "resolved") return;
    if (!shouldRefetchOnFirstActionRun({ graph: graphState.serviceGraph, hasActionRuns })) return;
    if (actionRunRetryRef.current === graphKey) return;
    actionRunRetryRef.current = graphKey;
    loadGraph(graphKey, { bypassCache: true });
  }, [graphKey, graphState, hasActionRuns, loadGraph]);

  const retryGraph = React.useCallback(() => {
    loadGraph(graphKey, { bypassCache: true, userInitiated: true });
  }, [graphKey, loadGraph]);

  /**
   * The graph state for the key being rendered *right now*. A PR switch changes
   * `graphKey` a render before the effect runs, so reading the cache here is
   * what keeps a cached graph from flashing through "resolving" on the way in.
   */
  const activeGraph = React.useMemo<ChecksGraphState>(() => {
    if (graphState.key === graphKey) return graphState;
    const cached = readChecksGraphCache(graphKey);
    return cached
      ? { key: graphKey, status: "resolved", serviceGraph: cached.graph }
      : { key: graphKey, status: "resolving", serviceGraph: null };
  }, [graphState, graphKey]);

  /**
   * Older attempts are not charted by the service (it parses only the head run),
   * so scrubbing back is always the flat view — and is a final answer, not a
   * transition.
   */
  const chartedGraph = viewingLatestAttempt && isChartedGraph(activeGraph.serviceGraph)
    ? activeGraph.serviceGraph
    : null;

  const graphPhase: "charted" | "resolving" | "flat" = chartedGraph
    ? "charted"
    : !viewingLatestAttempt
      ? "flat"
      : activeGraph.status === "resolving"
        ? "resolving"
        : "flat";

  const graph = React.useMemo<PrWorkflowGraph>(() => {
    if (chartedGraph) return hydrateWorkflowGraph(chartedGraph, unified);
    return deriveFallbackGraph(unified, {
      headSha: pr.headSha ?? activeGraph.serviceGraph?.headSha ?? null,
      reason: viewingLatestAttempt ? activeGraph.serviceGraph?.unavailableReason ?? null : null,
    });
  }, [chartedGraph, activeGraph.serviceGraph, unified, pr.headSha, viewingLatestAttempt]);

  const buckets = React.useMemo(() => graphBuckets(graph), [graph]);
  const anythingRunning = buckets.running > 0 || buckets.queued > 0;
  const now = useLiveNow(anythingRunning);
  const failures = React.useMemo(() => failingNodes(graph), [graph]);

  // ---- log drawer -------------------------------------------------------
  // `forceLog` is cleared in the same commit as every drawer change, not in a
  // follow-up effect. An effect declared after the fetch effect runs after it,
  // so switching jobs while a log was forced would fire one full log download
  // for the new job before the reset could land.
  const openDrawerFor = React.useCallback((node: PrWorkflowGraphNode) => {
    setForceLog(false);
    setDrawer({ node, jobId: resolveLogJobId(node) });
    resetCopied();
  }, [resetCopied]);

  const closeDrawer = React.useCallback(() => {
    setForceLog(false);
    setDrawer(null);
  }, []);

  /**
   * User activation of a node. A second activation of the *same* node closes the
   * drawer — a click that can only ever open is a dead end, because the drawer
   * has no other relationship to the node the user just clicked.
   */
  const toggleDrawerFor = React.useCallback((node: PrWorkflowGraphNode) => {
    resetCopied();
    setForceLog(false);
    setDrawer((current) => (
      current && current.node.jobId === node.jobId
        ? null
        : { node, jobId: resolveLogJobId(node) }
    ));
  }, [resetCopied]);

  React.useEffect(() => {
    if (!drawer) {
      setExcerpt(null);
      setLogError(null);
      setLogLoading(false);
      return undefined;
    }
    if (drawer.jobId == null) {
      setExcerpt(null);
      setLogLoading(false);
      setLogError("ADE couldn't resolve a GitHub job id for this check, so there's no log to fetch.");
      return undefined;
    }
    let cancelled = false;
    setExcerpt(null);
    setLogLoading(true);
    setLogError(null);
    void fetchCheckLogForState({
      prId: pr.id,
      jobId: drawer.jobId,
      state: drawer.node.state,
      force: forceLog,
    })
      .then((result) => {
        if (cancelled) return;
        // "skipped" is not a failure: this job's state does not warrant pulling
        // a multi-megabyte log, and the drawer renders its step breakdown from
        // data the checks poll already holds.
        if (result.resolution === "skipped") return;
        if (result.resolution === "no-api") {
          setLogError("This ADE runtime can't fetch CI logs yet — open the full log on GitHub instead.");
          return;
        }
        setExcerpt(result.excerpt);
        if (!result.excerpt) setLogError("No log excerpt came back for this job.");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setExcerpt(null);
        setLogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [drawer, forceLog, pr.id]);

  React.useEffect(() => {
    autoOpenedForPrRef.current = null;
    setForceLog(false);
    setDrawer(null);
    setSelectedAttempt(null);
  }, [pr.id]);

  // Auto-open the first failing job, once per PR, unless the user already
  // picked one. This effect intentionally follows the PR-reset effect above so
  // the mount/reset pass cannot immediately close the drawer it just opened.
  React.useEffect(() => {
    if (autoOpenedForPrRef.current === pr.id) return;
    if (failures.length === 0) return;
    autoOpenedForPrRef.current = pr.id;
    openDrawerFor(failures[0]!);
  }, [failures, openDrawerFor, pr.id]);

  React.useEffect(() => {
    setFocusedFailureIdx((current) => (
      failures.length === 0 ? 0 : Math.min(current, failures.length - 1)
    ));
  }, [failures.length]);

  // Focus request from the overview rail: select the matching node and open it.
  React.useEffect(() => {
    if (!focusedCheckId) return;
    const item = unified.find((i) => i.id === focusedCheckId);
    const node = graph.nodes.find(
      (n) => n.jobId === focusedCheckId
        || (item != null && n.displayName === item.displayName),
    );
    if (node) openDrawerFor(node);
    onFocusedCheckConsumed?.();
  }, [focusedCheckId, graph.nodes, onFocusedCheckConsumed, openDrawerFor, unified]);

  // ---- keyboard: g k palette, j/k across failures, Enter to open ---------
  React.useEffect(() => {
    if (paletteRequest > 0) setPaletteOpen(true);
  }, [paletteRequest]);

  React.useEffect(() => {
    const CHORD_WINDOW_MS = 800;
    let lastKey = "";
    let lastKeyAt = 0;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const now2 = Date.now();
      if (lastKey === "g" && now2 - lastKeyAt < CHORD_WINDOW_MS) {
        lastKey = "";
        if (event.key === "k") {
          event.preventDefault();
          setPaletteOpen(true);
        }
        return;
      }
      if (event.key === "g") {
        lastKey = "g";
        lastKeyAt = now2;
        return;
      }
      if (failures.length === 0) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        setFocusedFailureIdx((prev) => {
          const delta = event.key === "j" ? 1 : -1;
          return (prev + delta + failures.length) % failures.length;
        });
      } else if (event.key === "Enter") {
        const node = failures[focusedFailureIdx] ?? failures[0];
        if (node) {
          event.preventDefault();
          // Keyboard activation toggles too, so the same key both opens and
          // dismisses the job it is sitting on.
          toggleDrawerFor(node);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [failures, focusedFailureIdx, toggleDrawerFor]);

  const paletteChecks = React.useMemo<PaletteCheck[]>(
    () => graph.nodes.map((node) => ({
      id: node.jobId,
      name: node.displayName,
      state: STATE_LABEL[node.state],
      workflowName: node.workflowName || null,
    })),
    [graph.nodes],
  );

  // ---- actions ----------------------------------------------------------
  const drawerElapsed = drawer ? fmtMs(nodeElapsedMs(drawer.node, now)) : null;
  const handleCopy = React.useCallback(() => {
    if (!excerpt) return;
    const markdown = buildLogExcerptMarkdown({ excerpt, elapsedLabel: drawerElapsed, pr });
    void copy(markdown);
  }, [copy, excerpt, drawerElapsed, pr]);

  const rerunFailedVisible = Boolean(onRerunChecks) && buckets.failed > 0;
  const drawerRerun = React.useMemo(() => {
    if (!onRerunChecks || !drawer) return undefined;
    if (drawer.node.actionsJobId != null) {
      return () => onRerunChecks({ actionJobIds: [drawer.node.actionsJobId!] });
    }
    if (drawer.node.checkRunId != null) {
      return () => onRerunChecks({ checkRunIds: [drawer.node.checkRunId!] });
    }
    return undefined;
  }, [drawer, onRerunChecks]);

  const elapsed = fmtMs(pipelineElapsedMs(graph, now));
  const workflowLabel = graph.nodes[0]?.workflowName
    ?? attemptRuns[0]?.name
    ?? "Checks";

  // ---- list views -------------------------------------------------------
  const listItems = React.useMemo(() => (
    view === "failures"
      ? unified.filter((item) => {
          const state = pipelineStateOf(item);
          return state === "failed" || state === "unknown";
        })
      : unified
  ), [unified, view]);
  const listSections = React.useMemo(() => groupChecksForList(listItems), [listItems]);

  /**
   * The graph node a list row stands for, so clicking the row opens the same
   * log the graph would.
   *
   * Four join keys, because two graph builders disagree about a node's identity:
   * the fallback graph keys nodes by the unified item's own id and strips the
   * workflow prefix from `displayName`, while the YAML-backed graph keys them by
   * the workflow's job id. Matching on `displayName` alone silently left every
   * row in the fallback view unclickable.
   */
  const nodeForItem = React.useMemo(() => {
    const byJobId = new Map<string, PrWorkflowGraphNode>();
    const byCheckRunId = new Map<number, PrWorkflowGraphNode>();
    const byName = new Map<string, PrWorkflowGraphNode>();
    const remember = (key: string, node: PrWorkflowGraphNode) => {
      if (key && !byName.has(key)) byName.set(key, node);
    };
    for (const node of graph.nodes) {
      if (!byJobId.has(node.jobId)) byJobId.set(node.jobId, node);
      if (node.checkRunId != null && !byCheckRunId.has(node.checkRunId)) {
        byCheckRunId.set(node.checkRunId, node);
      }
      remember(node.displayName, node);
      if (node.workflowName) remember(`${node.workflowName} / ${node.displayName}`, node);
    }
    return (item: UnifiedCheckItem): PrWorkflowGraphNode | undefined => (
      byJobId.get(item.id)
      ?? (item.checkRunId != null ? byCheckRunId.get(item.checkRunId) : undefined)
      ?? byName.get(item.displayName)
      ?? byName.get(item.name)
    );
  }, [graph.nodes]);

  const selectedJobId = drawer?.node.jobId ?? null;

  const renderSections = (emptyCopy: string) => (
    listSections.length === 0 ? (
      <div className="px-1 py-3 text-[11.5px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
        {emptyCopy}
      </div>
    ) : (
      listSections.map((section, index) => (
        <PrSection
          key={section.workflowName}
          title={section.workflowName}
          divided={index > 0}
          data-testid="pr-checks-list-section"
          meta={
            <span className="inline-flex items-center gap-1.5">
              <StateIcon state={section.state} size={11} />
              {section.failedCount > 0
                ? `${section.failedCount} of ${section.items.length} failed`
                : `${section.items.length} ${section.items.length === 1 ? "check" : "checks"}`}
            </span>
          }
        >
          <div className="flex flex-col">
            {section.items.map((item, itemIndex) => {
              const node = nodeForItem(item);
              return (
                <CheckRow
                  key={item.id}
                  name={item.displayName}
                  label={rowLabel(item, section.workflowName)}
                  state={pipelineStateOf(item)}
                  elapsedMs={checkElapsedMs(item, now)}
                  detailsUrl={item.detailsUrl}
                  badge={item.source === "check" ? "external" : null}
                  divided={itemIndex > 0}
                  selected={node != null && node.jobId === selectedJobId}
                  onSelect={node ? () => toggleDrawerFor(node) : undefined}
                />
              );
            })}
          </div>
        </PrSection>
      ))
    )
  );

  return (
    <div className="flex flex-col" style={{ padding: SPACING.md, background: COLORS.prSurface }} data-testid="pr-checks-tab">
      {/* ===== header strip — flat: a hairline and rhythm, no floating card ===== */}
      <div
        className="flex flex-wrap items-end gap-y-2 pb-3"
        style={{ borderBottom: `1px solid ${COLORS.borderMuted}` }}
        data-testid="pr-checks-header"
      >
        <div className="flex min-w-0 flex-col gap-[2px] pr-[18px]">
          <span className="text-[9.5px] uppercase" style={{ letterSpacing: "0.09em", color: COLORS.textDim, fontFamily: SANS_FONT }}>
            Run
          </span>
          <span className="truncate text-[14px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
            {workflowLabel}
            <small className="ml-1 text-[11px] font-medium" style={{ color: COLORS.textMuted }}>
              · attempt {selectedAttempt ?? graph.attempt ?? latestAttempt}
            </small>
          </span>
        </div>
        <StripSegment label="Elapsed" value={elapsed ?? "—"} color={anythingRunning ? COLORS.warning : undefined} />
        <StripSegment
          label={checksStatus === "not_run" ? "Verified" : "Passed"}
          color={checksStatus === "not_run" ? COLORS.textMuted : COLORS.checkPass}
          value={
            checksStatus === "not_run"
              ? <>0<small className="text-[11px] font-medium" style={{ color: COLORS.textMuted }}>/{buckets.total}</small></>
              : <>{buckets.passed}<small className="text-[11px] font-medium" style={{ color: COLORS.textMuted }}>/{buckets.total}</small></>
          }
        />
        <StripSegment label="Failed" value={buckets.failed} color={buckets.failed > 0 ? COLORS.danger : COLORS.textMuted} />
        <StripSegment label="Running" value={buckets.running} color={buckets.running > 0 ? COLORS.warning : COLORS.textMuted} />
        <StripSegment label="Queued" value={buckets.queued} color={COLORS.textMuted} />

        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <RunHistorySparkline runs={actionRuns} />
          {graph.stale ? (
            <span
              data-testid="pr-checks-stale-badge"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px]"
              style={{
                borderRadius: 999,
                background: tint(COLORS.warning, 12),
                border: `1px solid ${tint(COLORS.warning, 30)}`,
                color: COLORS.warning,
                fontFamily: SANS_FONT,
              }}
            >
              ◷ {graph.headSha ? graph.headSha.slice(0, 7) : "older commit"}
              {graph.staleBehindBy != null ? ` · ${graph.staleBehindBy} commits behind head` : " · behind head"}
            </span>
          ) : null}
          {attempts.length > 1 ? (
            <div
              className="flex items-center gap-[3px] p-0.5"
              style={{ background: COLORS.recessedBg, borderRadius: RADII.md }}
              data-testid="pr-checks-attempt-scrubber"
            >
              {attempts.map((attempt) => (
                <SegButton
                  key={attempt}
                  active={(selectedAttempt ?? latestAttempt) === attempt}
                  onClick={() => setSelectedAttempt(attempt)}
                  testId={`pr-checks-attempt-${attempt}`}
                >
                  #{attempt}
                </SegButton>
              ))}
            </div>
          ) : null}
          <div
            className="flex items-center gap-[3px] p-0.5"
            style={{ background: COLORS.recessedBg, borderRadius: RADII.md }}
            data-testid="pr-checks-view-switch"
          >
            <SegButton active={view === "graph"} onClick={() => selectView("graph")} testId="pr-checks-view-graph" icon={Path}>Graph</SegButton>
            <SegButton active={view === "list"} onClick={() => selectView("list")} testId="pr-checks-view-list" icon={ListBullets}>List</SegButton>
            <SegButton active={view === "failures"} onClick={() => selectView("failures")} testId="pr-checks-view-failures">Failures</SegButton>
          </div>
          {rerunFailedVisible ? (
            <SmallButton
              tone="warn"
              disabled={actionBusy}
              onClick={() => onRerunChecks?.()}
              testId="pr-checks-rerun-failed"
            >
              <ArrowsClockwise size={12} /> Re-run failed
            </SmallButton>
          ) : null}
        </div>
      </div>

      {/* 4-colour progress bar — semantic tokens, so it survives light mode. */}
      {buckets.total > 0 ? (
        <div
          className="flex overflow-hidden"
          style={{ height: 3, marginBottom: SPACING.md }}
          data-testid="pr-checks-progress-bar"
        >
          {([
            ["passed", COLORS.checkPass],
            ["failed", COLORS.danger],
            ["running", COLORS.warning],
            ["queued", COLORS.textDim],
            ["skipped", COLORS.textDim],
            ["unknown", COLORS.textMuted],
          ] as const).map(([key, color]) => (
            buckets[key] > 0 ? (
              <i
                key={key}
                data-testid={`pr-checks-progress-${key}`}
                className="block"
                style={{ flex: buckets[key], background: color, transition: "flex 300ms ease" }}
              />
            ) : null
          ))}
        </div>
      ) : <div style={{ marginBottom: SPACING.md }} />}

      {buckets.total === 0 ? (
        <div className="px-1 py-4 text-[12px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }} data-testid="pr-checks-empty">
          No checks have reported for this pull request yet.
        </div>
      ) : view === "graph" ? (
        graphPhase === "charted" ? (
          <React.Suspense fallback={<PrChecksGraphSkeleton jobCount={graph.nodes.length} label="Loading the pipeline view…" />}>
            <PrChecksGraphCanvas
              graph={graph}
              now={now}
              selectedJobId={selectedJobId}
              focusedJobId={failures[focusedFailureIdx]?.jobId ?? null}
              onToggleNode={toggleDrawerFor}
            />
          </React.Suspense>
        ) : graphPhase === "resolving" ? (
          // The flat list is a legitimate FINAL answer but never a loading
          // state: showing it here is what produced the 2–3 second list that
          // snapped into a graph.
          <PrChecksGraphSkeleton jobCount={Math.max(unified.length, graph.nodes.length)} />
        ) : (
          <div data-testid="pr-checks-swimlanes">
            <GraphUnavailableNote
              copy={
                activeGraph.status === "unreachable"
                  ? "ADE couldn't reach GitHub to chart these checks, so it can't draw the pipeline. Everything it already knows is below."
                  : !viewingLatestAttempt
                    ? "ADE charts only the latest attempt, so this older attempt is shown grouped by workflow."
                    : graphUnavailableCopy(graph.unavailableReason)
              }
              onRetry={activeGraph.status === "unreachable" ? retryGraph : undefined}
            />
            {renderSections("No checks to show for this attempt.")}
          </div>
        )
      ) : (
        <div className="flex flex-col" data-testid="pr-checks-flat-view">
          {renderSections(
            view === "failures"
              ? "No failed or indeterminate checks."
              : "No checks to show.",
          )}
        </div>
      )}

      {drawer ? (
        <PrCheckLogDrawer
          drawer={drawer}
          excerpt={excerpt}
          loading={logLoading}
          error={logError}
          elapsedLabel={drawerElapsed}
          onCopy={handleCopy}
          copied={copied}
          onRerunJob={drawerRerun}
          onFixInChat={onFixInChat && excerpt ? () => onFixInChat(excerpt) : undefined}
          onLoadLogExcerpt={forceLog ? undefined : () => setForceLog(true)}
          onClose={closeDrawer}
        />
      ) : null}

      {/* External / non-graphable checks get their own section beside the DAG. */}
      {view === "graph" && graphPhase === "charted" && graph.externalChecks.length > 0 ? (
        <div className="mt-3" data-testid="pr-checks-external-lane">
          <PrSection
            title="Other checks"
            meta="not part of a workflow, so not graphable"
          >
            <div className="flex flex-col">
              {graph.externalChecks.map((check, index) => (
                <CheckRow
                  key={check.name}
                  name={check.name}
                  label={check.name}
                  state={pipelineStateOf(check)}
                  elapsedMs={checkElapsedMs(check, now)}
                  detailsUrl={check.detailsUrl}
                  divided={index > 0}
                />
              ))}
            </div>
          </PrSection>
        </div>
      ) : null}

      <PrCommandPalettes
        open={paletteOpen ? "check" : null}
        onClose={() => setPaletteOpen(false)}
        commits={[]}
        threads={[]}
        files={[]}
        checks={paletteChecks}
        onPickCommit={() => {}}
        onPickThread={() => {}}
        onPickFile={() => {}}
        onPickCheck={(id) => {
          const node = graph.nodes.find((n) => n.jobId === id);
          if (node) openDrawerFor(node);
        }}
      />
    </div>
  );
}

export default PrChecksTab;
