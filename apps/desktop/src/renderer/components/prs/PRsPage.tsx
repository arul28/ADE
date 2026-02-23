import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Eye, GitMerge, GitPullRequest, Plus, Sparkle } from "@phosphor-icons/react";
import type {
  LandResult,
  LaneSummary,
  MergeMethod,
  PrCheck,
  PrComment,
  PrMergeContext,
  PrReview,
  PrStatus,
  PrSummary,
  PrWithConflicts,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { CreatePrModal } from "./CreatePrModal";
import { PrConflictBadge } from "./PrConflictBadge";
import { ResolverTerminalModal } from "../conflicts/modals/ResolverTerminalModal";

type WorkflowTab = "normal" | "stacked" | "integration";

type ChainItem = {
  laneId: string;
  laneName: string;
  depth: number;
  pr: PrWithConflicts | null;
};

const PRS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "pr-list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "pr-detail" }, defaultSize: 64, minSize: 30 },
  ],
};

function sortByCreatedAtAsc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function stateChip(state: PrSummary["state"]): { label: string; className: string } {
  if (state === "draft") return { label: "draft", className: "text-purple-300 border border-purple-500/30 bg-purple-500/10" };
  if (state === "open") return { label: "open", className: "text-blue-300 border border-blue-500/30 bg-blue-500/10" };
  if (state === "merged") return { label: "merged", className: "text-emerald-300 border border-emerald-500/30 bg-emerald-500/10" };
  return { label: "closed", className: "text-neutral-300 border border-neutral-500/30 bg-neutral-500/10" };
}

function checksChip(status: PrSummary["checksStatus"]): { label: string; dotColor: string; className: string } {
  if (status === "passing") return { label: "passing", dotColor: "bg-emerald-400", className: "text-emerald-300 border border-emerald-500/30 bg-emerald-500/10" };
  if (status === "failing") return { label: "failing", dotColor: "bg-red-400", className: "text-red-300 border border-red-500/30 bg-red-500/10" };
  if (status === "pending") return { label: "pending", dotColor: "bg-amber-400", className: "text-amber-300 border border-amber-500/30 bg-amber-500/10" };
  return { label: "none", dotColor: "bg-neutral-400", className: "text-neutral-300 border border-neutral-500/30 bg-neutral-500/10" };
}

function reviewsChip(status: PrSummary["reviewStatus"]): { label: string; className: string } {
  if (status === "approved") return { label: "approved", className: "text-emerald-300 border border-emerald-500/30 bg-emerald-500/10" };
  if (status === "changes_requested") return { label: "changes requested", className: "text-amber-300 border border-amber-500/30 bg-amber-500/10" };
  if (status === "requested") return { label: "requested", className: "text-blue-300 border border-blue-500/30 bg-blue-500/10" };
  return { label: "none", className: "text-neutral-300 border border-neutral-500/30 bg-neutral-500/10" };
}

