import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Grid3x3,
  Layers,
  RefreshCw,
  Sparkles,
  Wand2,
  Wrench
} from "lucide-react";
import { useAppStore } from "../../state/appStore";
import type {
  BatchAssessmentResult,
  ConflictOverlap,
  ConflictProposal,
  ConflictProposalPreview,
  ConflictExternalResolverRunSummary,
  ConflictStatus,
  GitConflictState,
  LaneSummary,
  RestackSuggestion,
  RiskMatrixEntry
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { RiskMatrix } from "./RiskMatrix";
import { ConflictSummary } from "./ConflictSummary";
import { MergeSimulationPanel } from "./MergeSimulationPanel";

type ViewMode = "summary" | "matrix";

type LaneStatusFilter = "conflict" | "at-risk" | "clean" | "unknown" | null;

type MergePlanState = {
  targetLaneId: string;
  sourceLaneIds: string[];
  cursor: number;
  activeMerge?: { targetLaneId: string; sourceLaneId: string } | null;
};

function previewLines(title: string, bullets: string[]) {
  return (
    <div className="rounded-lg bg-muted/20 p-3 text-xs">
      <div className="flex items-center gap-2 font-semibold text-fg">
        <Wand2 className="h-4 w-4 text-muted-fg" />
        {title}
      </div>
      <ul className="mt-2 space-y-1 text-muted-fg">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="text-muted-fg">•</span>
            <span className="min-w-0">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function statusRank(value: ConflictStatus["status"]): number {
  if (value === "conflict-active") return 5;
  if (value === "conflict-predicted") return 4;
  if (value === "behind-base") return 3;
  if (value === "unknown") return 2;
  return 1;
}

function statusDotClass(status: ConflictStatus["status"] | null): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

function statusBorderClass(status: ConflictStatus["status"] | null): string {
  if (status === "conflict-active") return "border-l-red-500";
  if (status === "conflict-predicted") return "border-l-orange-500";
  if (status === "behind-base") return "border-l-amber-500";
  if (status === "merge-ready") return "border-l-emerald-500";
  return "border-l-muted-fg/40";
}

function classifyStatus(status: ConflictStatus["status"] | undefined): Exclude<LaneStatusFilter, null> {
  if (status === "conflict-active" || status === "conflict-predicted") return "conflict";
  if (status === "behind-base") return "at-risk";
  if (status === "merge-ready") return "clean";
  return "unknown";
}

function filterLaneByStatus(status: ConflictStatus["status"] | undefined, filter: LaneStatusFilter): boolean {
  if (!filter) return true;
  return classifyStatus(status) === filter;
}

function formatShortSha(sha: string | null | undefined): string {
  const s = (sha ?? "").trim();
  if (!s) return "-";
  return s.length > 10 ? s.slice(0, 10) : s;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function lanesById(lanes: LaneSummary[]): Map<string, LaneSummary> {
  return new Map(lanes.map((lane) => [lane.id, lane] as const));
}

function sortMergeSources(lanes: LaneSummary[], sourceLaneIds: string[]): string[] {
  const byId = lanesById(lanes);
  return [...sourceLaneIds]
    .filter((id) => byId.has(id))
    .sort((a, b) => {
      const laneA = byId.get(a)!;
      const laneB = byId.get(b)!;
      const depthDelta = (laneA.stackDepth ?? 0) - (laneB.stackDepth ?? 0);
      if (depthDelta !== 0) return depthDelta;
      const aTs = Date.parse(laneA.createdAt);
      const bTs = Date.parse(laneB.createdAt);
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
      return laneA.name.localeCompare(laneB.name);
    });
}

/* ---- Default tiling layout ---- */

const CONFLICTS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "lanes" }, defaultSize: 22, minSize: 12 },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "conflict-detail" }, defaultSize: 55, minSize: 25 },
          { node: { type: "pane", id: "resolution" }, defaultSize: 45, minSize: 20 }
        ]
      },
      defaultSize: 48,
      minSize: 25
    },
    { node: { type: "pane", id: "risk-matrix" }, defaultSize: 30, minSize: 15 }
  ]
};

