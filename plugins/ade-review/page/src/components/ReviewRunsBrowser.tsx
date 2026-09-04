/**
 * The runs browser — the whole of `ReviewPage.tsx` (2,265) that draws.
 *
 * The list of runs, the run header with its scope diagram and Rerun, the review
 * process disclosure, the reviewer outputs disclosure, the publications, the
 * findings with their severity filter and the four feedback verbs, the artifacts
 * disclosure, the transcript links, and the learnings view. Moved rather than
 * rewritten; what changed is only what a guest cannot have:
 *
 * - **The route.** `useNavigate`, `useLocation` and `useSearchParams` are gone.
 *   The page owns its navigation: the selected run lives in state, arrives from
 *   `context` when the host opened this page at one, and is remembered in the
 *   plugin's `ui-state` collection between opens.
 * - **The store.** `useAppStore(s => s.lanes)` is gone. The lanes come with the
 *   launch context, which is the only read that had them anyway.
 * - **The resizable split.** `react-resizable-panels` is a renderer dependency
 *   with its own window-level listeners; the two panes are a flex row with a
 *   drag handle, and the width still persists (in `ui-state`, not
 *   `localStorage`, which is dead in a guest).
 * - **The event bridge.** `onReviewEvent` became `host.subscribe({kinds:
 *   ["review"]})` with the child's poll behind it — see `host/liveRuns.ts`.
 * - **Two navigations.** "Open in files" and "Open in Work" were renderer route
 *   pushes; they are deeplinks now, which is the only way a guest moves the app.
 */

import React from "react";
import {
  ArrowClockwise,
  ArrowsClockwise,
  ArrowSquareOut,
  Checks,
  ClockCounterClockwise,
  CopySimple,
  MagnifyingGlass,
  Plus,
  Sparkle,
} from "@phosphor-icons/react";
import { Button, Chip, EmptyState, cn } from "@ade-dev/ui";
import { BranchIcon } from "@ade-dev/ui/icons";
import { LaneDialogShell } from "@ade-dev/ui/dialog";

import type { PluginWebviewContext } from "../bridge";
import {
  cancelRun as cancelRunAction,
  getLaunchContext,
  getRunDetail,
  getRuns,
  recordFeedback,
  rerun as rerunAction,
} from "../host/actions";
import { useReviewLive } from "../host/liveRuns";
import { useHostRefresh } from "../host/refresh";
import { openLink, openPathInEditor, writeClipboard } from "../host/ui";
import {
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  loadSelectedRunId,
  loadSidebarPx,
  saveSelectedRunId,
  saveSidebarPx,
} from "../host/uiState";
import {
  formatReviewFindingForClipboard,
  formatReviewFindingsForClipboard,
} from "../lib/reviewFindingCopy";
import {
  buildRunScopeVisualProps,
  describeRunTarget,
  formatCompareTargetDescription,
  formatReviewCompleteLine,
  formatReviewEvidenceLine,
  formatRunSummaryFooter,
  formatTime,
  isContextArtifactType,
  laneDisplayName,
  normalizeDetail,
  normalizeRun,
  readArtifactMetaCount,
  readArtifactMetaNumber,
  readArtifactMetaString,
  toContextArtifactLabel,
  toPassLabel,
  toReviewStatusTone,
  toTargetModeLabel,
  type NormalizedDetail,
  type NormalizedRun,
} from "../lib/reviewFormat";
import { laneIdFromContext, runIdFromContext } from "../lib/reviewRouteState";
import type {
  PageReviewLaunchContext,
  PageReviewLaunchLane,
  ReviewFinding,
  ReviewRunStatus,
} from "../types";
import { ReviewFindingCard, type FindingActionRequest } from "./ReviewFindingCard";
import { ReviewLaunchForm } from "./ReviewLaunchForm";
import { ReviewLearningsPanel } from "./ReviewLearningsPanel";
import {
  MetaCard,
  REVIEW_CARD_SURFACE,
  REVIEW_LIST_ACTIVE,
  ReviewLaunchScopeVisual,
  SectionCard,
} from "./ReviewShell";

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low" | "info";