function workflowChip(type: WorkflowTab): { label: string; className: string } {
  if (type === "integration") {
    return {
      label: "integration",
      className: "text-[11px] text-violet-200 border border-violet-500/30 bg-violet-500/12",
    };
  }
  if (type === "stacked") {
    return {
      label: "stacked",
      className: "text-[11px] text-cyan-200 border border-cyan-500/30 bg-cyan-500/12",
    };
  }
  return {
    label: "normal",
    className: "text-[11px] text-slate-200 border border-slate-500/30 bg-slate-500/12",
  };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

function laneNameFromId(laneById: Map<string, LaneSummary>, laneId: string): string {
  return laneById.get(laneId)?.name ?? laneId;
}

function checkRowState(check: PrCheck): { label: string; className: string } {
  if (check.conclusion === "success") return { label: "success", className: "text-emerald-300" };
  if (check.conclusion === "failure") return { label: "failure", className: "text-red-300" };
  if (check.conclusion === "neutral") return { label: "neutral", className: "text-blue-300" };
  if (check.conclusion === "cancelled") return { label: "cancelled", className: "text-neutral-300" };
  if (check.conclusion === "skipped") return { label: "skipped", className: "text-neutral-300" };
  if (check.status === "in_progress") return { label: "running", className: "text-amber-300" };
  if (check.status === "queued") return { label: "queued", className: "text-amber-300" };
  return { label: check.status, className: "text-muted-fg" };
}

export function PRsPage() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [prs, setPrs] = React.useState<PrWithConflicts[]>([]);
  const [workflowTab, setWorkflowTab] = React.useState<WorkflowTab>("integration");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");
  const [selectedPrId, setSelectedPrId] = React.useState<string | null>(null);

  const [landStackDialog, setLandStackDialog] = React.useState<{
    rootLaneId: string;
    rootLaneName: string;
    running: boolean;
    results: LandResult[] | null;
    error: string | null;
  } | null>(null);

  const [createPrOpen, setCreatePrOpen] = React.useState(false);

  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionResult, setActionResult] = React.useState<LandResult | null>(null);
  const [descPreview, setDescPreview] = React.useState<{ title: string; body: string } | null>(null);
  const [descPreviewBusy, setDescPreviewBusy] = React.useState(false);

  const [mergeContextByPrId, setMergeContextByPrId] = React.useState<Record<string, PrMergeContext>>({});
  const [mergeContextLookupBusy, setMergeContextLookupBusy] = React.useState(false);

  const [detailStatus, setDetailStatus] = React.useState<PrStatus | null>(null);
  const [detailChecks, setDetailChecks] = React.useState<PrCheck[]>([]);
  const [detailReviews, setDetailReviews] = React.useState<PrReview[]>([]);
  const [detailComments, setDetailComments] = React.useState<PrComment[]>([]);
  const [detailBusy, setDetailBusy] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [resolverTargetLaneId, setResolverTargetLaneId] = React.useState<string | null>(null);
  const [resolverSourceLaneIds, setResolverSourceLaneIds] = React.useState<string[]>([]);
  const [resolverWorktree, setResolverWorktree] = React.useState<"target" | "source">("target");
  const [autoCommitAfterResolve, setAutoCommitAfterResolve] = React.useState(false);
  const [autoPushAfterResolve, setAutoPushAfterResolve] = React.useState(false);
  const [autoCommitMessage, setAutoCommitMessage] = React.useState("Resolve integration conflicts");

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);
  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);
  const prById = React.useMemo(() => new Map(prs.map((pr) => [pr.id, pr] as const)), [prs]);

  const selectedPr = selectedPrId ? prById.get(selectedPrId) ?? null : null;
  const selectedMergeContext = selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null;

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!lanes.length) await refreshLanes();
      const next = await window.ade.prs.listWithConflicts();
      setPrs(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPrs([]);
    } finally {
      setLoading(false);
    }
  }, [lanes.length, refreshLanes]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      setPrs((prev) => {
        const prevMap = new Map(prev.map((p) => [p.id, p]));
        return event.prs.map((pr) => ({
          ...pr,
          conflictAnalysis: prevMap.get(pr.id)?.conflictAnalysis ?? null,
        }));
      });
    });
    return () => {
      unsub();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!prs.length) {
      setMergeContextByPrId({});
      return;
    }

    setMergeContextLookupBusy(true);
    void Promise.all(
      prs.map(async (pr) => {
        try {
          const context = await window.ade.prs.getMergeContext(pr.id);
          return [pr.id, context] as const;
        } catch {
          return [pr.id, null] as const;
        }
      })
    )
      .then((entries) => {
        if (cancelled) return;
        const next: Record<string, PrMergeContext> = {};
        for (const [prId, context] of entries) {
          if (!context) continue;
          next[prId] = context;
        }
        setMergeContextByPrId(next);
      })
      .finally(() => {
        if (!cancelled) setMergeContextLookupBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [prs]);

  const workflowTypeByPrId = React.useMemo(() => {
    const out = new Map<string, WorkflowTab>();
    for (const pr of prs) {
      const context = mergeContextByPrId[pr.id];
      const lane = laneById.get(pr.laneId);

      let type: WorkflowTab = "normal";
      if (context?.groupType === "integration") {
        type = "integration";
      } else if (context?.groupType === "stacked") {
        type = "stacked";
      } else if (/integrat/i.test(lane?.name ?? "")) {
        type = "integration";
      } else if (lane?.parentLaneId) {
        type = "stacked";
      }

      out.set(pr.id, type);
    }
    return out;
  }, [laneById, mergeContextByPrId, prs]);

  const allPrsSorted = React.useMemo(() => {
    const laneName = (laneId: string) => laneById.get(laneId)?.name ?? laneId;
    return [...prs].sort((a, b) => {
      const aTs = Date.parse(a.updatedAt);
      const bTs = Date.parse(b.updatedAt);
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
      return laneName(a.laneId).localeCompare(laneName(b.laneId));
    });
  }, [laneById, prs]);

  const integrationPrs = React.useMemo(
    () => allPrsSorted.filter((pr) => workflowTypeByPrId.get(pr.id) === "integration"),
    [allPrsSorted, workflowTypeByPrId]
  );
  const stackedPrs = React.useMemo(
    () => allPrsSorted.filter((pr) => workflowTypeByPrId.get(pr.id) === "stacked"),
    [allPrsSorted, workflowTypeByPrId]
  );
  const normalPrs = React.useMemo(
    () => allPrsSorted.filter((pr) => workflowTypeByPrId.get(pr.id) === "normal"),
    [allPrsSorted, workflowTypeByPrId]
  );

  const chainRoots = React.useMemo(() => lanes.filter((lane) => !lane.parentLaneId), [lanes]);
  const childrenByParent = React.useMemo(() => {
    const map = new Map<string, typeof lanes>();
    for (const lane of lanes) {
      if (!lane.parentLaneId) continue;
      const list = map.get(lane.parentLaneId) ?? [];
      list.push(lane);
      map.set(lane.parentLaneId, list);
    }
    for (const [k, v] of map.entries()) {
      map.set(k, sortByCreatedAtAsc(v));
    }
    return map;
  }, [lanes]);

  const stackedChains = React.useMemo(() => {
    type ChainNode = { item: ChainItem; children: ChainNode[] };

    const stackedPrIds = new Set(stackedPrs.map((pr) => pr.id));

    const buildNode = (laneId: string, depth: number): ChainNode | null => {
      const lane = laneById.get(laneId);
      if (!lane) return null;

      const lanePr = prByLaneId.get(laneId) ?? null;
      const children = (childrenByParent.get(laneId) ?? [])
        .map((child) => buildNode(child.id, depth + 1))
        .filter((child): child is ChainNode => child != null);

      const prMatches = lanePr ? stackedPrIds.has(lanePr.id) : false;
      if (!prMatches && children.length === 0) return null;

      return {
        item: {
          laneId,
          laneName: lane.name,
          depth,
          pr: prMatches ? lanePr : null,
        },
        children,
      };
    };

    const flatten = (node: ChainNode, out: ChainItem[]) => {
      out.push(node.item);
      for (const child of node.children) flatten(child, out);
    };

    const out: Array<{
      rootLaneId: string;
      rootLaneName: string;
      stackRootLaneId: string;
      items: ChainItem[];
    }> = [];

    for (const root of sortByCreatedAtAsc(chainRoots)) {
      const node = buildNode(root.id, 0);
      if (!node) continue;
      const items: ChainItem[] = [];
      flatten(node, items);
      const firstPrItem = items.find((item) => item.pr != null);
      if (!firstPrItem) continue;
      out.push({
        rootLaneId: root.id,
        rootLaneName: root.name,
        stackRootLaneId: firstPrItem.laneId,
        items,
      });
    }

    return out;
  }, [chainRoots, childrenByParent, laneById, prByLaneId, stackedPrs]);

  const prsForActiveTab = React.useMemo(() => {
    if (workflowTab === "integration") return integrationPrs;
    if (workflowTab === "stacked") return stackedPrs;
    return normalPrs;
  }, [integrationPrs, normalPrs, stackedPrs, workflowTab]);

  React.useEffect(() => {
    if (selectedPrId && prsForActiveTab.some((pr) => pr.id === selectedPrId)) return;
    setSelectedPrId(prsForActiveTab[0]?.id ?? null);
  }, [prsForActiveTab, selectedPrId]);

  React.useEffect(() => {
    if (!selectedPr) {
      setResolverTargetLaneId(null);
      setResolverSourceLaneIds([]);
      setResolverWorktree("target");
      setResolverOpen(false);
      return;
    }

    const fallbackTargetLaneId =
      lanes.find((lane) => normalizeBranchName(lane.branchRef) === normalizeBranchName(selectedPr.baseBranch))?.id ?? null;
    const sourceLaneIds =
      selectedMergeContext?.sourceLaneIds && selectedMergeContext.sourceLaneIds.length > 0
        ? selectedMergeContext.sourceLaneIds
        : [selectedPr.laneId];

    setResolverTargetLaneId(selectedMergeContext?.targetLaneId ?? fallbackTargetLaneId);
    setResolverSourceLaneIds(sourceLaneIds);
    setResolverWorktree("target");
    setResolverOpen(false);
  }, [lanes, selectedMergeContext, selectedPr]);

  React.useEffect(() => {
    setActionBusy(false);
    setActionError(null);
    setActionResult(null);
    setDescPreview(null);
    setDescPreviewBusy(false);
    setAutoCommitAfterResolve(false);
    setAutoPushAfterResolve(false);
    setAutoCommitMessage("Resolve integration conflicts");
  }, [selectedPrId]);

  React.useEffect(() => {
    let cancelled = false;

    if (!selectedPr) {
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setDetailBusy(false);
      setDetailError(null);
      return;
    }

    setDetailBusy(true);
    setDetailError(null);

    void Promise.all([
      window.ade.prs.getStatus(selectedPr.id).catch(() => null),
      window.ade.prs.getChecks(selectedPr.id).catch(() => []),
      window.ade.prs.getReviews(selectedPr.id).catch(() => []),
      window.ade.prs.getComments(selectedPr.id).catch(() => []),
    ])
      .then(([status, checks, reviews, comments]) => {
        if (cancelled) return;
        setDetailStatus(status);
        setDetailChecks(checks);
        setDetailReviews(reviews);
        setDetailComments(comments);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailStatus(null);
        setDetailChecks([]);
        setDetailReviews([]);
        setDetailComments([]);
        setDetailError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPr]);

  const runLandStack = async () => {
    if (!landStackDialog) return;
    setLandStackDialog((prev) =>
      prev ? { ...prev, running: true, results: null, error: null } : prev
    );
    try {
      const results = await window.ade.prs.landStack({
        rootLaneId: landStackDialog.rootLaneId,
        method: mergeMethod,
      });
      setLandStackDialog((prev) => (prev ? { ...prev, running: false, results } : prev));
      await Promise.all([refreshLanes().catch(() => {}), refresh().catch(() => {})]);
    } catch (err) {
      setLandStackDialog((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev
      );
    }
  };

  const handleMergePr = async () => {
    if (!selectedPr) return;
    setActionBusy(true);
    setActionError(null);
    setActionResult(null);
    try {
      const res = await window.ade.prs.land({ prId: selectedPr.id, method: mergeMethod });
      setActionResult(res);
      await refresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRefreshPr = async () => {
    if (!selectedPr) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const refreshed = await window.ade.prs.refresh({ prId: selectedPr.id });
      if (refreshed.length > 0) {
        const next = refreshed[0]!;
        setPrs((prev) =>
          prev.map((p) => (p.id === next.id ? { ...next, conflictAnalysis: p.conflictAnalysis } : p))
        );
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handlePushChanges = async () => {
    if (!selectedPr) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await window.ade.git.push({ laneId: selectedPr.laneId });
      await handleRefreshPr();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDraftDescription = async () => {
    if (!selectedPr) return;
    setDescPreviewBusy(true);
    setActionError(null);
    try {
      const drafted = await window.ade.prs.draftDescription(selectedPr.laneId);
      setDescPreview(drafted);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDescPreviewBusy(false);
    }
  };

  const handleConfirmDescription = async () => {
    if (!selectedPr || !descPreview) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await window.ade.prs.updateDescription({ prId: selectedPr.id, body: descPreview.body });
      setDescPreview(null);
      await refresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const mergeSourcesResolved = React.useMemo(() => {
    if (!selectedPr) return [];
    const sourceIds = resolverSourceLaneIds.length > 0 ? resolverSourceLaneIds : [selectedPr.laneId];
    return sourceIds.map((laneId) => ({ laneId, laneName: laneNameFromId(laneById, laneId) }));
  }, [laneById, resolverSourceLaneIds, selectedPr]);

  const mergeTargetResolved = React.useMemo(() => {
    if (!selectedPr || !resolverTargetLaneId) return null;
    return { laneId: resolverTargetLaneId, laneName: laneNameFromId(laneById, resolverTargetLaneId) };
  }, [laneById, resolverTargetLaneId, selectedPr]);

  const mergeTargetOptions = React.useMemo(() => {
    if (!selectedPr) return [];
    const sourceSet = new Set(mergeSourcesResolved.map((entry) => entry.laneId));
    return lanes.filter((lane) => !sourceSet.has(lane.id) || lane.id === resolverTargetLaneId);
  }, [lanes, mergeSourcesResolved, resolverTargetLaneId, selectedPr]);

  const resolverConfigError = React.useMemo(() => {
    if (!resolverTargetLaneId) return "Select a target lane before resolving.";
    if (mergeSourcesResolved.some((source) => source.laneId === resolverTargetLaneId)) {
      return "Target lane cannot also be one of the source lanes.";
    }
    if (mergeSourcesResolved.length === 0) return "Select at least one source lane.";
    return null;
  }, [mergeSourcesResolved, resolverTargetLaneId]);

  React.useEffect(() => {
    if (mergeSourcesResolved.length > 1 && resolverWorktree === "source") {
      setResolverWorktree("target");
    }
  }, [mergeSourcesResolved.length, resolverWorktree]);

  const selectedWorkflowType: WorkflowTab = selectedPr
    ? workflowTypeByPrId.get(selectedPr.id) ?? "normal"
    : workflowTab;

  const checksSummary = React.useMemo(() => {
    let passing = 0;
    let failing = 0;
    let pending = 0;
    for (const check of detailChecks) {
      const rowState = checkRowState(check);
      if (rowState.label === "success") passing += 1;
      else if (rowState.label === "failure") failing += 1;
      else if (rowState.label === "running" || rowState.label === "queued") pending += 1;
    }
    return {
      total: detailChecks.length,
      passing,
      failing,
      pending,
    };
  }, [detailChecks]);

  const renderFlatList = (items: PrWithConflicts[], type: WorkflowTab) => {
    if (!items.length) {
      return (
        <EmptyState
          title={
            type === "integration"
              ? "No integration PRs"
              : type === "stacked"
                ? "No stacked PRs"
                : "No normal PRs"
          }
          description={
            type === "integration"
              ? "Create an integration proposal and PR when lane checks are green."
              : type === "stacked"
                ? "Create a stacked flow to open sequential PRs across lanes."
                : "Create a PR from a lane or link an existing GitHub PR."
          }
        />
      );
    }

    return (
      <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card overflow-hidden">
        <div className="flex flex-col gap-1 p-1.5">
          {items.map((pr) => {
            const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
            const context = mergeContextByPrId[pr.id] ?? null;
            const isSelected = pr.id === selectedPrId;
            const flow = workflowChip(type);
            return (
              <button
                key={pr.id}
                type="button"
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition-all duration-150 border",
                  isSelected
                    ? "border-accent/40 bg-accent/12 shadow-[0_0_14px_-6px_rgba(34,211,238,0.45)]"
                    : "border-transparent hover:bg-card/65 hover:border-border/20"
                )}
                onClick={() => setSelectedPrId(pr.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span>
                    <span className="truncate font-semibold text-fg">{pr.title}</span>
                    <Chip className={flow.className}>{flow.label}</Chip>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-fg/75 truncate">{laneName}</div>
                  {type === "integration" ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-fg/75">
                      <span>sources:</span>
                      <span className="text-fg">{context?.sourceLaneIds.length ?? 0}</span>
                      <span className="text-muted-fg/50">into</span>
                      <span className="text-fg">{laneNameFromId(laneById, context?.targetLaneId ?? pr.laneId)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <PrConflictBadge
                    riskLevel={pr.conflictAnalysis?.riskLevel ?? null}
                    overlappingFileCount={pr.conflictAnalysis?.overlapCount}
                  />
                  <Chip className={cn("text-[11px] px-1.5", checksChip(pr.checksStatus).className)}>
                    {checksChip(pr.checksStatus).label}
                  </Chip>
                  <Chip className={cn("text-[11px] px-1.5", stateChip(pr.state).className)}>
                    {stateChip(pr.state).label}
                  </Chip>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      "pr-list": {
        title: "PR Workflows",
        icon: GitPullRequest,
        meta: (
          <span className="text-xs text-muted-fg">
            {prsForActiveTab.length} in {workflowTab}
          </span>
        ),
        bodyClassName: "overflow-auto",
        children: (
          <div className="p-2 space-y-3">
            {workflowTab === "stacked" ? (
              stackedChains.length ? (
                stackedChains.map((chain) => {
                  const chainPrs = chain.items
                    .map((item) => item.pr)
                    .filter((pr): pr is PrWithConflicts => pr != null);
                  const blockers = chainPrs.flatMap((pr) => {
                    const issues: string[] = [];
                    if (pr.state !== "open") issues.push(`#${pr.githubPrNumber} is ${pr.state}`);
                    if (pr.checksStatus !== "passing") issues.push(`#${pr.githubPrNumber} checks are ${pr.checksStatus}`);
                    if (pr.reviewStatus === "changes_requested") issues.push(`#${pr.githubPrNumber} has requested changes`);
                    if (pr.conflictAnalysis?.conflictPredicted) issues.push(`#${pr.githubPrNumber} has predicted conflicts`);
                    return issues;
                  });
                  const chainReady = chainPrs.length > 0 && blockers.length === 0;

                  return (
                    <div
                      key={chain.rootLaneId}
                      className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-gradient-to-r from-cyan-500/14 via-card/30 to-transparent">
                        <div>
                          <div className="text-xs font-semibold text-fg">{chain.rootLaneName}</div>
                          <div className="text-[11px] text-muted-fg/65">
                            {chainReady ? "ready to land" : `${blockers.length} blockers before landing`}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Chip
                            className={cn(
                              "text-[11px] px-1.5",
                              chainReady
                                ? "text-emerald-200 border-emerald-500/30 bg-emerald-500/10"
                                : "text-amber-200 border-amber-500/30 bg-amber-500/10"
                            )}
                          >
                            {chainReady ? "ready" : "blocked"}
                          </Chip>
                          <Button
                            size="sm"
                            variant="primary"
                            className="text-xs"
                            disabled={!chainReady}
                            title={!chainReady ? blockers.slice(0, 3).join(" • ") : undefined}
                            onClick={() => {
                              setLandStackDialog({
                                rootLaneId: chain.stackRootLaneId,
                                rootLaneName: laneById.get(chain.stackRootLaneId)?.name ?? chain.rootLaneName,
                                running: false,
                                results: null,
                                error: null,
                              });
                            }}
                          >
                            Land stack
                          </Button>
                        </div>
                      </div>
                      <div className="p-1.5 flex flex-col gap-1">
                        {chain.items.map((item) => {
                          const pr = item.pr;
                          const isSelected = pr?.id === selectedPrId;
                          return (
                            <button
                              key={item.laneId}
                              type="button"
                              className={cn(
                                "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs border",
                                pr ? "cursor-pointer" : "cursor-default",
                                isSelected
                                  ? "border-accent/40 bg-accent/12 shadow-[0_0_12px_-5px_rgba(34,211,238,0.45)]"
                                  : "border-transparent hover:border-border/20 hover:bg-card/65"
                              )}
                              onClick={() => {
                                if (pr) setSelectedPrId(pr.id);
                              }}
                            >
                              <div className="min-w-0 flex items-center">
                                {item.depth > 0 ? (
                                  <span className="flex items-center shrink-0" style={{ width: item.depth * 16 }}>
                                    {Array.from({ length: item.depth }).map((_, i) => (
                                      <span key={i} className="inline-block w-4 text-center text-border/60">
                                        {i === item.depth - 1 ? "\u2514" : "\u2502"}
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-fg truncate">{item.laneName}</span>
                                    {pr ? (
                                      <>
                                        <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span>
                                        <Chip className={cn("text-[11px] px-1.5", checksChip(pr.checksStatus).className)}>
                                          {checksChip(pr.checksStatus).label}
                                        </Chip>
                                      </>
                                    ) : (
                                      <span className="text-[11px] italic text-muted-fg/60">no PR</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              {pr ? (
                                <div className="flex items-center gap-1.5">
                                  <PrConflictBadge
                                    riskLevel={pr.conflictAnalysis?.riskLevel ?? null}
                                    overlappingFileCount={pr.conflictAnalysis?.overlapCount}
                                  />
                                  <Chip className={cn("text-[11px] px-1.5", stateChip(pr.state).className)}>
                                    {stateChip(pr.state).label}
                                  </Chip>
                                </div>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              ) : (
                <EmptyState
                  title="No stacked PR chains"
                  description="Create stacked PRs to see chain compatibility and landing order."
                />
              )
            ) : workflowTab === "integration" ? (
              renderFlatList(integrationPrs, "integration")
            ) : (
              renderFlatList(normalPrs, "normal")
            )}
          </div>
        ),
      },
      "pr-detail": {
        title: selectedPr ? `#${selectedPr.githubPrNumber} ${selectedPr.title}` : "PR Detail",
        icon: Eye,
        bodyClassName: "overflow-auto",
        children: selectedPr ? (
          <div className="p-4 space-y-4">
            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg text-muted-fg/70">#{selectedPr.githubPrNumber}</span>
                    <span className="text-lg font-bold text-fg truncate">{selectedPr.title}</span>
                    <Chip className={workflowChip(selectedWorkflowType).className}>
                      {workflowChip(selectedWorkflowType).label}
                    </Chip>
                  </div>
                  <div className="mt-1 text-xs text-muted-fg/70 font-mono">
                    {selectedPr.repoOwner}/{selectedPr.repoName}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Chip className={cn("text-xs px-2", stateChip(selectedPr.state).className)}>
                    {stateChip(selectedPr.state).label}
                  </Chip>
                  <Chip className={cn("text-xs px-2", checksChip(selectedPr.checksStatus).className)}>
                    {checksChip(selectedPr.checksStatus).label}
                  </Chip>
                  <Chip className={cn("text-xs px-2", reviewsChip(selectedPr.reviewStatus).className)}>
                    {reviewsChip(selectedPr.reviewStatus).label}
                  </Chip>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
              <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">PR Metadata</div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Base</div>
                  <div className="font-mono text-fg">{selectedPr.baseBranch}</div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Head</div>
                  <div className="font-mono text-fg">{selectedPr.headBranch}</div>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-4">
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Additions</div>
                  <div className="font-mono text-emerald-300">+{selectedPr.additions}</div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Deletions</div>
                  <div className="font-mono text-red-300">-{selectedPr.deletions}</div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Created</div>
                  <div className="text-fg tabular-nums">{formatTimestamp(selectedPr.createdAt)}</div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 p-2 text-xs">
                  <div className="text-muted-fg/70">Updated</div>
                  <div className="text-fg tabular-nums">{formatTimestamp(selectedPr.updatedAt)}</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
              <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Workflow Overview</div>

              {selectedWorkflowType === "integration" ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-2 text-xs text-violet-100">
                    Integration proposal flow: validate all source lanes, resolve conflicts, then create/merge one integration PR.
                  </div>
                  <div className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs space-y-1.5">
                    <div className="text-muted-fg/80">Source lanes into target</div>
                    <div className="flex flex-wrap items-center gap-1">
                      {mergeSourcesResolved.map((source) => (
                        <Chip key={source.laneId} className="text-[11px]">
                          {source.laneName}
                        </Chip>
                      ))}
                      <span className="text-muted-fg/60">into</span>
                      <Chip className="text-[11px] border-accent/30 bg-accent/10 text-accent">
                        {mergeTargetResolved?.laneName ?? "unknown target"}
                      </Chip>
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    {mergeSourcesResolved.map((source) => {
                      const sourcePr = prByLaneId.get(source.laneId) ?? null;
                      return (
                        <div
                          key={`integration-source:${source.laneId}`}
                          className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs flex items-center justify-between gap-2"
                        >
                          <span className="text-fg truncate">{source.laneName}</span>
                          {sourcePr ? (
                            <div className="flex items-center gap-1">
                              <Chip className={cn("text-[11px] px-1.5", checksChip(sourcePr.checksStatus).className)}>
                                {checksChip(sourcePr.checksStatus).label}
                              </Chip>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[11px]"
                                onClick={() => {
                                  const sourceType = workflowTypeByPrId.get(sourcePr.id) ?? "normal";
                                  setWorkflowTab(sourceType);
                                  setSelectedPrId(sourcePr.id);
                                }}
                              >
                                Open PR
                              </Button>
                            </div>
                          ) : (
                            <span className="text-muted-fg/70 italic">no linked source PR</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {selectedWorkflowType === "stacked" ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-2 text-xs text-cyan-100">
                    Stacked flow: each PR should stay mergeable in sequence so the chain can land quickly.
                  </div>
                  {selectedMergeContext?.members?.length ? (
                    <div className="grid gap-1.5">
                      {selectedMergeContext.members
                        .filter((member) => member.role === "source")
                        .sort((a, b) => a.position - b.position)
                        .map((member, idx) => {
                          const memberPr = member.prId ? prById.get(member.prId) ?? null : null;
                          return (
                            <div
                              key={`${member.laneId}:${member.position}`}
                              className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-fg truncate">{idx + 1}. {member.laneName}</div>
                                {memberPr ? (
                                  <div className="text-muted-fg/75 font-mono">#{memberPr.githubPrNumber}</div>
                                ) : null}
                              </div>
                              {memberPr ? (
                                <Chip className={cn("text-[11px] px-1.5", checksChip(memberPr.checksStatus).className)}>
                                  {checksChip(memberPr.checksStatus).label}
                                </Chip>
                              ) : (
                                <span className="text-muted-fg/70 italic">no PR</span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-fg">Stack metadata is not available yet for this PR.</div>
                  )}
                </div>
              ) : null}

              {selectedWorkflowType === "normal" ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-slate-500/30 bg-slate-500/10 px-2.5 py-2 text-xs text-slate-100">
                    Normal flow: one lane PR directly into its base branch.
                  </div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-fg/70">Base</span>
                    <span className="font-mono text-fg">{selectedPr.baseBranch}</span>
                    <span className="text-muted-fg/70">Head</span>
                    <span className="font-mono text-fg">{selectedPr.headBranch}</span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">GitHub Signals</div>
                <div className="text-xs text-muted-fg/70">
                  checks {checksSummary.passing}/{checksSummary.total} passing
                </div>
              </div>

              {detailBusy ? <div className="text-xs text-muted-fg">Loading checks, reviews, and comments...</div> : null}
              {detailError ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Failed to load full PR activity: {detailError}
                </div>
              ) : null}

              <div className="grid gap-2 md:grid-cols-3">
                <div className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs">
                  <div className="text-muted-fg/70">Mergeable</div>
                  <div className={cn("font-semibold", detailStatus?.isMergeable ? "text-emerald-300" : "text-red-300")}>
                    {detailStatus ? (detailStatus.isMergeable ? "yes" : "no") : "unknown"}
                  </div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs">
                  <div className="text-muted-fg/70">GitHub conflicts (this PR)</div>
                  <div className={cn("font-semibold", detailStatus?.mergeConflicts ? "text-red-300" : "text-emerald-300")}>
                    {detailStatus ? (detailStatus.mergeConflicts ? "yes" : "no") : "unknown"}
                  </div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/25 px-2.5 py-2 text-xs">
                  <div className="text-muted-fg/70">Behind base</div>
                  <div className={cn("font-semibold", (detailStatus?.behindBaseBy ?? 0) > 0 ? "text-amber-300" : "text-fg")}>
                    {detailStatus?.behindBaseBy ?? 0}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-border/20 bg-card/25 p-2.5 space-y-1.5">
                  <div className="text-[11px] font-medium tracking-wider uppercase text-muted-fg">Checks & Actions</div>
                  <div className="max-h-48 overflow-auto space-y-1">
                    {detailChecks.map((check) => {
                      const state = checkRowState(check);
                      return (
                        <div
                          key={`${check.name}:${check.startedAt ?? "none"}`}
                          className="rounded border border-border/20 bg-card/20 px-2 py-1.5 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-fg truncate">{check.name}</div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className={state.className}>{state.label}</span>
                              {check.detailsUrl ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => void window.ade.app.openExternal(check.detailsUrl!)}
                                >
                                  Open
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {!detailChecks.length ? <div className="text-xs text-muted-fg">No checks found.</div> : null}
                  </div>
                </div>

                <div className="rounded-lg border border-border/20 bg-card/25 p-2.5 space-y-1.5">
                  <div className="text-[11px] font-medium tracking-wider uppercase text-muted-fg">Reviews</div>
                  <div className="max-h-48 overflow-auto space-y-1">
                    {detailReviews.map((review, idx) => (
                      <div
                        key={`${review.reviewer}:${review.submittedAt ?? idx}`}
                        className="rounded border border-border/20 bg-card/20 px-2 py-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-fg font-medium truncate">{review.reviewer}</span>
                          <span className={cn(
                            "text-[11px]",
                            review.state === "approved" && "text-emerald-300",
                            review.state === "changes_requested" && "text-amber-300",
                            review.state !== "approved" && review.state !== "changes_requested" && "text-muted-fg"
                          )}>
                            {review.state}
                          </span>
                        </div>
                        {review.body ? (
                          <div className="mt-1 line-clamp-2 text-muted-fg/80">{review.body}</div>
                        ) : null}
                      </div>
                    ))}
                    {!detailReviews.length ? <div className="text-xs text-muted-fg">No reviews yet.</div> : null}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border/20 bg-card/25 p-2.5 space-y-1.5">
                <div className="text-[11px] font-medium tracking-wider uppercase text-muted-fg">Comments</div>
                <div className="max-h-48 overflow-auto space-y-1">
                  {detailComments.map((comment) => (
                    <div
                      key={comment.id}
                      className="rounded border border-border/20 bg-card/20 px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-1.5">
                          <span className="text-fg font-medium truncate">{comment.author}</span>
                          <Chip
                            className={cn(
                              "text-[10px] px-1.5",
                              comment.source === "review"
                                ? "text-cyan-200 border-cyan-500/30 bg-cyan-500/12"
                                : "text-slate-200 border-slate-500/30 bg-slate-500/12"
                            )}
                          >
                            {comment.source}
                          </Chip>
                          {comment.path ? (
                            <span className="text-[10px] text-muted-fg/70 truncate">
                              {comment.path}{comment.line ? `:${comment.line}` : ""}
                            </span>
                          ) : null}
                        </div>
                        {comment.url ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => void window.ade.app.openExternal(comment.url!)}
                          >
                            Open
                          </Button>
                        ) : null}
                      </div>
                      {comment.body ? <div className="mt-1 line-clamp-3 text-muted-fg/80">{comment.body}</div> : null}
                    </div>
                  ))}
                  {!detailComments.length ? <div className="text-xs text-muted-fg">No comments yet.</div> : null}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Conflict Resolution</div>
                {selectedPr.conflictAnalysis ? (
                  <PrConflictBadge
                    riskLevel={selectedPr.conflictAnalysis.riskLevel}
                    overlappingFileCount={selectedPr.conflictAnalysis.overlapCount}
                  />
                ) : null}
              </div>

              <div className="rounded border border-border/20 bg-card/25 px-2.5 py-2 text-xs text-muted-fg">
                This risk badge is ADE's predicted overlap/conflict risk across selected lanes. It is separate from GitHub's
                mergeability for the current PR head/base.
              </div>

              {!selectedMergeContext && mergeContextLookupBusy ? (
                <div className="text-xs text-muted-fg">Resolving merge context...</div>
              ) : null}

              <div className="rounded-lg border border-border/20 bg-card/25 p-2.5 text-xs space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-fg/80">Sources</span>
                  {mergeSourcesResolved.map((source) => (
                    <Chip key={source.laneId} className="text-[11px]">
                      {source.laneName}
                    </Chip>
                  ))}
                  <span className="text-muted-fg/60">into</span>
                  <Chip className="text-[11px] border-accent/30 bg-accent/10 text-accent">
                    {mergeTargetResolved?.laneName ?? "unknown target"}
                  </Chip>
                  {selectedMergeContext?.groupType === "integration" ? (
                    <Chip className="text-[11px] text-violet-200 border-violet-500/30 bg-violet-500/12">
                      integration flow
                    </Chip>
                  ) : null}
                  {selectedMergeContext?.groupType === "stacked" ? (
                    <Chip className="text-[11px] text-cyan-200 border-cyan-500/30 bg-cyan-500/12">
                      stacked flow
                    </Chip>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-xs text-muted-fg">
                  Target lane
                  <select
                    value={resolverTargetLaneId ?? ""}
                    onChange={(event) => setResolverTargetLaneId(event.target.value || null)}
                    className="mt-1 h-8 w-full rounded border border-border/20 bg-surface-recessed px-2 text-xs text-fg"
                  >
                    {!resolverTargetLaneId ? <option value="">Select lane...</option> : null}
                    {mergeTargetOptions.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs text-muted-fg">
                  Resolve in worktree
                  <select
                    value={resolverWorktree}
                    onChange={(event) => setResolverWorktree(event.target.value as "target" | "source")}
                    className="mt-1 h-8 w-full rounded border border-border/20 bg-surface-recessed px-2 text-xs text-fg"
                    disabled={mergeSourcesResolved.length > 1}
                  >
                    <option value="target">target lane</option>
                    <option value="source">source lane</option>
                  </select>
                </label>
              </div>

              {selectedMergeContext?.groupType === "integration" && selectedMergeContext.sourceLaneIds.length > 1 ? (
                <div className="rounded border border-border/20 bg-card/25 p-2 text-xs space-y-1.5">
                  <div className="font-medium text-fg">Integration sources</div>
                  <div className="grid gap-1">
                    {selectedMergeContext.sourceLaneIds.map((laneId) => {
                      const checked = resolverSourceLaneIds.includes(laneId);
                      return (
                        <label key={laneId} className="flex items-center gap-2 text-muted-fg">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setResolverSourceLaneIds((prev) =>
                                checked ? (prev.length <= 1 ? prev : prev.filter((id) => id !== laneId)) : [...prev, laneId]
                              );
                            }}
                          />
                          <span className="text-fg">{laneNameFromId(laneById, laneId)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="rounded border border-border/20 bg-card/25 p-2 text-xs space-y-1.5">
                <label className="flex items-center gap-2 text-muted-fg">
                  <input
                    type="checkbox"
                    checked={autoCommitAfterResolve}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setAutoCommitAfterResolve(checked);
                      if (!checked) setAutoPushAfterResolve(false);
                    }}
                  />
                  Auto-commit after AI resolution
                </label>
                {autoCommitAfterResolve ? (
                  <>
                    <label className="block text-muted-fg">
                      Commit message
                      <input
                        type="text"
                        value={autoCommitMessage}
                        onChange={(event) => setAutoCommitMessage(event.target.value)}
                        className="mt-1 h-8 w-full rounded border border-border/20 bg-surface-recessed px-2 text-xs text-fg"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-muted-fg">
                      <input
                        type="checkbox"
                        checked={autoPushAfterResolve}
                        onChange={(event) => setAutoPushAfterResolve(event.target.checked)}
                      />
                      Auto-push after commit
                    </label>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={Boolean(resolverConfigError)}
                  onClick={() => setResolverOpen(true)}
                >
                  <Sparkle size={14} weight="regular" className="mr-1.5" />
                  Resolve with AI
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-accent border-accent/20 hover:bg-accent/10"
                  onClick={() => {
                    const sourceIds = mergeSourcesResolved.map((entry) => entry.laneId);
                    if (sourceIds.length > 1) {
                      const params = new URLSearchParams();
                      params.set("tab", "merge-multiple");
                      params.set("sourceLaneIds", sourceIds.join(","));
                      if (resolverTargetLaneId) params.set("targetLaneId", resolverTargetLaneId);
                      params.set("mode", selectedMergeContext?.groupType === "integration" ? "integration" : "stacked");
                      navigate(`/conflicts?${params.toString()}`);
                      return;
                    }
                    const params = new URLSearchParams();
                    params.set("tab", "merge-one");
                    params.set("sourceLaneId", sourceIds[0] ?? selectedPr.laneId);
                    if (resolverTargetLaneId) params.set("targetLaneId", resolverTargetLaneId);
                    navigate(`/conflicts?${params.toString()}`);
                  }}
                >
                  Resolve in Conflicts tab
                  <ArrowRight size={14} weight="regular" className="ml-1.5" />
                </Button>
              </div>

              {resolverConfigError ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                  {resolverConfigError}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-3">
              <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Actions</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}>
                  Open on GitHub
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedPr.laneId)}`)}
                >
                  View lane
                </Button>
                <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void handleRefreshPr()}>
                  {actionBusy ? "Syncing..." : "Sync"}
                </Button>
                <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void handlePushChanges()}>
                  Push
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionBusy || descPreviewBusy}
                  onClick={() => void handleDraftDescription()}
                >
                  {descPreviewBusy ? "Drafting..." : "Update Description"}
                </Button>
              </div>

              {(selectedPr.state === "open" || selectedPr.state === "draft") ? (
                <div className="flex items-center gap-2 pt-1 border-t border-border/20">
                  <select
                    value={mergeMethod}
                    onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
                    className="h-7 rounded border border-border/20 bg-surface-recessed px-2 text-xs text-fg"
                    title="Merge method"
                  >
                    <option value="squash">squash</option>
                    <option value="merge">merge</option>
                    <option value="rebase">rebase</option>
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={actionBusy || selectedPr.state !== "open"}
                    onClick={() => void handleMergePr()}
                  >
                    {actionBusy ? "Merging..." : "Merge PR"}
                  </Button>
                </div>
              ) : null}

              <div className="flex items-center gap-2 pt-1 border-t border-border/20">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-300 border-red-500/30 hover:bg-red-500/10"
                  disabled={actionBusy}
                  onClick={async () => {
                    const laneName = laneById.get(selectedPr.laneId)?.name ?? selectedPr.laneId;
                    if (!confirm(`Archive lane "${laneName}"? This will remove it from active lanes.`)) return;
                    setActionBusy(true);
                    setActionError(null);
                    try {
                      await window.ade.lanes.archive({ laneId: selectedPr.laneId });
                      await Promise.all([refreshLanes(), refresh()]);
                    } catch (err: unknown) {
                      setActionError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setActionBusy(false);
                    }
                  }}
                >
                  Archive Lane
                </Button>
              </div>
            </div>

            {actionError ? (
              <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {actionError}
              </div>
            ) : null}

            {actionResult ? (
              <div
                className={cn(
                  "rounded border px-3 py-2 text-xs",
                  actionResult.success
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : "border-red-500/40 bg-red-500/10 text-red-200"
                )}
              >
                {actionResult.success
                  ? `Merged PR #${actionResult.prNumber}`
                  : `Merge failed: ${actionResult.error ?? "unknown error"}`}
              </div>
            ) : null}

            {descPreview ? (
              <div className="rounded-lg border border-accent/30 bg-accent/8 p-3 space-y-2">
                <div className="text-xs font-semibold text-fg">Description Preview</div>
                <div className="text-xs text-muted-fg">
                  Title: <span className="font-medium text-fg">{descPreview.title}</span>
                </div>
                <textarea
                  value={descPreview.body}
                  onChange={(e) =>
                    setDescPreview((prev) => (prev ? { ...prev, body: e.target.value } : null))
                  }
                  className="w-full h-[200px] resize-none rounded border border-border/20 bg-surface-recessed p-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" onClick={() => setDescPreview(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={actionBusy}
                    onClick={() => void handleConfirmDescription()}
                  >
                    {actionBusy ? "Updating..." : "Confirm & Update"}
                  </Button>
                </div>
              </div>
            ) : null}

            <ResolverTerminalModal
              open={resolverOpen}
              onOpenChange={setResolverOpen}
              sourceLaneId={mergeSourcesResolved[0]?.laneId ?? selectedPr.laneId}
              sourceLaneIds={
                mergeSourcesResolved.length > 1
                  ? mergeSourcesResolved.map((entry) => entry.laneId)
                  : undefined
              }
              targetLaneId={resolverTargetLaneId}
              cwdLaneId={
                resolverWorktree === "source"
                  ? (mergeSourcesResolved[0]?.laneId ?? null)
                  : resolverTargetLaneId
              }
              scenario={
                mergeSourcesResolved.length > 1
                  ? selectedMergeContext?.groupType === "integration"
                    ? "integration-merge"
                    : "sequential-merge"
                  : "single-merge"
              }
              postResolutionDefaults={{
                autoCommit: autoCommitAfterResolve,
                autoPush: autoPushAfterResolve,
                commitMessage: autoCommitMessage,
              }}
              onCompleted={() => {
                void handleRefreshPr();
              }}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState title="No PR selected" description="Select a PR to inspect checks, comments, and merge workflow." />
          </div>
        ),
      },
    }),
    [
      actionBusy,
      actionError,
      actionResult,
      autoCommitAfterResolve,
      autoCommitMessage,
      autoPushAfterResolve,
      checksSummary.failing,
      checksSummary.passing,
      checksSummary.total,
      descPreview,
      descPreviewBusy,
      detailBusy,
      detailChecks,
      detailComments,
      detailError,
      detailReviews,
      detailStatus,
      handleConfirmDescription,
      integrationPrs,
      laneById,
      lanes,
      mergeContextLookupBusy,
      mergeMethod,
      mergeSourcesResolved,
      mergeTargetOptions,
      mergeTargetResolved,
      normalPrs,
      navigate,
      prById,
      prByLaneId,
      prsForActiveTab.length,
      refresh,
      refreshLanes,
      resolverConfigError,
      resolverOpen,
      resolverSourceLaneIds,
      resolverTargetLaneId,
      resolverWorktree,
      selectedMergeContext,
      selectedPr,
      selectedPrId,
      selectedWorkflowType,
      stackedChains,
      workflowTab,
      workflowTypeByPrId,
      mergeContextByPrId,
    ]
  );

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex items-center gap-4 px-4 py-2.5 bg-card/20 backdrop-blur-sm border-b border-border/10">
        <div className="flex items-center gap-2.5">
          <div className="text-sm font-bold text-fg tracking-tight">PRs</div>
          <span className="text-xs text-muted-fg/65 tabular-nums">{prs.length} linked</span>
        </div>

        <div className="flex items-center rounded-lg bg-card/80 p-0.5 gap-0.5 border border-border/20">
          {([
            { id: "integration", label: "Integration", count: integrationPrs.length, icon: GitMerge },
            { id: "stacked", label: "Stacked", count: stackedPrs.length, icon: ArrowRight },
            { id: "normal", label: "Normal", count: normalPrs.length, icon: GitPullRequest },
          ] as const).map((tab) => {
            const isActive = workflowTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  "px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 flex items-center gap-1.5",
                  isActive
                    ? "bg-accent text-accent-fg shadow-sm"
                    : "text-muted-fg hover:text-fg hover:bg-muted/40"
                )}
                onClick={() => setWorkflowTab(tab.id)}
              >
                <Icon size={12} weight="regular" />
                <span>{tab.label}</span>
                <span className={cn("tabular-nums", isActive ? "text-accent-fg/90" : "text-muted-fg/75")}>{tab.count}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
            className="h-8 rounded-lg border border-border/20 bg-surface-recessed px-2 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent/30"
            title="Default merge method"
          >
            <option value="squash">squash</option>
            <option value="merge">merge</option>
            <option value="rebase">rebase</option>
          </select>
          <Button size="sm" variant="primary" onClick={() => setCreatePrOpen(true)}>
            <Plus size={14} weight="regular" className="mr-1" />
            Create PR
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/settings")}>
            GitHub Settings
          </Button>
        </div>
      </div>

      {landStackDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-[min(720px,100%)] rounded bg-card border border-border/40 p-4 shadow-float ring-1 ring-border/20">
            <div className="flex items-center justify-between gap-2">
              <div className="text-base font-bold text-fg tracking-tight">Land Stack</div>
              <Button size="sm" variant="ghost" onClick={() => setLandStackDialog(null)}>
                Close
              </Button>
            </div>
            <div className="mt-1.5 text-xs text-muted-fg/70">
              Root: <span className="font-semibold text-fg">{landStackDialog.rootLaneName}</span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2 rounded bg-card/60 px-3 py-2.5">
              <div className="text-xs text-muted-fg">
                Merge method: <span className="font-mono font-medium text-fg">{mergeMethod}</span>
              </div>
              <Button
                size="sm"
                variant="primary"
                className="shadow-card font-semibold"
                disabled={landStackDialog.running}
                onClick={() => void runLandStack()}
              >
                {landStackDialog.running ? "Landing..." : "Land Stack"}
              </Button>
            </div>
            {landStackDialog.error ? (
              <div className="mt-4 rounded bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-200">
                {landStackDialog.error}
              </div>
            ) : null}
            {landStackDialog.results ? (
              <div className="mt-4 max-h-[50vh] overflow-auto rounded bg-muted/15 ring-1 ring-border/10">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-fg/60 font-semibold">
                  Results
                </div>
                <div className="space-y-1 px-1">
                  {landStackDialog.results.map((r, idx) => (
                    <div key={`${r.prNumber}:${idx}`} className="px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-sm", r.success ? "text-emerald-300" : "text-red-300")}>{r.success ? "\u2713" : "\u2717"}</span>
                          <span className="font-mono font-semibold text-fg">#{r.prNumber}</span>
                        </div>
                        <Chip
                          className={cn(
                            "text-[11px] px-2 rounded-md font-medium",
                            r.success
                              ? "text-emerald-200 border-l-2 border-l-emerald-400 bg-emerald-900/20"
                              : "text-red-200 border-l-2 border-l-red-400 bg-red-900/20"
                          )}
                        >
                          {r.success ? "merged" : "failed"}
                        </Chip>
                      </div>
                      {r.error ? <div className="mt-1.5 text-xs text-red-300/80 pl-6">{r.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <CreatePrModal open={createPrOpen} onOpenChange={setCreatePrOpen} onCreated={() => void refresh()} />

      <PaneTilingLayout layoutId="prs:tiling:v2" tree={PRS_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />
    </div>
  );
}