export function ConflictsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const providerMode = useAppStore((s) => s.providerMode);

  const [batch, setBatch] = React.useState<BatchAssessmentResult | null>(null);
  const [overlaps, setOverlaps] = React.useState<ConflictOverlap[]>([]);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [selectedPair, setSelectedPair] = React.useState<{ laneAId: string; laneBId: string } | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>("summary");
  const [statusFilter, setStatusFilter] = React.useState<LaneStatusFilter>(null);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState<{ completedPairs: number; totalPairs: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [gitConflict, setGitConflict] = React.useState<GitConflictState | null>(null);
  const [gitConflictBusy, setGitConflictBusy] = React.useState(false);
  const [gitConflictError, setGitConflictError] = React.useState<string | null>(null);

  const [restackSuggestions, setRestackSuggestions] = React.useState<RestackSuggestion[]>([]);

  const [proposals, setProposals] = React.useState<ConflictProposal[]>([]);
  const [proposalBusy, setProposalBusy] = React.useState(false);
  const [proposalError, setProposalError] = React.useState<string | null>(null);
  const [externalRuns, setExternalRuns] = React.useState<ConflictExternalResolverRunSummary[]>([]);
  const [externalBusy, setExternalBusy] = React.useState<"codex" | "claude" | null>(null);
  const [externalError, setExternalError] = React.useState<string | null>(null);
  const [lastExternalRun, setLastExternalRun] = React.useState<ConflictExternalResolverRunSummary | null>(null);
  const [externalCommitBusyRunId, setExternalCommitBusyRunId] = React.useState<string | null>(null);
  const [externalCommitInfo, setExternalCommitInfo] = React.useState<string | null>(null);
  const [externalCommitError, setExternalCommitError] = React.useState<string | null>(null);

  const [proposalPeerLaneId, setProposalPeerLaneId] = React.useState<string | null>(null);
  const [proposalPreview, setProposalPreview] = React.useState<ConflictProposalPreview | null>(null);
  const [prepareBusy, setPrepareBusy] = React.useState(false);
  const [prepareError, setPrepareError] = React.useState<string | null>(null);
  const [sendBusy, setSendBusy] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const [applyMode, setApplyMode] = React.useState<"unstaged" | "staged" | "commit">("staged");
  const [commitMessage, setCommitMessage] = React.useState("Resolve conflicts (ADE)");

  const [continueBusy, setContinueBusy] = React.useState(false);
  const [continueError, setContinueError] = React.useState<string | null>(null);

  const [abortOpen, setAbortOpen] = React.useState(false);
  const [abortConfirm, setAbortConfirm] = React.useState("");
  const [abortBusy, setAbortBusy] = React.useState(false);
  const [abortError, setAbortError] = React.useState<string | null>(null);

  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const [mergePlan, setMergePlan] = React.useState<MergePlanState | null>(null);
  const [mergePlanBusy, setMergePlanBusy] = React.useState(false);
  const [mergePlanError, setMergePlanError] = React.useState<string | null>(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = React.useState(false);
  const [pendingMerge, setPendingMerge] = React.useState<{ targetLaneId: string; sourceLaneId: string } | null>(null);

  const [integrationBaseLaneId, setIntegrationBaseLaneId] = React.useState<string>(primaryLane?.id ?? "");
  const [integrationName, setIntegrationName] = React.useState("Integration lane");
  const [integrationBusy, setIntegrationBusy] = React.useState(false);
  const [integrationError, setIntegrationError] = React.useState<string | null>(null);
  const [integrationLaneId, setIntegrationLaneId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!integrationBaseLaneId && primaryLane?.id) setIntegrationBaseLaneId(primaryLane.id);
  }, [integrationBaseLaneId, primaryLane?.id]);

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus>();
    for (const status of batch?.lanes ?? []) {
      map.set(status.laneId, status);
    }
    return map;
  }, [batch]);

  const matrixByPair = React.useMemo(() => {
    const map = new Map<string, RiskMatrixEntry>();
    for (const entry of batch?.matrix ?? []) {
      map.set(pairKey(entry.laneAId, entry.laneBId), entry);
    }
    return map;
  }, [batch]);

  const sortedLanes = React.useMemo(() => {
    return [...lanes].sort((a, b) => {
      const statusA = statusByLane.get(a.id)?.status ?? "unknown";
      const statusB = statusByLane.get(b.id)?.status ?? "unknown";
      const rankDelta = statusRank(statusB) - statusRank(statusA);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name);
    });
  }, [lanes, statusByLane]);

  const laneSummaryCounts = React.useMemo(() => {
    const counts: Record<Exclude<LaneStatusFilter, null>, number> = {
      conflict: 0,
      "at-risk": 0,
      clean: 0,
      unknown: 0
    };
    for (const lane of sortedLanes) {
      counts[classifyStatus(statusByLane.get(lane.id)?.status)] += 1;
    }
    return counts;
  }, [sortedLanes, statusByLane]);

  const filteredLanes = React.useMemo(
    () => sortedLanes.filter((lane) => filterLaneByStatus(statusByLane.get(lane.id)?.status, statusFilter)),
    [sortedLanes, statusByLane, statusFilter]
  );

  const selectedLane = React.useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? null,
    [lanes, selectedLaneId]
  );

  const selectedStatus = selectedLaneId ? statusByLane.get(selectedLaneId) ?? null : null;

  const selectedPairEntry = React.useMemo(() => {
    if (!selectedPair) return null;
    return matrixByPair.get(pairKey(selectedPair.laneAId, selectedPair.laneBId)) ?? null;
  }, [matrixByPair, selectedPair]);

  const restackByLaneId = React.useMemo(() => {
    const map = new Map<string, RestackSuggestion>();
    for (const s of restackSuggestions) map.set(s.laneId, s);
    return map;
  }, [restackSuggestions]);

  const selectedRestackSuggestion = selectedLaneId ? restackByLaneId.get(selectedLaneId) ?? null : null;

  const loadBatch = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBatch] = await Promise.all([
        window.ade.conflicts.getBatchAssessment(),
        lanes.length ? Promise.resolve() : refreshLanes()
      ]);
      setBatch(nextBatch);
      setProgress(nextBatch.progress ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lanes.length, refreshLanes]);

  const loadLaneOverlaps = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.conflicts.listOverlaps({ laneId });
      setOverlaps(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOverlaps([]);
    }
  }, []);

  const loadProposals = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.conflicts.listProposals(laneId);
      setProposals(next);
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
      setProposals([]);
    }
  }, []);

  const loadExternalRuns = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.conflicts.listExternalResolverRuns({ laneId, limit: 8 });
      setExternalRuns(next);
    } catch (err) {
      setExternalError(err instanceof Error ? err.message : String(err));
      setExternalRuns([]);
    }
  }, []);

  const refreshGitConflict = React.useCallback(async (laneId: string) => {
    setGitConflictBusy(true);
    setGitConflictError(null);
    try {
      const next = await window.ade.git.getConflictState(laneId);
      setGitConflict(next);
    } catch (err) {
      setGitConflictError(err instanceof Error ? err.message : String(err));
      setGitConflict(null);
    } finally {
      setGitConflictBusy(false);
    }
  }, []);

  const refreshRestackSuggestions = React.useCallback(async () => {
    try {
      const next = await window.ade.lanes.listRestackSuggestions();
      setRestackSuggestions(next);
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    void loadBatch();
  }, [loadBatch]);

  React.useEffect(() => {
    if (!selectedLaneId && sortedLanes[0]?.id) {
      setSelectedLaneId(sortedLanes[0].id);
    }
  }, [selectedLaneId, sortedLanes]);

  React.useEffect(() => {
    if (selectedLaneId && !lanes.some((lane) => lane.id === selectedLaneId)) {
      setSelectedLaneId(lanes[0]?.id ?? null);
    }
  }, [lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) {
      setOverlaps([]);
      setProposals([]);
      setExternalRuns([]);
      setLastExternalRun(null);
      setGitConflict(null);
      return;
    }
    void loadLaneOverlaps(selectedLaneId);
    void loadProposals(selectedLaneId);
    void loadExternalRuns(selectedLaneId);
    void refreshGitConflict(selectedLaneId);

    // Reset AI preview when switching lanes.
    setProposalPeerLaneId(null);
    setProposalPreview(null);
    setPrepareError(null);
    setSendError(null);
    setExternalError(null);
    setExternalCommitInfo(null);
    setExternalCommitError(null);
    setExternalCommitBusyRunId(null);
  }, [selectedLaneId, loadLaneOverlaps, loadProposals, loadExternalRuns, refreshGitConflict]);

  React.useEffect(() => {
    void refreshRestackSuggestions();
    const unsubscribe = window.ade.lanes.onRestackSuggestionsEvent((event) => {
      if (event.type === "restack-suggestions-updated") {
        setRestackSuggestions(event.suggestions);
      }
    });
    return unsubscribe;
  }, [refreshRestackSuggestions]);

  React.useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type === "prediction-progress") {
        setProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
        return;
      }
      setProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
      void loadBatch();
      if (selectedLaneId && event.laneIds.includes(selectedLaneId)) {
        void loadLaneOverlaps(selectedLaneId);
      }
    });
    return unsubscribe;
  }, [loadBatch, loadLaneOverlaps, selectedLaneId]);

  const toggleStatusFilter = (value: Exclude<LaneStatusFilter, null>) => {
    setStatusFilter((prev) => (prev === value ? null : value));
  };

  const continueMergeOrRebase = async () => {
    if (!selectedLaneId || !gitConflict?.inProgress || !gitConflict.kind) return;
    setContinueBusy(true);
    setContinueError(null);
    try {
      if (gitConflict.kind === "rebase") {
        await window.ade.git.rebaseContinue(selectedLaneId);
      } else {
        await window.ade.git.mergeContinue(selectedLaneId);
      }
      await Promise.all([
        refreshGitConflict(selectedLaneId),
        refreshLanes(),
        loadBatch()
      ]);

      // If a merge-plan merge was blocked on conflicts, treat this as “merge complete” and advance.
      setMergePlan((prev) => {
        if (!prev?.activeMerge) return prev;
        if (prev.activeMerge.targetLaneId !== selectedLaneId) return prev;
        return {
          ...prev,
          cursor: Math.min(prev.cursor + 1, prev.sourceLaneIds.length),
          activeMerge: null
        };
      });
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    } finally {
      setContinueBusy(false);
    }
  };

  const runAbort = async () => {
    if (!selectedLaneId || !gitConflict?.inProgress || !gitConflict.kind) return;
    if (abortConfirm.trim().toUpperCase() !== "ABORT") {
      setAbortError('Type "ABORT" to confirm.');
      return;
    }
    setAbortBusy(true);
    setAbortError(null);
    try {
      if (gitConflict.kind === "rebase") {
        await window.ade.git.rebaseAbort(selectedLaneId);
      } else {
        await window.ade.git.mergeAbort(selectedLaneId);
      }
      setAbortOpen(false);
      setAbortConfirm("");
      await Promise.all([
        refreshGitConflict(selectedLaneId),
        refreshLanes(),
        loadBatch()
      ]);

      // Abort also clears merge-plan progress for the blocked merge.
      setMergePlan((prev) => {
        if (!prev?.activeMerge) return prev;
        if (prev.activeMerge.targetLaneId !== selectedLaneId) return prev;
        return { ...prev, activeMerge: null };
      });
    } catch (err) {
      setAbortError(err instanceof Error ? err.message : String(err));
    } finally {
      setAbortBusy(false);
    }
  };

  const runPrepareProposal = async () => {
    if (!selectedLaneId) return;
    if (providerMode !== "hosted" && providerMode !== "byok") {
      setPrepareError("AI proposals require Hosted or BYOK provider mode.");
      return;
    }

    setPrepareBusy(true);
    setPrepareError(null);
    setSendError(null);
    try {
      const preview = await window.ade.conflicts.prepareProposal({
        laneId: selectedLaneId,
        peerLaneId: proposalPeerLaneId
      });
      setProposalPreview(preview);
      // Also refresh conflict state after pack refresh to reflect any recently resolved files.
      await refreshGitConflict(selectedLaneId);
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : String(err));
      setProposalPreview(null);
    } finally {
      setPrepareBusy(false);
    }
  };

  const runSendProposal = async () => {
    if (!selectedLaneId || !proposalPreview) return;
    setSendBusy(true);
    setSendError(null);
    try {
      await window.ade.conflicts.requestProposal({
        laneId: selectedLaneId,
        peerLaneId: proposalPeerLaneId,
        contextDigest: proposalPreview.contextDigest
      });
      await loadProposals(selectedLaneId);
      await loadBatch();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  };

  const runExternalResolver = async (provider: "codex" | "claude") => {
    if (!selectedLaneId) return;
    const resolvedTargetLaneId = proposalPeerLaneId ?? selectedLane?.parentLaneId ?? primaryLane?.id ?? null;
    if (!resolvedTargetLaneId) {
      setExternalError("No target lane available. Pick a peer lane or ensure a primary lane exists.");
      return;
    }
    const sourceLaneIds =
      mergePlan && mergePlan.targetLaneId === resolvedTargetLaneId && mergePlan.sourceLaneIds.length > 1
        ? mergePlan.sourceLaneIds
        : [selectedLaneId];

    setExternalBusy(provider);
    setExternalError(null);
    try {
      const run = await window.ade.conflicts.runExternalResolver({
        provider,
        targetLaneId: resolvedTargetLaneId,
        sourceLaneIds,
        integrationLaneName: integrationName
      });
      setLastExternalRun(run);
      setExternalCommitInfo(null);
      await Promise.all([loadExternalRuns(selectedLaneId), loadBatch(), refreshLanes(), refreshGitConflict(selectedLaneId)]);
      if (run.status === "blocked" && run.contextGaps.length) {
        setExternalError(`Blocked: ${run.contextGaps.map((gap) => gap.message).join(" | ")}`);
      } else if (run.status === "failed") {
        setExternalError(run.error ?? "External resolver failed.");
      }
    } catch (err) {
      setExternalError(err instanceof Error ? err.message : String(err));
    } finally {
      setExternalBusy(null);
    }
  };

  const commitExternalRun = async (run: ConflictExternalResolverRunSummary) => {
    if (!selectedLaneId) return;
    setExternalCommitBusyRunId(run.runId);
    setExternalCommitError(null);
    setExternalCommitInfo(null);
    try {
      const committed = await window.ade.conflicts.commitExternalResolverRun({ runId: run.runId });
      const shortSha = committed.commitSha.slice(0, 10);
      setExternalCommitInfo(`Committed ${shortSha} on ${committed.laneId}.`);
      await Promise.all([loadExternalRuns(selectedLaneId), loadBatch(), refreshLanes(), refreshGitConflict(selectedLaneId)]);
    } catch (err) {
      setExternalCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setExternalCommitBusyRunId(null);
    }
  };

  const applyProposal = async (proposalId: string, withContinue: boolean) => {
    if (!selectedLaneId) return;
    const inProgress = gitConflict?.inProgress ?? false;
    const effectiveApplyMode = inProgress && applyMode === "commit" ? "staged" : applyMode;

    setProposalBusy(true);
    setProposalError(null);
    try {
      await window.ade.conflicts.applyProposal({
        laneId: selectedLaneId,
        proposalId,
        applyMode: effectiveApplyMode,
        ...(effectiveApplyMode === "commit" ? { commitMessage } : {})
      });
      await Promise.all([loadProposals(selectedLaneId), loadBatch(), refreshLanes(), refreshGitConflict(selectedLaneId)]);

      if (withContinue) {
        const next = await window.ade.git.getConflictState(selectedLaneId);
        setGitConflict(next);
        if (next.inProgress && next.canContinue && next.kind) {
          if (next.kind === "rebase") await window.ade.git.rebaseContinue(selectedLaneId);
          else await window.ade.git.mergeContinue(selectedLaneId);
          await Promise.all([refreshGitConflict(selectedLaneId), refreshLanes(), loadBatch()]);
        }
      }
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
    } finally {
      setProposalBusy(false);
    }
  };

  const undoProposal = async (proposalId: string) => {
    if (!selectedLaneId) return;
    setProposalBusy(true);
    setProposalError(null);
    try {
      await window.ade.conflicts.undoProposal({ laneId: selectedLaneId, proposalId });
      await Promise.all([loadProposals(selectedLaneId), loadBatch(), refreshLanes(), refreshGitConflict(selectedLaneId)]);
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
    } finally {
      setProposalBusy(false);
    }
  };

  const runRestack = async (laneId: string) => {
    setMergePlanError(null);
    setIntegrationError(null);
    setError(null);
    try {
      const res = await window.ade.lanes.restack({ laneId, recursive: true });
      await Promise.all([refreshRestackSuggestions(), refreshLanes(), loadBatch()]);
      if (res.error) {
        setError(res.error);
        // Restack failures can leave a rebase in progress; refresh conflict state if that lane is selected.
        if (selectedLaneId === laneId) {
          await refreshGitConflict(laneId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const dismissRestackSuggestion = async (laneId: string) => {
    try {
      await window.ade.lanes.dismissRestackSuggestion({ laneId });
      await refreshRestackSuggestions();
    } catch {
      // ignore
    }
  };

  const deferRestackSuggestion = async (laneId: string, minutes: number) => {
    try {
      await window.ade.lanes.deferRestackSuggestion({ laneId, minutes });
      await refreshRestackSuggestions();
    } catch {
      // ignore
    }
  };

  const initMergePlan = () => {
    const fallbackTarget = selectedLaneId ?? primaryLane?.id ?? lanes[0]?.id ?? "";
    const targetLaneId = mergePlan?.targetLaneId?.trim() || fallbackTarget;
    const defaultSources = lanes
      .filter((lane) => lane.id !== targetLaneId && lane.laneType !== "primary")
      .map((lane) => lane.id)
      .slice(0, 6);

    setMergePlan({
      targetLaneId,
      sourceLaneIds: defaultSources,
      cursor: 0,
      activeMerge: null
    });
  };

  const startNextMerge = () => {
    if (!mergePlan) return;
    const orderedSources = sortMergeSources(lanes, mergePlan.sourceLaneIds);
    const sourceLaneId = orderedSources[mergePlan.cursor];
    if (!sourceLaneId) return;
    setPendingMerge({ targetLaneId: mergePlan.targetLaneId, sourceLaneId });
    setMergeConfirmOpen(true);
  };

  const runPendingMerge = async () => {
    if (!pendingMerge) return;
    const { targetLaneId, sourceLaneId } = pendingMerge;
    const byId = lanesById(lanes);
    const target = byId.get(targetLaneId);
    const source = byId.get(sourceLaneId);
    if (!target || !source) {
      setMergePlanError("Target/source lane not found.");
      setMergeConfirmOpen(false);
      setPendingMerge(null);
      return;
    }

    setMergePlanBusy(true);
    setMergePlanError(null);
    try {
      await window.ade.git.sync({
        laneId: targetLaneId,
        mode: "merge",
        baseRef: source.branchRef
      });

      await Promise.all([refreshLanes(), loadBatch(), refreshGitConflict(targetLaneId)]);

      const conflictState = await window.ade.git.getConflictState(targetLaneId);
      setGitConflict(conflictState);

      setMergePlan((prev) => {
        if (!prev) return prev;
        const ordered = sortMergeSources(lanes, prev.sourceLaneIds);
        const current = ordered[prev.cursor];
        if (!current || current !== sourceLaneId) {
          return { ...prev, activeMerge: null };
        }

        if (conflictState.inProgress && conflictState.kind === "merge" && conflictState.conflictedFiles.length > 0) {
          return {
            ...prev,
            activeMerge: { targetLaneId, sourceLaneId }
          };
        }

        return {
          ...prev,
          cursor: Math.min(prev.cursor + 1, ordered.length),
          activeMerge: null
        };
      });
    } catch (err) {
      setMergePlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergePlanBusy(false);
      setMergeConfirmOpen(false);
      setPendingMerge(null);
    }
  };

  const createIntegrationLane = async () => {
    if (!integrationBaseLaneId) {
      setIntegrationError("Pick a base lane for the integration lane.");
      return;
    }
    const name = integrationName.trim();
    if (!name) {
      setIntegrationError("Integration lane name is required.");
      return;
    }

    setIntegrationBusy(true);
    setIntegrationError(null);
    try {
      const created = await window.ade.lanes.createChild({
        parentLaneId: integrationBaseLaneId,
        name,
        description: "Integration lane created by ADE Conflicts assistant"
      });
      setIntegrationLaneId(created.id);
      await refreshLanes();
      setSelectedLaneId(created.id);
      setMergePlan({
        targetLaneId: created.id,
        sourceLaneIds: [],
        cursor: 0,
        activeMerge: null
      });
    } catch (err) {
      setIntegrationError(err instanceof Error ? err.message : String(err));
    } finally {
      setIntegrationBusy(false);
    }
  };

  const suggestedPeerEntries = React.useMemo(() => {
    const entries = overlaps
      .map((o) => ({ peerId: o.peerId, peerName: o.peerName, riskLevel: o.riskLevel, count: o.files.length }))
      .sort((a, b) => b.count - a.count || a.peerName.localeCompare(b.peerName));
    return entries;
  }, [overlaps]);

  const orderedMergeSources = React.useMemo(() => {
    if (!mergePlan) return [];
    return sortMergeSources(lanes, mergePlan.sourceLaneIds);
  }, [lanes, mergePlan]);

  const mergeTargetLane = React.useMemo(() => {
    if (!mergePlan?.targetLaneId) return null;
    return lanes.find((l) => l.id === mergePlan.targetLaneId) ?? null;
  }, [lanes, mergePlan?.targetLaneId]);

  const mergeActive = mergePlan?.activeMerge ?? null;
  const mergeActiveSource = mergeActive ? lanes.find((l) => l.id === mergeActive.sourceLaneId) ?? null : null;

  const aiEnabled = providerMode === "hosted" || providerMode === "byok";

  /* ---- Pane configs ---- */

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    "lanes": {
      title: "Lanes",
      icon: Layers,
      meta: <span className="text-[10px] text-muted-fg">{filteredLanes.length}/{lanes.length}</span>,
      children: (
        <div className="h-full overflow-auto p-2">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("conflict")}
              className={cn(
                "cursor-pointer px-3 py-1 transition-all",
                statusFilter === "conflict"
                  ? "bg-red-500/25 text-red-200 ring-1 ring-inset ring-red-500/50 shadow-sm"
                  : "text-red-300/80 hover:bg-red-500/10 hover:text-red-200"
              )}
            >
              {laneSummaryCounts.conflict} conflict
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("at-risk")}
              className={cn(
                "cursor-pointer px-3 py-1 transition-all",
                statusFilter === "at-risk"
                  ? "bg-amber-500/25 text-amber-200 ring-1 ring-inset ring-amber-500/50 shadow-sm"
                  : "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200"
              )}
            >
              {laneSummaryCounts["at-risk"]} at-risk
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("clean")}
              className={cn(
                "cursor-pointer px-3 py-1 transition-all",
                statusFilter === "clean"
                  ? "bg-emerald-500/25 text-emerald-200 ring-1 ring-inset ring-emerald-500/50 shadow-sm"
                  : "text-emerald-300/80 hover:bg-emerald-500/10 hover:text-emerald-200"
              )}
            >
              {laneSummaryCounts.clean} clean
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("unknown")}
              className={cn(
                "cursor-pointer px-3 py-1 transition-all",
                statusFilter === "unknown"
                  ? "bg-muted/60 text-fg ring-1 ring-inset ring-muted-fg/30 shadow-sm"
                  : "text-muted-fg hover:bg-muted/40 hover:text-fg/80"
              )}
            >
              {laneSummaryCounts.unknown} unknown
            </Chip>
          </div>

          {filteredLanes.map((lane) => {
            const status = statusByLane.get(lane.id) ?? null;
            const selected = lane.id === selectedLaneId;
            const restack = restackByLaneId.get(lane.id) ?? null;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => {
                  setSelectedLaneId(lane.id);
                  setViewMode("summary");
                }}
                className={cn(
                  "mb-2 block w-full rounded-xl border-l-[3px] px-2.5 py-2.5 text-left transition-all",
                  statusBorderClass(status?.status ?? null),
                  selected
                    ? "shadow-card-hover bg-accent/10 ring-1 ring-accent/20"
                    : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full ring-2 ring-black/20", statusDotClass(status?.status ?? null))} />
                  <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                  {restack ? (
                    <span
                      className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-inset ring-amber-500/30"
                      title={`Parent advanced; behind ${restack.behindCount} commit(s).`}
                    >
                      <RefreshCw className="h-2.5 w-2.5" />
                      restack
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 pl-4 text-[11px] text-muted-fg">
                  {(status?.status ?? "unknown")} · overlaps {status?.overlappingFileCount ?? 0}
                </div>
              </button>
            );
          })}
        </div>
      )
    },
    "conflict-detail": {
      title: "Conflict Detail",
      icon: AlertTriangle,
      bodyClassName: "overflow-hidden",
      children: (
        <div className="h-full overflow-auto p-3">
          {selectedLane ? (
            <div className="space-y-3">
              <div className="rounded-xl shadow-card bg-card/30 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-4 w-4 text-accent" />
                      <div className="truncate text-sm font-semibold text-fg">{selectedLane.name}</div>
                      {selectedLane.laneType === "primary" ? <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-fg ring-1 ring-inset ring-muted-fg/20">(edit-protected)</span> : null}
                    </div>
                    <div className="mt-2 rounded-lg bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-fg">
                      <span className="text-muted-fg/60">branch</span> <span className="text-fg">{selectedLane.branchRef}</span>
                      <span className="mx-2 text-muted-fg/30">|</span>
                      <span className="text-muted-fg/60">base</span> <span className="text-fg/80">{selectedLane.baseRef}</span>
                      {selectedLane.parentLaneId ? (
                        <>
                          <span className="mx-2 text-muted-fg/30">|</span>
                          <span className="text-muted-fg/60">parent</span> <span className="text-fg/80">{lanes.find((l) => l.id === selectedLane.parentLaneId)?.name ?? selectedLane.parentLaneId}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void window.ade.lanes.openFolder({ laneId: selectedLane.id })}>
                      Open folder
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshGitConflict(selectedLane.id)}
                      disabled={gitConflictBusy}
                      title="Refresh merge/rebase state"
                    >
                      <RefreshCw className={cn("h-4 w-4", gitConflictBusy && "animate-spin")} />
                    </Button>
                  </div>
                </div>
              </div>

              {selectedRestackSuggestion ? (
                <div className="rounded-lg bg-amber-500/10 p-3 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 text-amber-200" />
                    <div className="min-w-0">
                      <div className="font-semibold text-amber-100">Parent advanced: restack recommended</div>
                      <div className="mt-1 text-amber-200/80">
                        This lane is behind its parent by {selectedRestackSuggestion.behindCount} commit(s). Restacking early can reduce conflicts downstream.
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runRestack(selectedLane.id)}>
                          Restack now
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void deferRestackSuggestion(selectedLane.id, 60)}>
                          Defer 1h
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void deferRestackSuggestion(selectedLane.id, 24 * 60)}>
                          Defer 1d
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void dismissRestackSuggestion(selectedLane.id)}>
                          Dismiss
                        </Button>
                      </div>
                      <div className="mt-2 text-[11px] text-amber-200/80">
                        What ADE will do: run a stack-aware rebase for this lane (and its children).
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className={cn(
                "rounded-xl shadow-card p-3 transition-colors",
                gitConflict?.inProgress
                  ? "bg-red-500/8 ring-1 ring-inset ring-red-500/20"
                  : "bg-card/30"
              )}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className={cn(
                      "text-[13px] font-semibold",
                      gitConflict?.inProgress ? "text-red-200" : "text-fg/70"
                    )}>Active Merge/Rebase</div>
                    <div className="mt-1 text-xs text-muted-fg">
                      {gitConflictError ? (
                        <span className="text-red-200">{gitConflictError}</span>
                      ) : gitConflict?.inProgress ? (
                        <span className="inline-flex items-center gap-1.5 text-fg">
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                          {gitConflict.kind === "merge" ? "MERGE" : "REBASE"} in progress · conflicted files: {gitConflict.conflictedFiles.length}
                        </span>
                      ) : (
                        <span>no merge/rebase in progress</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!gitConflict?.inProgress || !gitConflict?.canContinue || continueBusy}
                      onClick={() => void continueMergeOrRebase()}
                      title={gitConflict?.inProgress && !gitConflict?.canContinue ? "Resolve all conflicted files first" : "Continue"}
                    >
                      {continueBusy ? "Continuing..." : "Continue"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-700/60 text-red-200 hover:bg-red-900/20"
                      disabled={!gitConflict?.inProgress}
                      onClick={() => {
                        setAbortOpen(true);
                        setAbortConfirm("");
                        setAbortError(null);
                      }}
                    >
                      Abort...
                    </Button>
                  </div>
                </div>

                {continueError ? (
                  <div className="mt-2 rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{continueError}</div>
                ) : null}

                {gitConflict?.inProgress && gitConflict.conflictedFiles.length > 0 ? (
                  <div className="mt-3">
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-fg">
                      <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                      Conflicted files
                      <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300">{gitConflict.conflictedFiles.length}</span>
                    </div>
                    <div className="mt-2 grid gap-1 md:grid-cols-2">
                      {gitConflict.conflictedFiles.slice(0, 24).map((p) => (
                        <div key={p} className="flex items-center gap-2 truncate rounded-lg border border-red-500/10 bg-muted/15 px-2.5 py-1.5 text-[11px] font-mono text-muted-fg transition-colors hover:bg-muted/25" title={p}>
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400/70" />
                          <span className="truncate">{p}</span>
                        </div>
                      ))}
                      {gitConflict.conflictedFiles.length > 24 ? (
                        <div className="px-2.5 text-[11px] text-muted-fg">... ({gitConflict.conflictedFiles.length - 24} more)</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {mergeActive && mergeActiveSource ? (
                  <div className="mt-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200">
                    Merge plan is paused: merging <span className="text-amber-100 font-semibold">{mergeActiveSource.name}</span> into <span className="text-amber-100 font-semibold">{mergeTargetLane?.name ?? mergeActive.targetLaneId}</span>.
                    Resolve conflicts above, then click Continue.
                  </div>
                ) : null}
              </div>

              {viewMode === "matrix" ? (
                <div className="space-y-3">
                  <RiskMatrix
                    lanes={sortedLanes}
                    entries={batch?.matrix ?? []}
                    overlaps={batch?.overlaps ?? []}
                    selectedPair={selectedPair}
                    loading={loading}
                    progress={progress}
                    onSelectPair={(pair) => {
                      setSelectedPair(pair);
                      setViewMode("matrix");
                      setSelectedLaneId(pair.laneAId);
                    }}
                  />
                  {selectedPairEntry ? (
                    <div className="rounded-xl shadow-card bg-card/30 p-3 text-xs">
                      <div className="font-semibold text-fg">
                        Pair: {lanes.find((lane) => lane.id === selectedPairEntry.laneAId)?.name ?? selectedPairEntry.laneAId}
                        {" vs "}
                        {lanes.find((lane) => lane.id === selectedPairEntry.laneBId)?.name ?? selectedPairEntry.laneBId}
                      </div>
                      <div className="mt-1 text-muted-fg">
                        risk: {selectedPairEntry.riskLevel} · overlap files: {selectedPairEntry.overlapCount} · has conflict: {selectedPairEntry.hasConflict ? "yes" : "no"}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <ConflictSummary lane={selectedLane} status={selectedStatus} overlaps={overlaps} />
                  <MergeSimulationPanel
                    lanes={sortedLanes}
                    initialLaneAId={selectedLaneId}
                    initialLaneBId={selectedPair && selectedPair.laneAId !== selectedPair.laneBId ? selectedPair.laneBId : null}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-xl bg-muted/8 p-8 text-center">
              <Layers className="mb-3 h-8 w-8 text-muted-fg/30" />
              <div className="text-sm font-medium text-muted-fg/60">No lane selected</div>
              <div className="mt-1 text-xs text-muted-fg/40">Select a lane from the sidebar to inspect conflicts.</div>
            </div>
          )}
        </div>
      )
    },
    "resolution": {
      title: "Resolution",
      icon: Wrench,
      children: (
        <div className="h-full overflow-auto p-3">
          <div className="space-y-4">
            <div className="rounded-xl bg-muted/12 p-3 ring-1 ring-inset ring-muted-fg/5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold text-accent">1</span>
                    Merge one-by-one
                  </div>
                  <div className="mt-1 pl-7 text-[11px] text-muted-fg">
                    Merge selected lanes into a target lane, sequentially. Conflicts pause the plan.
                  </div>
                </div>
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={initMergePlan}>
                  {mergePlan ? "Reset" : "Set up"}
                </Button>
              </div>

              {mergePlan ? (
                <div className="mt-3 space-y-2">
                  {previewLines("What ADE will do", [
                    "For each selected lane: run git fetch --prune in the target lane.",
                    "Run git merge --no-edit <source-branch> in the target lane.",
                    "If conflicts occur, you resolve them and click Continue."
                  ])}

                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-muted-fg">Target</span>
                    <select
                      className="h-7 rounded-lg bg-muted/30 px-2 text-[11px]"
                      value={mergePlan.targetLaneId}
                      onChange={(e) => setMergePlan((prev) => (prev ? { ...prev, targetLaneId: e.target.value } : prev))}
                    >
                      {lanes.map((lane) => (
                        <option key={lane.id} value={lane.id}>
                          {lane.name}
                        </option>
                      ))}
                    </select>
                    {mergeTargetLane?.laneType === "primary" ? (
                      <span className="rounded-lg bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                        merging into primary modifies your base branch
                      </span>
                    ) : null}
                  </div>

                  <div className="max-h-32 overflow-auto rounded-lg bg-muted/15 p-2 text-[11px]">
                    {lanes
                      .filter((lane) => lane.id !== mergePlan.targetLaneId && lane.laneType !== "primary")
                      .map((lane) => {
                        const checked = mergePlan.sourceLaneIds.includes(lane.id);
                        return (
                          <label key={lane.id} className="flex items-center gap-2 py-0.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setMergePlan((prev) => {
                                  if (!prev) return prev;
                                  const next = new Set(prev.sourceLaneIds);
                                  if (e.target.checked) next.add(lane.id);
                                  else next.delete(lane.id);
                                  return { ...prev, sourceLaneIds: Array.from(next), cursor: 0, activeMerge: null };
                                })
                              }
                            />
                            <span className="truncate text-fg" title={lane.branchRef}>
                              {lane.name}
                            </span>
                            <span className="ml-auto text-muted-fg">depth {lane.stackDepth}</span>
                          </label>
                        );
                      })}
                  </div>

                  <div className="flex items-center gap-1.5 py-1">
                    {orderedMergeSources.map((srcId, idx) => {
                      const srcLane = lanes.find((l) => l.id === srcId);
                      const isDone = idx < mergePlan.cursor;
                      const isCurrent = idx === mergePlan.cursor;
                      return (
                        <div key={srcId} className="flex items-center gap-1.5">
                          {idx > 0 ? <div className={cn("h-px w-3", isDone ? "bg-emerald-500/50" : "bg-muted-fg/20")} /> : null}
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold transition-all",
                              isDone
                                ? "bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/40"
                                : isCurrent
                                  ? "bg-accent/20 text-accent ring-1 ring-accent/50"
                                  : "bg-muted/30 text-muted-fg ring-1 ring-muted-fg/20"
                            )}
                            title={srcLane?.name ?? srcId}
                          >
                            {isDone ? "\u2713" : idx + 1}
                          </div>
                        </div>
                      );
                    })}
                    {orderedMergeSources.length === 0 ? (
                      <span className="text-[11px] text-muted-fg">no lanes selected</span>
                    ) : null}
                  </div>

                  {mergePlanError ? (
                    <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{mergePlanError}</div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={mergePlanBusy || orderedMergeSources.length === 0 || mergePlan.cursor >= orderedMergeSources.length || !!mergePlan.activeMerge}
                      onClick={startNextMerge}
                    >
                      {mergePlanBusy ? "Working..." : "Merge next"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!mergePlan.activeMerge}
                      onClick={() => setMergePlan((prev) => (prev ? { ...prev, activeMerge: null } : prev))}
                      title="Only use this if you handled the merge outside ADE and want to advance the plan."
                    >
                      Mark merge unblocked
                    </Button>
                  </div>

                  {mergePlan.activeMerge ? (
                    <div className="mt-2 text-[11px] text-amber-200/90">
                      Merge is blocked on conflicts. Use the Active Merge/Rebase section above.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 rounded-lg bg-muted/10 p-3 text-xs text-muted-fg">
                  Set up a merge plan to merge lanes sequentially.
                </div>
              )}
            </div>

            <div className="rounded-xl bg-muted/12 p-3 ring-1 ring-inset ring-muted-fg/5">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold text-accent">2</span>
                Integration lane
              </div>
              <div className="mt-1 pl-7 text-[11px] text-muted-fg">
                Create a fresh lane from a base (usually Primary), merge lanes into it, resolve conflicts once, then merge it back.
              </div>

              {previewLines("What ADE will do", [
                "Create a new child lane from the base lane's current HEAD.",
                "You then merge lanes into that integration lane using the merge plan workflow.",
                "This avoids editing Primary until you're ready."
              ])}

              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-muted-fg">Base</span>
                  <select
                    className="h-7 rounded-lg bg-muted/30 px-2 text-[11px]"
                    value={integrationBaseLaneId}
                    onChange={(e) => setIntegrationBaseLaneId(e.target.value)}
                  >
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    className="h-7 flex-1 rounded-lg bg-muted/30 px-2 text-[11px] text-fg"
                    value={integrationName}
                    onChange={(e) => setIntegrationName(e.target.value)}
                    placeholder="Integration lane name"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void createIntegrationLane()}
                    disabled={integrationBusy}
                  >
                    {integrationBusy ? "Creating..." : "Create"}
                  </Button>
                </div>

                {integrationError ? (
                  <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{integrationError}</div>
                ) : null}

                {integrationLaneId ? (
                  <div className="rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-200">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4" />
                      Integration lane created.
                    </div>
                    <div className="mt-1 text-[11px] text-emerald-200/80">Target lane is now set to that integration lane.</div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="rounded-xl bg-muted/12 p-3 ring-1 ring-inset ring-muted-fg/5">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold text-accent">3</span>
                Pre-align lanes
              </div>
              <div className="mt-1 pl-7 text-[11px] text-muted-fg">When parents advance, restack children early to reduce conflicts.</div>
              {restackSuggestions.length === 0 ? (
                <div className="mt-2 rounded-lg bg-muted/10 p-3 text-xs text-muted-fg">
                  No restack suggestions right now.
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  {restackSuggestions.slice(0, 8).map((s) => {
                    const lane = lanes.find((l) => l.id === s.laneId);
                    const parent = lanes.find((l) => l.id === s.parentLaneId);
                    const restackStatus = statusByLane.get(s.laneId)?.status ?? null;
                    return (
                      <div key={s.laneId} className={cn("rounded-lg border-l-[3px] bg-muted/15 p-2.5 text-xs", statusBorderClass(restackStatus))}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-fg font-semibold">{lane?.name ?? s.laneId}</div>
                            <div className="mt-0.5 text-[11px] text-muted-fg">
                              behind <span className="font-medium text-amber-200">{s.behindCount}</span> · parent {parent?.name ?? s.parentLaneId}
                              {s.hasPr ? <span className="ml-2 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-inset ring-accent/20">PR</span> : null}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runRestack(s.laneId)}>
                              Restack
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void deferRestackSuggestion(s.laneId, 60)}>
                              Defer 1h
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void dismissRestackSuggestion(s.laneId)}>
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    },
    "risk-matrix": {
      title: "AI Assistant",
      icon: Grid3x3,
      headerActions: (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          disabled={!selectedLaneId}
          onClick={() => {
            setProposalPreview(null);
            setPrepareError(null);
            setSendError(null);
          }}
          title="Clear preview"
        >
          Clear
        </Button>
      ),
      children: (
        <div className="h-full overflow-auto p-3">
          <div className="rounded-xl shadow-card bg-gradient-to-br from-card/40 to-card/20 p-3 ring-1 ring-inset ring-accent/10">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Sparkles className="h-4 w-4 text-accent" />
              AI Conflict Assistant
            </div>
            <div className="mt-1 text-xs text-muted-fg">
              {aiEnabled ? (
                <span>
                  provider: <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">{providerMode}</span>
                </span>
              ) : (
                <span>Hosted/BYOK is optional. External Codex/Claude resolver actions are always available if configured.</span>
              )}
            </div>

            {!selectedLaneId ? (
              <div className="mt-3 rounded-lg bg-muted/10 p-3 text-xs text-muted-fg">
                Select a lane.
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {previewLines("What ADE will do", [
                  "Refresh deterministic packs (lane pack + conflict pack).",
                  "Build a bounded context (up to 6 files, diff excerpts, and conflict-pack excerpt).",
                  "Run either hosted proposal flow or external Codex/Claude resolver with scoped context."
                ])}

                <div className="rounded-lg bg-muted/15 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-muted-fg">Peer context</div>
                    <select
                      className="h-7 rounded-lg bg-muted/30 px-2 text-[11px]"
                      value={proposalPeerLaneId ?? ""}
                      onChange={(e) => setProposalPeerLaneId(e.target.value ? e.target.value : null)}
                      title="Pick which peer/base to include in diff context"
                    >
                      <option value="">(use base / stack parent)</option>
                      {suggestedPeerEntries
                        .filter((e) => e.peerId)
                        .slice(0, 18)
                        .map((entry) => (
                          <option key={entry.peerId!} value={entry.peerId!}>
                            {entry.peerName} ({entry.count} files)
                          </option>
                        ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    className="bg-gradient-to-r from-emerald-600 to-teal-600 shadow-md shadow-emerald-900/30 transition-all hover:shadow-lg hover:shadow-emerald-900/40 hover:brightness-110"
                    disabled={!selectedLaneId || externalBusy != null}
                    onClick={() => void runExternalResolver("codex")}
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    {externalBusy === "codex" ? "Resolving..." : "Resolve with Codex"}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="bg-gradient-to-r from-violet-600 to-purple-600 shadow-md shadow-violet-900/30 transition-all hover:shadow-lg hover:shadow-violet-900/40 hover:brightness-110"
                    disabled={!selectedLaneId || externalBusy != null}
                    onClick={() => void runExternalResolver("claude")}
                  >
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    {externalBusy === "claude" ? "Resolving..." : "Resolve with Claude"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!aiEnabled || prepareBusy}
                    onClick={() => void runPrepareProposal()}
                  >
                    {prepareBusy ? "Preparing..." : "Legacy preview"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!proposalPreview || sendBusy}
                    onClick={() => void runSendProposal()}
                    title={proposalPreview?.existingProposalId ? "This exact context already has a proposal; clicking will reuse it." : "Send to AI"}
                  >
                    {sendBusy ? "Sending..." : proposalPreview?.existingProposalId ? "Reuse proposal" : "Legacy send"}
                  </Button>
                </div>

                {prepareError ? (
                  <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{prepareError}</div>
                ) : null}
                {sendError ? (
                  <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{sendError}</div>
                ) : null}
                {externalError ? (
                  <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{externalError}</div>
                ) : null}

                {proposalPreview ? (
                  <div className="rounded-lg bg-muted/15 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-fg font-semibold">Preview</div>
                      <div className="text-[11px] text-muted-fg">context {formatShortSha(proposalPreview.contextDigest)}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-fg">
                      files: {proposalPreview.stats.fileCount} · approx chars: {proposalPreview.stats.approxChars.toLocaleString()}
                      {" "}· lane export: {proposalPreview.stats.laneExportChars.toLocaleString()}
                      {" "}· peer export: {proposalPreview.stats.peerLaneExportChars.toLocaleString()}
                      {" "}· conflict export: {proposalPreview.stats.conflictExportChars.toLocaleString()}
                      {proposalPreview.activeConflict.inProgress ? (
                        <>
                          {" "}· active {proposalPreview.activeConflict.kind}
                        </>
                      ) : null}
                    </div>
                    {proposalPreview.warnings.length ? (
                      <div className="mt-2 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                        {proposalPreview.warnings.slice(0, 3).join(" ")}
                      </div>
                    ) : null}

                    {proposalPreview.laneExportLite || proposalPreview.peerLaneExportLite || proposalPreview.conflictExportStandard ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-fg">Exports sent to AI</summary>
                        {proposalPreview.laneExportLite ? (
                          <div className="mt-2">
                            <div className="text-[11px] font-semibold text-fg">Lane export (lite)</div>
                            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                              {proposalPreview.laneExportLite}
                            </pre>
                          </div>
                        ) : null}
                        {proposalPreview.peerLaneExportLite ? (
                          <div className="mt-2">
                            <div className="text-[11px] font-semibold text-fg">Peer lane export (lite)</div>
                            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                              {proposalPreview.peerLaneExportLite}
                            </pre>
                          </div>
                        ) : null}
                        {proposalPreview.conflictExportStandard ? (
                          <div className="mt-2">
                            <div className="text-[11px] font-semibold text-fg">Conflict export (standard)</div>
                            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                              {proposalPreview.conflictExportStandard}
                            </pre>
                          </div>
                        ) : null}
                      </details>
                    ) : null}

                    {proposalPreview.files.length ? (
                      <div className="mt-2">
                        <div className="text-[11px] font-semibold text-fg">Included files</div>
                        <div className="mt-1 space-y-2">
                          {proposalPreview.files.map((f) => (
                            <details key={f.path} className="rounded-lg bg-muted/20 p-2">
                              <summary className="cursor-pointer text-[11px] text-fg">
                                {f.path} <span className="text-muted-fg">({f.includeReason})</span>
                              </summary>
                              {f.markerPreview ? (
                                <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                                  {f.markerPreview}
                                </pre>
                              ) : null}
                              {f.laneDiff ? (
                                <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                                  {f.laneDiff}
                                </pre>
                              ) : null}
                              {f.peerDiff ? (
                                <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                                  {f.peerDiff}
                                </pre>
                              ) : null}
                            </details>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="rounded-xl bg-muted/12 p-3 text-xs ring-1 ring-inset ring-muted-fg/5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-fg font-semibold">
                      <Wrench className="h-3.5 w-3.5 text-muted-fg" />
                      External Resolver Runs
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!selectedLaneId}
                      onClick={() => selectedLaneId && void loadExternalRuns(selectedLaneId)}
                    >
                      Refresh
                    </Button>
                  </div>
                  {lastExternalRun ? (
                    <div className="mt-1 text-[11px] text-muted-fg">
                      last run: {lastExternalRun.provider} {lastExternalRun.status} · patch {lastExternalRun.patchPath ?? "none"}
                    </div>
                  ) : null}
                  {externalCommitInfo ? (
                    <div className="mt-2 rounded-lg bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">{externalCommitInfo}</div>
                  ) : null}
                  {externalCommitError ? (
                    <div className="mt-2 rounded-lg bg-red-500/10 px-2 py-1 text-[11px] text-red-200">{externalCommitError}</div>
                  ) : null}
                  {externalRuns.length === 0 ? (
                    <div className="mt-2 text-muted-fg">No runs yet.</div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {externalRuns.map((run) => (
                        <div key={run.runId} className={cn(
                          "rounded-lg border-l-[3px] bg-muted/15 p-2.5",
                          run.status === "completed" ? "border-l-emerald-500" : run.status === "failed" ? "border-l-red-500" : "border-l-amber-500"
                        )}>
                          <div className="flex items-center gap-2 text-[11px] text-fg">
                            <span className={cn(
                              "inline-block h-1.5 w-1.5 rounded-full",
                              run.status === "completed" ? "bg-emerald-500" : run.status === "failed" ? "bg-red-500" : "bg-amber-500 animate-pulse"
                            )} />
                            <span className="font-medium">{run.provider}</span>
                            <span className="text-muted-fg">{run.status}</span>
                            <span className="ml-auto text-muted-fg/60">{run.sourceLaneIds.join(", ")} → {run.targetLaneId}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-fg">
                            summary: {run.summary ?? "none"} · patch: {run.patchPath ?? "none"}
                          </div>
                          <div className="text-[11px] text-muted-fg">execution lane: {run.cwdLaneId}</div>
                          <div className="text-[11px] text-muted-fg">log: {run.logPath ?? "none"}</div>
                          {run.commitSha ? (
                            <div className="mt-1 text-[11px] text-emerald-200">
                              committed: {run.commitSha.slice(0, 12)} · {run.commitMessage ?? "commit message unavailable"}
                            </div>
                          ) : null}
                          {run.insufficientContext ? (
                            <div className="mt-1 text-[11px] text-amber-200">
                              gaps: {run.contextGaps.map((gap) => gap.message).join(" | ")}
                            </div>
                          ) : null}
                          {run.error ? (
                            <div className="mt-1 text-[11px] text-red-200">error: {run.error}</div>
                          ) : null}
                          <div className="mt-2 flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              disabled={
                                run.status !== "completed" ||
                                !run.patchPath ||
                                Boolean(run.commitSha) ||
                                externalCommitBusyRunId === run.runId
                              }
                              onClick={() => void commitExternalRun(run)}
                              title="Commit only files from this external resolver run. This does not push."
                            >
                              {externalCommitBusyRunId === run.runId ? "Committing..." : run.commitSha ? "Committed" : "Quick Commit"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl bg-muted/12 p-3 text-xs ring-1 ring-inset ring-muted-fg/5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-fg font-semibold">
                      <Sparkles className="h-3.5 w-3.5 text-muted-fg" />
                      Proposals
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={proposalBusy || !selectedLaneId}
                      onClick={() => selectedLaneId && void loadProposals(selectedLaneId)}
                    >
                      Refresh
                    </Button>
                  </div>

                  {proposalError ? (
                    <div className="mt-2 rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{proposalError}</div>
                  ) : null}

                  {proposals.length === 0 ? (
                    <div className="mt-2 text-xs text-muted-fg">No proposals yet.</div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {proposals.map((proposal) => (
                        <div key={proposal.id} className={cn(
                          "rounded-xl border-l-[3px] shadow-card p-3",
                          proposal.status === "applied" ? "border-l-emerald-500 bg-card/40" : proposal.status === "rejected" ? "border-l-red-500 bg-card/30" : "border-l-accent bg-card/30"
                        )}>
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="font-medium text-fg">{proposal.source}</span>
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                proposal.status === "applied" ? "bg-emerald-500/15 text-emerald-300" : proposal.status === "rejected" ? "bg-red-500/15 text-red-300" : "bg-accent/15 text-accent"
                              )}>{proposal.status}</span>
                              <span className="text-muted-fg">
                                {proposal.confidence != null ? `${Math.round(proposal.confidence * 100)}%` : "n/a"}
                              </span>
                            </div>
                          </div>

                          {proposal.explanation.trim().length ? (
                            <div className="mt-1 whitespace-pre-wrap text-xs text-fg">
                              {proposal.explanation.slice(0, 380)}
                              {proposal.explanation.length > 380 ? "..." : ""}
                            </div>
                          ) : null}

                          <div className="mt-3 rounded-lg bg-muted/20 p-2.5 ring-1 ring-inset ring-muted-fg/8">
                            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg/70">Apply options</div>
                            <div className="flex flex-wrap gap-2 text-[11px] text-muted-fg">
                              {(["unstaged", "staged", "commit"] as const)
                                .filter((mode) => !(gitConflict?.inProgress && mode === "commit"))
                                .map((mode) => (
                                  <label key={mode} className="inline-flex items-center gap-1">
                                    <input type="radio" checked={applyMode === mode} onChange={() => setApplyMode(mode)} />
                                    <span>{mode}</span>
                                  </label>
                                ))}
                            </div>
                            {applyMode === "commit" && !(gitConflict?.inProgress ?? false) ? (
                              <input
                                className="mt-2 h-7 w-full rounded-lg bg-muted/30 px-2 text-[11px] text-fg"
                                value={commitMessage}
                                onChange={(e) => setCommitMessage(e.target.value)}
                                placeholder="Commit message"
                              />
                            ) : null}
                            {gitConflict?.inProgress && applyMode === "commit" ? (
                              <div className="mt-2 text-[11px] text-muted-fg">
                                Commit apply is disabled during an active merge/rebase. Use staged/unstaged, then Continue.
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={proposalBusy || proposal.status !== "pending"}
                              onClick={() => void applyProposal(proposal.id, false)}
                            >
                              Apply
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={proposalBusy || proposal.status !== "pending" || !(gitConflict?.inProgress ?? false)}
                              onClick={() => void applyProposal(proposal.id, true)}
                              title="Apply and then attempt to continue merge/rebase if possible"
                            >
                              Apply + Continue
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={proposalBusy || proposal.status !== "applied"}
                              onClick={() => void undoProposal(proposal.id)}
                            >
                              Undo
                            </Button>
                          </div>

                          {proposal.diffPatch.trim().length ? (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[11px] text-muted-fg">diff patch</summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted/20 p-2 text-[10px] text-fg whitespace-pre-wrap">
                                {proposal.diffPatch.slice(0, 2000)}
                                {proposal.diffPatch.length > 2000 ? "\n...(truncated)...\n" : ""}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {proposalError ? (
                    <div className="mt-2 rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{proposalError}</div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      )
    }
  }), [
    filteredLanes, lanes, statusByLane, statusFilter, laneSummaryCounts, selectedLaneId,
    restackByLaneId, selectedLane, selectedRestackSuggestion, gitConflict, gitConflictBusy,
    gitConflictError, continueBusy, continueError, mergeActive, mergeActiveSource,
    mergeTargetLane, viewMode, sortedLanes, batch, selectedPair, selectedPairEntry,
    loading, progress, selectedStatus, overlaps, mergePlan, mergePlanBusy, mergePlanError,
    orderedMergeSources, integrationBaseLaneId, integrationName, integrationBusy,
    integrationError, integrationLaneId, restackSuggestions, aiEnabled, providerMode,
    proposalPeerLaneId, suggestedPeerEntries, externalBusy, prepareBusy, proposalPreview,
    sendBusy, prepareError, sendError, externalError, lastExternalRun, externalCommitInfo,
    externalCommitError, externalRuns, externalCommitBusyRunId, proposalBusy, proposalError,
    proposals, applyMode, commitMessage, selectedLaneId
  ]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Toolbar / header bar */}
      <div className="flex items-center gap-3 border-b border-border/15 px-4 py-2.5">
        <div className="text-sm font-semibold text-fg">Conflicts</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-fg">
          <span>{lanes.length} lanes</span>
          <span className="text-muted-fg/30">/</span>
          <span className={cn(
            (batch?.lanes.filter((entry) => entry.status === "conflict-predicted" || entry.status === "conflict-active").length ?? 0) > 0
              ? "text-red-300"
              : "text-muted-fg"
          )}>
            {batch?.lanes.filter((entry) => entry.status === "conflict-predicted" || entry.status === "conflict-active").length ?? 0} conflicts
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center rounded-lg bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("summary")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-all",
                viewMode === "summary"
                  ? "bg-accent text-accent-fg shadow-sm"
                  : "text-muted-fg hover:text-fg"
              )}
            >
              Summary
            </button>
            <button
              type="button"
              onClick={() => setViewMode("matrix")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-all",
                viewMode === "matrix"
                  ? "bg-accent text-accent-fg shadow-sm"
                  : "text-muted-fg hover:text-fg"
              )}
            >
              Matrix
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void window.ade.conflicts
                .runPrediction({})
                .then((next) => {
                  setBatch(next);
                  setProgress(next.progress ?? null);
                })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            Run Prediction
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadBatch()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {error ? <div className="bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div> : null}

      {/* Pane tiling layout */}
      <PaneTilingLayout
        layoutId="conflicts:tiling:v1"
        tree={CONFLICTS_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />

      {/* Abort dialog */}
      <Dialog.Root open={abortOpen} onOpenChange={(open) => { setAbortOpen(open); setAbortError(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-[--color-surface-overlay] backdrop-blur-xl p-5 shadow-float focus:outline-none">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold text-fg">Abort merge/rebase</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm" disabled={abortBusy}>
                  Close
                </Button>
              </Dialog.Close>
            </div>

            <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-200">
              Aborting discards the in-progress merge/rebase state for the selected lane.
            </div>

            {previewLines("What ADE will do", [
              gitConflict?.kind === "rebase" ? "Run: git rebase --abort" : "Run: git merge --abort",
              "Leave your branch HEAD unchanged, but drop the in-progress operation."
            ])}

            <div className="mt-3 rounded-lg bg-muted/20 p-2 text-xs">
              <div className="text-muted-fg">Type <span className="text-fg font-semibold">ABORT</span> to confirm.</div>
              <input
                className="mt-2 h-8 w-full rounded-lg bg-muted/30 px-2 text-xs text-fg"
                value={abortConfirm}
                onChange={(e) => setAbortConfirm(e.target.value)}
                placeholder="ABORT"
              />
            </div>

            {abortError ? (
              <div className="mt-3 rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{abortError}</div>
            ) : null}

            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={abortBusy}
                onClick={() => {
                  setAbortOpen(false);
                  setAbortConfirm("");
                  setAbortError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-700/60 text-red-200 hover:bg-red-900/20"
                disabled={abortBusy}
                onClick={() => void runAbort()}
              >
                {abortBusy ? "Aborting..." : "Abort"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Merge confirm dialog */}
      <Dialog.Root open={mergeConfirmOpen} onOpenChange={(open) => { setMergeConfirmOpen(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-[--color-surface-overlay] backdrop-blur-xl p-5 shadow-float focus:outline-none">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold text-fg">Confirm merge</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm" disabled={mergePlanBusy}>
                  Close
                </Button>
              </Dialog.Close>
            </div>

            {pendingMerge ? (
              (() => {
                const byId = lanesById(lanes);
                const target = byId.get(pendingMerge.targetLaneId);
                const source = byId.get(pendingMerge.sourceLaneId);
                const bullets = [
                  `Target lane: ${target?.name ?? pendingMerge.targetLaneId}`,
                  `Run: git fetch --prune`,
                  `Run: git merge --no-edit ${source?.branchRef ?? pendingMerge.sourceLaneId}`,
                  "If conflicts occur, ADE will keep the merge in progress and surface conflicted files."
                ];
                return (
                  <div className="space-y-3">
                    {previewLines("What ADE will do", bullets)}
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="outline" disabled={mergePlanBusy} onClick={() => setMergeConfirmOpen(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" disabled={mergePlanBusy} onClick={() => void runPendingMerge()}>
                        {mergePlanBusy ? "Merging..." : "Run merge"}
                      </Button>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="text-xs text-muted-fg">No pending merge.</div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