/**
 * ADE's deeplink parser refuses a `lane` parameter that is not a UUID, and it
 * refuses the WHOLE link rather than dropping the field. So a lane id is only
 * ever sent when it will parse, and a lane the host names some other way costs
 * the reader a hint rather than the navigation.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ReviewRunsBrowser({ context }: { context: PluginWebviewContext }) {
  const projectRoot = context.project?.root ?? null;

  const [launchContext, setLaunchContext] = React.useState<PageReviewLaunchContext | null>(null);
  const [runs, setRuns] = React.useState<NormalizedRun[]>([]);
  const [detail, setDetail] = React.useState<NormalizedDetail | null>(null);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedbackError, setFeedbackError] = React.useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(() => runIdFromContext(context));
  const [launchModalOpen, setLaunchModalOpen] = React.useState(false);
  const [showLearnings, setShowLearnings] = React.useState(false);
  const [learningsToken, setLearningsToken] = React.useState(0);
  const [severityFilter, setSeverityFilter] = React.useState<SeverityFilter>("all");
  const [showSuppressed, setShowSuppressed] = React.useState(false);
  const [copyAllFindingsState, setCopyAllFindingsState] = React.useState<"idle" | "copied" | "error">("idle");
  const [cancelInFlight, setCancelInFlight] = React.useState(false);
  const [rerunning, setRerunning] = React.useState(false);
  const [refreshingTab, setRefreshingTab] = React.useState(false);
  const [sidebarPx, setSidebarPx] = React.useState(SIDEBAR_DEFAULT_PX);

  // The host's own instruction outranks the stored preference, so a page opened
  // AT a run never lands on the run the reader looked at last week.
  const hostRunId = React.useMemo(() => runIdFromContext(context), [context]);
  const hydratedRunRef = React.useRef(false);

  const lanes = React.useMemo<PageReviewLaunchLane[]>(
    () => launchContext?.lanes ?? [],
    [launchContext?.lanes],
  );
  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);

  /* ── Reads ────────────────────────────────────────────────────────────── */

  const refreshLaunchContext = React.useCallback(async () => {
    try {
      setLaunchContext(await getLaunchContext());
    } catch (err) {
      // This read DEGRADES rather than rejecting, so reaching here means the
      // bridge itself is gone — which is the page's own error, not the engine's.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshRuns = React.useCallback(async () => {
    setLoadingRuns(true);
    try {
      const next = await getRuns({ limit: 120, status: "all" });
      const normalized = (Array.isArray(next) ? next : []).map((run) => normalizeRun(run));
      setRuns(normalized);
      setError(null);
      return normalized;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadDetail = React.useCallback(async (runId: string | null, options?: { clearError?: boolean }) => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const next = await getRunDetail(runId);
      setDetail(next ? normalizeDetail(next) : null);
      if (options?.clearError !== false) setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  /* ── Where the reader was ─────────────────────────────────────────────── */

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [px, storedRunId] = await Promise.all([
        loadSidebarPx(projectRoot),
        loadSelectedRunId(projectRoot),
      ]);
      if (cancelled) return;
      setSidebarPx(px);
      hydratedRunRef.current = true;
      if (!hostRunId && storedRunId) setSelectedRunId((current) => current ?? storedRunId);
    })();
    return () => {
      cancelled = true;
    };
  }, [hostRunId, projectRoot]);

  React.useEffect(() => {
    if (!hydratedRunRef.current) return;
    void saveSelectedRunId(projectRoot, selectedRunId);
  }, [projectRoot, selectedRunId]);

  React.useEffect(() => {
    void refreshLaunchContext();
  }, [refreshLaunchContext]);

  React.useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  useHostRefresh(() => {
    void refreshLaunchContext();
    void refreshRuns();
  });

  React.useEffect(() => {
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  // The compiled page's two selection guards, unchanged: land on the newest run
  // when nothing is chosen, and leave a run that has gone rather than showing an
  // empty detail pane for it.
  React.useEffect(() => {
    if (selectedRunId === null && runs.length > 0) setSelectedRunId(runs[0]?.id ?? null);
  }, [runs, selectedRunId]);

  React.useEffect(() => {
    if (!selectedRunId || runs.length === 0) return;
    if (runs.some((run) => run.id === selectedRunId)) return;
    if (detail && detail.id === selectedRunId) return;
    setSelectedRunId(runs[0]?.id ?? null);
  }, [detail, runs, selectedRunId]);

  /* ── Live ─────────────────────────────────────────────────────────────── */

  const selectedDetail = React.useMemo(
    () => (detail && detail.id === selectedRunId ? detail : null),
    [detail, selectedRunId],
  );
  const selectedRun = React.useMemo(
    () =>
      selectedDetail
      ?? (selectedRunId ? runs.find((run) => run.id === selectedRunId) ?? null : runs[0] ?? null),
    [runs, selectedDetail, selectedRunId],
  );

  const anythingLive = React.useMemo(
    () => runs.some((run) => run.status === "queued" || run.status === "running"),
    [runs],
  );

  const onLiveChange = React.useCallback(() => {
    void refreshRuns();
    if (selectedRunId) void loadDetail(selectedRunId, { clearError: false });
    setLearningsToken((token) => token + 1);
  }, [loadDetail, refreshRuns, selectedRunId]);

  const live = useReviewLive(onLiveChange, anythingLive);

  React.useEffect(() => {
    if (copyAllFindingsState === "idle") return undefined;
    const timer = window.setTimeout(() => setCopyAllFindingsState("idle"), 1_500);
    return () => window.clearTimeout(timer);
  }, [copyAllFindingsState]);

  /* ── Derived views of the selected run ────────────────────────────────── */

  const selectedRunLane = selectedRun ? laneById.get(selectedRun.laneId) ?? null : null;
  const selectedRunCompareLane = React.useMemo(() => {
    if (!selectedRun || selectedRun.config?.compareAgainst?.kind !== "lane") return null;
    return laneById.get(selectedRun.config.compareAgainst.laneId) ?? null;
  }, [laneById, selectedRun]);
  const selectedRunScopeVisual = React.useMemo(() => {
    if (!selectedRun) return null;
    return buildRunScopeVisualProps(
      selectedRun,
      selectedRunLane,
      selectedRunCompareLane,
      launchContext?.defaultBranchName?.trim() || "default branch",
    );
  }, [launchContext?.defaultBranchName, selectedRun, selectedRunCompareLane, selectedRunLane]);

  const selectedPassArtifacts = React.useMemo(
    () => selectedDetail?.artifacts?.filter((artifact) => artifact.artifactType === "pass_findings") ?? [],
    [selectedDetail?.artifacts],
  );
  const selectedAdjudicationArtifact = React.useMemo(
    () => selectedDetail?.artifacts?.find((artifact) => artifact.artifactType === "adjudication_result") ?? null,
    [selectedDetail?.artifacts],
  );
  const selectedMergedArtifact = React.useMemo(
    () => selectedDetail?.artifacts?.find((artifact) => artifact.artifactType === "merged_findings") ?? null,
    [selectedDetail?.artifacts],
  );
  const selectedContextArtifacts = React.useMemo(
    () =>
      selectedDetail?.artifacts?.filter((artifact) => isContextArtifactType(String(artifact.artifactType))) ?? [],
    [selectedDetail?.artifacts],
  );
  const selectedReviewerTranscripts = React.useMemo(
    () => selectedDetail?.reviewerRuns.filter((reviewer) => Boolean(reviewer.chatSessionId)) ?? [],
    [selectedDetail?.reviewerRuns],
  );

  /* ── Verbs ────────────────────────────────────────────────────────────── */

  const handleSelectRun = React.useCallback((runId: string) => {
    setSelectedRunId(runId);
  }, []);

  const handleStarted = React.useCallback(
    async (runId: string) => {
      setLaunchModalOpen(false);
      await refreshRuns();
      setSelectedRunId(runId);
    },
    [refreshRuns],
  );

  const handleRerun = React.useCallback(
    async (run: NormalizedRun | null) => {
      if (!run) return;
      setRerunning(true);
      setError(null);
      try {
        const result = await rerunAction(run.id);
        if (!result?.ok || !result.runId) {
          setError(result?.message ?? "Review rerun did not return a new run id.");
          return;
        }
        await refreshRuns();
        setSelectedRunId(result.runId);
      } finally {
        setRerunning(false);
      }
    },
    [refreshRuns],
  );

  const handleCancelRun = React.useCallback(
    async (run: NormalizedRun) => {
      if (run.status !== "running" && run.status !== "queued") return;
      setCancelInFlight(true);
      try {
        const result = await cancelRunAction(run.id);
        if (!result?.ok) setError(result?.message ?? "Could not cancel that run.");
        await refreshRuns();
        if (selectedRunId === run.id) await loadDetail(run.id, { clearError: false });
      } finally {
        setCancelInFlight(false);
      }
    },
    [loadDetail, refreshRuns, selectedRunId],
  );

  const refreshReviewTab = React.useCallback(async () => {
    setRefreshingTab(true);
    try {
      await Promise.all([
        refreshLaunchContext(),
        refreshRuns(),
        selectedRunId ? loadDetail(selectedRunId, { clearError: false }) : Promise.resolve(),
      ]);
    } finally {
      setRefreshingTab(false);
    }
  }, [loadDetail, refreshLaunchContext, refreshRuns, selectedRunId]);

  const handleFindingAction = React.useCallback(
    async (req: FindingActionRequest) => {
      setFeedbackError(null);
      const result = await recordFeedback({
        findingId: req.finding.id,
        kind: req.kind,
        reason: req.reason ?? null,
        note: req.note ?? null,
        snoozeDurationMs: req.snoozeDurationMs ?? null,
        suppression: req.suppression ?? null,
      });
      if (!result?.ok) {
        setFeedbackError(result?.message ?? "Could not record that feedback.");
        return;
      }
      if (selectedRunId) await loadDetail(selectedRunId, { clearError: false });
      // A suppression changes what the learnings view shows, and the compiled
      // panel learned that from the daemon's own event. Here the parent says so.
      if (req.kind === "suppress" || req.kind === "dismiss") setLearningsToken((token) => token + 1);
    },
    [loadDetail, selectedRunId],
  );

  /**
   * Where a finding's file lives, for the two "open it" verbs.
   *
   * The compiled page read the lane's `worktreePath` from the app store. A guest
   * has no store, so `path` rides along on the launch context's lanes — the
   * child joins `sdk.lanes.list()`, which is the same field. When the host has
   * no local checkout for the lane, the project root stands in, because a
   * finding's path is relative to a checkout either way and the project root is
   * the one the reader is looking at.
   */
  const resolveFindingTarget = React.useCallback(
    (finding: ReviewFinding): { laneId: string; target: string; rootPath: string | null } | null => {
      const path = finding.filePath?.trim();
      const laneId = selectedRun?.laneId ?? "";
      if (!path) return null;
      const rootPath = laneById.get(laneId)?.path ?? projectRoot ?? null;
      const target = rootPath && path.startsWith(rootPath)
        ? path.slice(rootPath.length).replace(/^\/+/, "")
        : path.startsWith("/")
          ? path.replace(/^\//, "")
          : path;
      return { laneId, target, rootPath };
    },
    [laneById, projectRoot, selectedRun?.laneId],
  );

  /**
   * `ade://file/<repo-relative-path>?line=&lane=`.
   *
   * The compiled call was `navigate("/files", { state: { openFilePath, laneId } })`,
   * and router state has no deeplink equivalent. This is the real route
   * (`shared/deeplinks.ts:854`), with its two real parameters — and both are
   * strict: `line=0` fails the whole link, and a `lane` that is not a UUID fails
   * it too, so each is set only when it will parse. A dropped `lane` opens the
   * file at the project root, which is the right fallback for a lane the host
   * has no id shape for; a dropped link would open nothing.
   */
  const handleOpenFindingInFiles = React.useCallback(
    (finding: ReviewFinding) => {
      const resolved = resolveFindingTarget(finding);
      if (!resolved?.target) return;
      const path = resolved.target.split("/").map(encodeURIComponent).join("/");
      const params = new URLSearchParams();
      if (typeof finding.line === "number" && finding.line > 0) params.set("line", String(finding.line));
      if (UUID.test(resolved.laneId)) params.set("lane", resolved.laneId);
      const query = params.toString();
      void openLink(`ade://file/${path}${query ? `?${query}` : ""}`);
    },
    [resolveFindingTarget],
  );

  const handleOpenFindingInEditor = React.useCallback(
    (finding: ReviewFinding) => {
      const resolved = resolveFindingTarget(finding);
      if (!resolved?.rootPath) return;
      // Guarded, and silent when the host has no editor verb — the compiled
      // card's own behaviour with `window.ade.app.openPathInEditor?.(…)`.
      void openPathInEditor({
        rootPath: resolved.rootPath,
        relativePath: resolved.target,
        target: "default",
      });
    },
    [resolveFindingTarget],
  );

  /**
   * `ade://session/<sessionId>?lane=<uuid>`.
   *
   * The SESSION is the route, not the lane: `ade://lane/<id>` takes no
   * session parameter, and the session target is what
   * `deeplinkToNavigationTarget` turns into the Work tab with that transcript
   * focused — which is exactly what the compiled `selectLane` + `focusSession`
   * + `navigate("/work")` did in three steps. `lane` is a hint and is only sent
   * when it will parse as a UUID, because a malformed one fails the link.
   */
  const handleOpenTranscriptInWork = React.useCallback(
    (sessionId: string | null | undefined, laneId: string | null | undefined) => {
      if (!sessionId) return;
      const query = laneId && UUID.test(laneId) ? `?lane=${encodeURIComponent(laneId)}` : "";
      void openLink(`ade://session/${encodeURIComponent(sessionId)}${query}`);
    },
    [],
  );

  const handleCopyFinding = React.useCallback(async (finding: ReviewFinding) => {
    const ok = await writeClipboard(formatReviewFindingForClipboard(finding));
    if (!ok) throw new Error("Clipboard is not available.");
  }, []);

  const handleCopyAllFindings = React.useCallback(
    async (findings: ReviewFinding[]) => {
      const ok = await writeClipboard(
        formatReviewFindingsForClipboard({
          findings,
          targetLabel: selectedRun?.targetLabel ?? null,
          summary: selectedRun?.summary ?? null,
        }),
      );
      setCopyAllFindingsState(ok ? "copied" : "error");
    },
    [selectedRun?.summary, selectedRun?.targetLabel],
  );

  /* ── The sidebar drag ─────────────────────────────────────────────────── */

  const dragRef = React.useRef<{ startX: number; startPx: number } | null>(null);

  const onDragMove = React.useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      SIDEBAR_MAX_PX,
      Math.max(SIDEBAR_MIN_PX, drag.startPx + (event.clientX - drag.startX)),
    );
    setSidebarPx(next);
  }, []);

  const onDragEnd = React.useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    if (drag) void saveSidebarPx(projectRoot, sidebarPx);
  }, [onDragMove, projectRoot, sidebarPx]);

  const onDragStart = React.useCallback(
    (event: React.PointerEvent) => {
      dragRef.current = { startX: event.clientX, startPx: sidebarPx };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
    },
    [onDragEnd, onDragMove, sidebarPx],
  );

  React.useEffect(
    () => () => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
    },
    [onDragEnd, onDragMove],
  );

  /* ── Panes ────────────────────────────────────────────────────────────── */

  const runsPane = (
    <div
      data-review-pane="runs"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-[var(--color-surface-recessed)]/35 px-1 pt-1"
    >
      <SectionCard
        title="Review runs"
        icon={ClockCounterClockwise}
        action={
          <Button size="sm" variant="ghost" onClick={() => setShowLearnings((prev) => !prev)} data-review-action="learnings">
            <Sparkle size={12} />
            {showLearnings ? "Hide learnings" : "Learnings"}
          </Button>
        }
      >
        <div className="space-y-2">
          <div className="text-[11px] text-[#94A3B8]">Pick a saved run here to inspect it on the right.</div>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
              {loadingRuns
                ? "Loading review runs…"
                : "No review runs yet in this workspace. Start a new review from the toolbar."}
            </div>
          ) : (
            runs.map((run) => {
              const active = run.id === selectedRunId;
              const runLane = laneById.get(run.laneId) ?? null;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => handleSelectRun(run.id)}
                  data-review-run={run.id}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left transition-colors",
                    active
                      ? REVIEW_LIST_ACTIVE
                      : "border-white/[0.06] bg-[var(--color-muted)]/35 hover:bg-[var(--color-muted)]/50",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#F5FAFF]">{describeRunTarget(run)}</div>
                      <div className="mt-0.5 truncate text-[11px] text-[#94A3B8]">
                        {formatTime(run.startedAt)} · {laneDisplayName(runLane)}
                      </div>
                    </div>
                    <Chip className={cn("text-[9px]", toReviewStatusTone(run.status))}>{run.status}</Chip>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Chip className="text-[9px]">findings {run.findingCount}</Chip>
                    {run.severitySummary
                      ? Object.entries(run.severitySummary)
                        .slice(0, 2)
                        .map(([severity, count]) => (
                          <Chip key={severity} className="text-[9px]">
                            {severity}:{count}
                          </Chip>
                        ))
                      : null}
                    <Chip className="text-[9px]">{toTargetModeLabel(run.target?.mode ?? "lane_diff")}</Chip>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </SectionCard>
    </div>
  );

  const detailPane = showLearnings ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-5">
      <ReviewLearningsPanel onClose={() => setShowLearnings(false)} refreshToken={learningsToken} />
    </div>
  ) : (
    <div data-review-pane="detail" className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-bg)]">
      {selectedRun ? (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
          <SectionCard title="Review scope" icon={BranchIcon}>
            {selectedRunScopeVisual ? <ReviewLaunchScopeVisual {...selectedRunScopeVisual} /> : null}
          </SectionCard>

          <section className={cn(REVIEW_CARD_SURFACE, "p-4")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className={cn("text-[9px]", toReviewStatusTone(selectedRun.status))}>
                    {selectedRun.status}
                  </Chip>
                  <Chip className="text-[9px]">{toTargetModeLabel(selectedRun.target?.mode ?? "lane_diff")}</Chip>
                  <Chip className="text-[9px]">
                    {selectedRun.config?.publishBehavior === "auto_publish" ? "publishing enabled" : "local only"}
                  </Chip>
                  {selectedRun.config?.modelId ? (
                    <Chip className="text-[9px]">{selectedRun.config.modelId}</Chip>
                  ) : null}
                  {selectedRun.config?.reasoningEffort ? (
                    <Chip className="text-[9px]">effort {selectedRun.config.reasoningEffort}</Chip>
                  ) : null}
                  {(selectedRun.config?.fastMode ?? selectedRun.config?.codexFastMode) ? (
                    <Chip className="text-[9px]">fast</Chip>
                  ) : null}
                </div>
                <div className="mt-3 text-lg font-semibold text-[#F5FAFF]">
                  {formatReviewCompleteLine(selectedRun, selectedDetail)}
                </div>
                <div className="mt-1 text-sm text-[#93A4B8]">{formatCompareTargetDescription(selectedRun)}</div>
                {formatReviewEvidenceLine(selectedRun, selectedDetail) ? (
                  <div className="mt-2 text-sm text-[#C5D2E6]">
                    {formatReviewEvidenceLine(selectedRun, selectedDetail)}
                  </div>
                ) : null}
                {selectedRun.errorMessage ? (
                  <div className="mt-2 text-sm text-red-200">{selectedRun.errorMessage}</div>
                ) : null}
                <div className="mt-3 font-mono text-[10px] text-[#94A3B8]">
                  {formatRunSummaryFooter(selectedRun)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleRerun(selectedRun)}
                disabled={rerunning}
                data-review-action="rerun"
              >
                <ArrowClockwise size={12} weight="regular" />
                {rerunning ? "Rerunning" : "Rerun"}
              </Button>
            </div>
          </section>

          {selectedContextArtifacts.length > 0 ? (
            <details className={REVIEW_CARD_SURFACE}>
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">Review process</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">
                      Specialist reviewers, context, and validation signals.
                    </div>
                  </div>
                  <Chip className="text-[9px]">{selectedDetail?.reviewerRuns.length ?? 0} reviewers</Chip>
                </div>
              </summary>
              <div className="grid gap-3 px-4 pb-4">
                {selectedDetail?.reviewerRuns.length ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                    {selectedDetail.reviewerRuns.map((reviewer) => (
                      <article
                        key={reviewer.id}
                        className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className={cn("text-[9px]", toReviewStatusTone(reviewer.status as ReviewRunStatus))}>
                            {reviewer.status}
                          </Chip>
                          <Chip className="text-[9px]">{toPassLabel(reviewer.reviewerKey)}</Chip>
                        </div>
                        <div className="mt-2 text-xs font-semibold text-[#F5FAFF]">{reviewer.label}</div>
                        <div className="mt-1 text-[11px] text-[#94A3B8]">
                          {reviewer.candidateCount} candidates, {reviewer.keptCount} used
                        </div>
                        {reviewer.summary ? (
                          <div className="mt-2 text-[11px] text-[#C5D2E6]">{reviewer.summary}</div>
                        ) : null}
                        {reviewer.chatSessionId ? (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenTranscriptInWork(reviewer.chatSessionId, selectedRun.laneId)}
                            aria-label={`Open ${reviewer.label} transcript in Work`}
                          >
                            <ArrowSquareOut size={12} />
                            Open in Work
                          </Button>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                <SectionCard title="Context used for this review" icon={Sparkle}>
                  <div className="grid gap-3 md:grid-cols-3">
                    {selectedContextArtifacts.map((artifact) => {
                      const artifactType = String(artifact.artifactType);
                      const countValue =
                        artifactType === "provenance_brief"
                          ? readArtifactMetaCount(artifact, [
                            "provenanceCount",
                            "workerDigestCount",
                            "sessionDeltaCount",
                            "priorReviewCount",
                          ])
                          : artifactType === "rule_overlays"
                            ? readArtifactMetaCount(artifact, [
                              "ruleCount",
                              "matchedRuleCount",
                              "overlayCount",
                              "pathCount",
                            ])
                            : readArtifactMetaCount(artifact, [
                              "signalCount",
                              "checkCount",
                              "testRunCount",
                              "issueCount",
                            ]);
                      const detailChips =
                        artifactType === "provenance_brief"
                          ? [
                            readArtifactMetaCount(artifact, ["workerDigestCount", "workerCount"])
                              ? `workers ${readArtifactMetaCount(artifact, ["workerDigestCount", "workerCount"])}`
                              : null,
                            readArtifactMetaCount(artifact, ["sessionDeltaCount", "sessionCount"])
                              ? `sessions ${readArtifactMetaCount(artifact, ["sessionDeltaCount", "sessionCount"])}`
                              : null,
                          ].filter((value): value is string => Boolean(value))
                          : artifactType === "rule_overlays"
                            ? [
                              readArtifactMetaCount(artifact, ["ruleCount", "matchedRuleCount"])
                                ? `rules ${readArtifactMetaCount(artifact, ["ruleCount", "matchedRuleCount"])}`
                                : null,
                              readArtifactMetaCount(artifact, ["pathCount"])
                                ? `paths ${readArtifactMetaCount(artifact, ["pathCount"])}`
                                : null,
                            ].filter((value): value is string => Boolean(value))
                            : [
                              readArtifactMetaCount(artifact, ["signalCount"])
                                ? `signals ${readArtifactMetaCount(artifact, ["signalCount"])}`
                                : null,
                              readArtifactMetaCount(artifact, ["checkCount", "testRunCount"])
                                ? `checks ${readArtifactMetaCount(artifact, ["checkCount", "testRunCount"])}`
                                : null,
                              readArtifactMetaCount(artifact, ["issueCount"])
                                ? `issues ${readArtifactMetaCount(artifact, ["issueCount"])}`
                                : null,
                            ].filter((value): value is string => Boolean(value));

                      return (
                        <article
                          key={artifact.id}
                          className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Chip className="text-[9px]">{toContextArtifactLabel(artifactType)}</Chip>
                            {countValue !== null ? <Chip className="text-[9px]">{countValue} items</Chip> : null}
                            {detailChips.map((chip) => (
                              <Chip key={`${artifact.id}-${chip}`} className="text-[9px]">
                                {chip}
                              </Chip>
                            ))}
                          </div>
                          <div className="mt-2 text-sm font-semibold text-[#F5FAFF]">{artifact.title}</div>
                          <div className="mt-1 text-xs text-[#C5D2E6]">
                            {readArtifactMetaString(artifact, "summary")
                              ?? "Compact review context captured for this run."}
                          </div>
                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                            <MetaCard label="Created" value={formatTime(artifact.createdAt)} />
                            <MetaCard label="Mime type" value={artifact.mimeType} />
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </SectionCard>
              </div>
            </details>
          ) : null}

          {selectedPassArtifacts.length > 0 || selectedAdjudicationArtifact || selectedMergedArtifact ? (
            <details className={REVIEW_CARD_SURFACE}>
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">Reviewer outputs</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">
                      Candidate counts, merge results, and filtered signals.
                    </div>
                  </div>
                  <Chip className="text-[9px]">{selectedDetail?.candidateFindings.length ?? 0} candidates</Chip>
                </div>
              </summary>
              <div className="space-y-3 px-4 pb-4">
                {selectedPassArtifacts.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    {selectedPassArtifacts.map((artifact) => (
                      <article
                        key={artifact.id}
                        className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">
                            {toPassLabel(readArtifactMetaString(artifact, "passKey") ?? artifact.title)}
                          </Chip>
                          <Chip className="text-[9px]">
                            {readArtifactMetaNumber(artifact, "keptCount") ?? 0} used
                          </Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {readArtifactMetaString(artifact, "summary") ?? "No summary recorded for this pass."}
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <MetaCard
                            label="Candidates"
                            value={readArtifactMetaNumber(artifact, "totalParsedCount") ?? "—"}
                          />
                          <MetaCard label="Used" value={readArtifactMetaNumber(artifact, "keptCount") ?? "—"} />
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}

                {selectedAdjudicationArtifact || selectedMergedArtifact ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {selectedAdjudicationArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Adjudication</Chip>
                          <Chip className="text-[9px]">
                            accepted {readArtifactMetaNumber(selectedAdjudicationArtifact, "acceptedCount") ?? 0}
                          </Chip>
                          <Chip className="text-[9px]">
                            rejected {readArtifactMetaNumber(selectedAdjudicationArtifact, "rejectedCount") ?? 0}
                          </Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          Merged overlaps and filtered low-signal candidates before findings became final.
                        </div>
                      </article>
                    ) : null}
                    {selectedMergedArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Final result</Chip>
                          <Chip className="text-[9px]">
                            findings {readArtifactMetaNumber(selectedMergedArtifact, "findingCount") ?? 0}
                          </Chip>
                          <Chip className="text-[9px]">
                            {selectedRun.config?.publishBehavior === "auto_publish"
                              ? "ready to post"
                              : "strong evidence"}{" "}
                            {readArtifactMetaNumber(selectedMergedArtifact, "publicationEligibleCount") ?? 0}
                          </Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {selectedRun.summary ?? "No merged summary recorded."}
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          {selectedDetail?.publications?.length ? (
            <SectionCard title="Publication" icon={ArrowSquareOut}>
              <div className="space-y-2">
                {selectedDetail.publications.map((publication) => (
                  <article
                    key={publication.id}
                    className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip className="text-[9px]">{publication.destination.kind}</Chip>
                      <Chip
                        className={cn(
                          "text-[9px]",
                          publication.status === "published"
                            ? "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300"
                            : "border-red-400/20 bg-red-400/[0.08] text-red-300",
                        )}
                      >
                        {publication.status}
                      </Chip>
                      <div className="text-sm font-semibold text-[#F5FAFF]">
                        {publication.destination.repoOwner}/{publication.destination.repoName} #
                        {publication.destination.prNumber}
                      </div>
                    </div>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <MetaCard label="Created" value={formatTime(publication.createdAt)} />
                      <MetaCard label="Completed" value={formatTime(publication.completedAt)} />
                      <MetaCard label="Inline comments" value={publication.inlineComments.length} />
                      <MetaCard label="Summary findings" value={publication.summaryFindingIds.length} />
                      <MetaCard label="Review URL" value={publication.reviewUrl ?? "not returned"} />
                      <MetaCard label="Remote review id" value={publication.remoteReviewId ?? "not returned"} />
                    </div>
                    {publication.errorMessage ? (
                      <div className="mt-3 text-sm text-red-200">{publication.errorMessage}</div>
                    ) : null}
                    <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                      {publication.summaryBody}
                    </pre>
                  </article>
                ))}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title={`Findings (${selectedRun.findingCount})`} icon={MagnifyingGlass}>
            {(() => {
              const rawFindings = selectedDetail?.findings ?? [];
              const detailUnavailable = selectedDetail == null;
              const suppressedCount = rawFindings.filter((f) => f.suppressionMatch != null).length;
              const severityMatches =
                severityFilter === "all" ? rawFindings : rawFindings.filter((f) => f.severity === severityFilter);
              const visible = severityMatches.filter((f) => showSuppressed || f.suppressionMatch == null);
              return (
                <>
                  {feedbackError ? (
                    <div
                      role="alert"
                      className="mb-3 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-200"
                    >
                      {feedbackError}
                    </div>
                  ) : null}
                  {selectedRun.status === "running" || selectedRun.status === "queued" ? (
                    <div
                      data-review-live={live.mode}
                      className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100"
                    >
                      <span>
                        Review {selectedRun.status === "queued" ? "queued" : "running"}. Findings appear as passes
                        complete.
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleCancelRun(selectedRun)}
                        disabled={cancelInFlight}
                        data-review-action="cancel-run"
                      >
                        {cancelInFlight ? "Cancelling…" : "Cancel run"}
                      </Button>
                    </div>
                  ) : null}
                  {selectedRun.status === "failed" ? (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-red-400/30 bg-red-400/[0.06] px-3 py-2 text-[11px] text-red-200">
                      <span>{selectedRun.errorMessage ?? "Review run failed."}</span>
                      <Button size="sm" variant="ghost" onClick={() => void handleRerun(selectedRun)}>
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {rawFindings.length > 0 ? (
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="text-[#6E7F92] uppercase tracking-[0.14em]">Severity:</span>
                        {(["all", "critical", "high", "medium", "low", "info"] as const).map((sev) => {
                          const count =
                            sev === "all" ? rawFindings.length : rawFindings.filter((f) => f.severity === sev).length;
                          if (sev !== "all" && count === 0) return null;
                          return (
                            <button
                              key={sev}
                              type="button"
                              onClick={() => setSeverityFilter(sev)}
                              data-review-severity={sev}
                              className={cn(
                                "rounded-full border px-2 py-0.5 font-medium transition",
                                severityFilter === sev
                                  ? "border-sky-400/40 bg-sky-400/[0.10] text-sky-100"
                                  : "border-white/[0.08] bg-white/[0.02] text-[#93A4B8] hover:border-white/[0.16]",
                              )}
                            >
                              {sev} <span className="text-[#6E7F92]">{count}</span>
                            </button>
                          );
                        })}
                        {suppressedCount > 0 ? (
                          <label className="inline-flex items-center gap-1.5 text-[10px] text-[#93A4B8]">
                            <input
                              type="checkbox"
                              checked={showSuppressed}
                              onChange={(e) => setShowSuppressed(e.target.checked)}
                              className="h-3 w-3 accent-sky-400"
                            />
                            Show {suppressedCount} filtered
                          </label>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCopyAllFindings(rawFindings)}
                        title="Copy all findings from this run as one message."
                        data-review-action="copy-all-findings"
                      >
                        {copyAllFindingsState === "copied" ? <Checks size={12} /> : <CopySimple size={12} />}
                        {copyAllFindingsState === "copied"
                          ? "Copied"
                          : copyAllFindingsState === "error"
                            ? "Copy failed"
                            : "Copy all findings"}
                      </Button>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {detailUnavailable && loadingDetail ? (
                      <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3 text-xs text-sky-100">
                        Loading findings and evidence for this run...
                      </div>
                    ) : detailUnavailable && selectedRun.findingCount > 0 ? (
                      <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-100">
                        Findings are still loading or unavailable. Refresh this run before treating the review as
                        empty.
                      </div>
                    ) : visible.length > 0 ? (
                      visible.map((finding, index) => (
                        <ReviewFindingCard
                          key={finding.id ?? `${finding.title}-${index}`}
                          finding={finding}
                          onRequestAction={handleFindingAction}
                          onCopyFinding={handleCopyFinding}
                          onOpenInFiles={finding.filePath ? handleOpenFindingInFiles : undefined}
                          onOpenInEditor={finding.filePath ? handleOpenFindingInEditor : undefined}
                        />
                      ))
                    ) : rawFindings.length > 0 ? (
                      <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                        No findings match the current filters.{" "}
                        {!showSuppressed && suppressedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setShowSuppressed(true)}
                            className="ml-1 text-sky-300 underline underline-offset-2 hover:text-sky-200"
                          >
                            Show {suppressedCount} filtered findings
                          </button>
                        ) : null}
                      </div>
                    ) : selectedRun.status === "completed" ? (
                      <EmptyState
                        icon={MagnifyingGlass}
                        title="No findings"
                        description="The review passes found nothing actionable in this diff. That could mean the diff was clean or the target was too small to review."
                      />
                    ) : (
                      <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                        Findings will appear here once the review completes.
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </SectionCard>

          <details className={REVIEW_CARD_SURFACE}>
            <summary className="cursor-pointer list-none px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Artifacts</div>
                  <div className="mt-1 text-xs text-[#94A3B8]">
                    Raw diff, prompts, payloads, and provenance for audit.
                  </div>
                </div>
                <Chip className="text-[9px]">{selectedDetail?.artifacts?.length ?? 0} saved</Chip>
              </div>
            </summary>
            <div className="space-y-2 px-4 pb-4">
              {selectedDetail?.artifacts?.length ? (
                selectedDetail.artifacts.map((artifact) => (
                  <div
                    key={artifact.id}
                    className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip className="text-[9px]">{toContextArtifactLabel(String(artifact.artifactType))}</Chip>
                      <div className="text-sm font-semibold text-[#F5FAFF]">{artifact.title}</div>
                      <span className="text-[11px] text-[#94A3B8]">{artifact.mimeType}</span>
                    </div>
                    {artifact.contentText ? (
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                        {artifact.contentText}
                      </pre>
                    ) : null}
                    {artifact.metadata ? (
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
                        {JSON.stringify(artifact.metadata, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                  No artifacts were captured for this run.
                </div>
              )}
            </div>
          </details>

          <SectionCard title="Review agent transcript" icon={Sparkle}>
            {selectedDetail?.chatSession ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Review agent transcript available</div>
                  <div className="mt-1 text-xs text-[#94A3B8]">
                    Open the saved read-only session in Work when you need the full turn-by-turn trace.
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    handleOpenTranscriptInWork(
                      selectedDetail.chatSession?.sessionId,
                      selectedDetail.chatSession?.laneId ?? selectedRun.laneId,
                    )}
                  data-review-action="open-transcript"
                >
                  <ArrowSquareOut size={12} />
                  Open in Work
                </Button>
              </div>
            ) : selectedReviewerTranscripts.length > 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">
                      Specialist reviewer transcripts available
                    </div>
                    <div className="mt-1 text-xs text-[#94A3B8]">
                      Open the saved read-only sessions in Work when you need the full turn-by-turn trace.
                    </div>
                  </div>
                  <Chip className="text-[9px]">{selectedReviewerTranscripts.length} linked</Chip>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedReviewerTranscripts.map((reviewer) => (
                    <Button
                      key={reviewer.id}
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenTranscriptInWork(reviewer.chatSessionId, selectedRun.laneId)}
                      aria-label={`Open ${reviewer.label} transcript in Work`}
                    >
                      <ArrowSquareOut size={12} />
                      {reviewer.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                No transcript session was linked to this run.
              </div>
            )}
          </SectionCard>
        </div>
      ) : loadingDetail || loadingRuns ? (
        <div className="flex h-full items-center justify-center text-sm text-[#94A3B8]">Loading review detail…</div>
      ) : (
        <EmptyState
          icon={MagnifyingGlass}
          title="Select a review run"
          description="Open a saved run on the left to inspect findings, evidence, and the transcript."
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-sky-400/20 bg-sky-500/10">
            <MagnifyingGlass size={16} weight="regular" className="text-sky-400" />
          </div>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-[#FAFAFA]">Review</div>
            <div className="text-[11px] text-[#94A3B8]">
              Pick a saved run on the left, then inspect findings and evidence on the right.
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => setLaunchModalOpen(true)}
            aria-label="Launch new review"
            data-review-action="open-launch"
          >
            <Plus size={12} weight="bold" />
            Launch new review
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshReviewTab()}
            disabled={refreshingTab}
            data-review-action="refresh"
          >
            <ArrowsClockwise size={12} weight="regular" className={cn(refreshingTab && "animate-spin")} />
            Refresh runs
          </Button>
        </div>
      </div>

      <LaneDialogShell
        open={launchModalOpen}
        onOpenChange={setLaunchModalOpen}
        title="Launch review"
        description="Choose a lane and review target, then start a read-only inspection run."
        icon={Sparkle}
        widthClassName="w-[min(760px,calc(100vw-1rem))]"
      >
        <ReviewLaunchForm
          launchContext={launchContext}
          initialLaneId={laneIdFromContext(context)}
          onStarted={(runId) => void handleStarted(runId)}
          onCancel={() => setLaunchModalOpen(false)}
        />
      </LaneDialogShell>

      {error && !loadingRuns ? (
        <div role="alert" className="border-b border-red-400/15 bg-red-500/[0.06] px-6 py-2.5 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div style={{ width: sidebarPx }} className="min-h-0 min-w-0 shrink-0 overflow-hidden">
          {runsPane}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the runs list"
          onPointerDown={onDragStart}
          className="w-1 shrink-0 cursor-col-resize bg-[var(--color-border)]/40 hover:bg-sky-400/40"
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{detailPane}</div>
      </div>
    </div>
  );
}
