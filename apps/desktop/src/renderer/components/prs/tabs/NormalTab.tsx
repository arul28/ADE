import React from "react";
import { ArrowRight, Eye, Sparkle, Trash } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  DeletePrResult,
  LandResult,
  MergeMethod,
  PrCheck,
  PrComment,
  PrMergeContext,
  PrReview,
  PrStatus,
  PrSummary,
  PrWithConflicts,
  LaneSummary,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { PrConflictBadge } from "../PrConflictBadge";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";
import { usePrs } from "../state/PrsContext";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

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

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

type NormalTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function NormalTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: NormalTabProps) {
  const navigate = useNavigate();
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const { detailStatus, detailChecks, detailReviews, detailComments, detailBusy } = usePrs();

  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionResult, setActionResult] = React.useState<LandResult | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);

  // Auto-select first PR (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

  React.useEffect(() => { setActionBusy(false); setActionError(null); setActionResult(null); setDeleteConfirm(false); }, [selectedPrId]);

  const resolverTargetLaneId = React.useMemo(() => {
    if (!selectedPr) return null;
    return lanes.find((l) => normalizeBranchName(l.branchRef) === normalizeBranchName(selectedPr.baseBranch))?.id ?? null;
  }, [lanes, selectedPr]);

  const handleMerge = async () => {
    if (!selectedPr) return;
    setActionBusy(true); setActionError(null); setActionResult(null);
    try {
      const res = await window.ade.prs.land({ prId: selectedPr.id, method: mergeMethod });
      setActionResult(res);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleDelete = async () => {
    if (!selectedPr) return;
    setDeleteBusy(true); setActionError(null);
    try {
      await window.ade.prs.delete({ prId: selectedPr.id, closeOnGitHub: deleteCloseGh });
      setDeleteConfirm(false);
      onSelectPr(null);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Normal PRs",
      bodyClassName: "overflow-auto",
      children: (
        <div className="p-2 space-y-1">
          {!prs.length ? (
            <EmptyState title="No normal PRs" description="Create a PR from a lane or link an existing GitHub PR." />
          ) : (
            <div className="flex flex-col gap-0.5">
              {prs.map((pr) => {
                const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
                const isSelected = pr.id === selectedPrId;
                return (
                  <button
                    key={pr.id}
                    type="button"
                    className={cn(
                      "flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition-colors duration-100",
                      isSelected
                        ? "border-l-2 border-l-accent bg-accent/8"
                        : "border-l-2 border-l-transparent hover:bg-card/40"
                    )}
                    onClick={() => onSelectPr(pr.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span>
                        <span className="truncate font-semibold text-fg">{pr.title}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-fg/75 truncate">{laneName}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
                      <Chip className={cn("text-[11px] px-1.5", checksChip(pr.checksStatus).className)}>{checksChip(pr.checksStatus).label}</Chip>
                      <Chip className={cn("text-[11px] px-1.5", stateChip(pr.state).className)}>{stateChip(pr.state).label}</Chip>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    detail: {
      title: selectedPr ? `#${selectedPr.githubPrNumber} ${selectedPr.title}` : "PR Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: selectedPr ? (
        <div className="p-4 space-y-5">
          {/* Header */}
          <div className="rounded-lg bg-card/30 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-lg text-muted-fg/70">#{selectedPr.githubPrNumber}</span>
                  <span className="text-lg font-bold text-fg truncate">{selectedPr.title}</span>
                </div>
                <div className="mt-1 text-xs text-muted-fg/70 font-mono">{selectedPr.repoOwner}/{selectedPr.repoName}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <Chip className={cn("text-xs px-2", stateChip(selectedPr.state).className)}>{stateChip(selectedPr.state).label}</Chip>
                <Chip className={cn("text-xs px-2", checksChip(selectedPr.checksStatus).className)}>{checksChip(selectedPr.checksStatus).label}</Chip>
                <Chip className={cn("text-xs px-2", reviewsChip(selectedPr.reviewStatus).className)}>{reviewsChip(selectedPr.reviewStatus).label}</Chip>
              </div>
            </div>
          </div>

          {/* Metadata */}
          <div className="rounded-lg bg-card/30 p-4 space-y-3">
            <div className="text-xs font-medium text-muted-fg/80">PR Metadata</div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Base</div>
                <div className="font-mono text-fg">{selectedPr.baseBranch}</div>
              </div>
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Head</div>
                <div className="font-mono text-fg">{selectedPr.headBranch}</div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Additions</div>
                <div className="font-mono text-emerald-300">+{selectedPr.additions}</div>
              </div>
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Deletions</div>
                <div className="font-mono text-red-300">-{selectedPr.deletions}</div>
              </div>
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Created</div>
                <div className="text-fg tabular-nums">{formatTimestamp(selectedPr.createdAt)}</div>
              </div>
              <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                <div className="text-muted-fg/70">Updated</div>
                <div className="text-fg tabular-nums">{formatTimestamp(selectedPr.updatedAt)}</div>
              </div>
            </div>
          </div>

          {/* GitHub Signals - horizontal row */}
          <div className="rounded-lg bg-card/30 p-4 space-y-3">
            <div className="text-xs font-medium text-muted-fg/80">GitHub Signals</div>
            {detailBusy ? <div className="text-xs text-muted-fg">Loading...</div> : null}
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/70">Mergeable</span>
                <span className={cn("font-semibold", detailStatus?.isMergeable ? "text-emerald-300" : "text-red-300")}>
                  {detailStatus ? (detailStatus.isMergeable ? "yes" : "no") : "unknown"}
                </span>
              </div>
              <span className="text-border/40">|</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/70">Conflicts</span>
                <span className={cn("font-semibold", detailStatus?.mergeConflicts ? "text-red-300" : "text-emerald-300")}>
                  {detailStatus ? (detailStatus.mergeConflicts ? "yes" : "no") : "unknown"}
                </span>
              </div>
              <span className="text-border/40">|</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/70">Behind base</span>
                <span className={cn("font-semibold", (detailStatus?.behindBaseBy ?? 0) > 0 ? "text-amber-300" : "text-fg")}>
                  {detailStatus?.behindBaseBy ?? 0}
                </span>
              </div>
            </div>
          </div>

          {/* Actions - clean button row */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}>Open on GitHub</Button>
              <Button size="sm" variant="outline" onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedPr.laneId)}`)}>View lane</Button>
              <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => setResolverOpen(true)}>
                <Sparkle size={14} weight="regular" className="mr-1.5" />Resolve with AI
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(true)} className="text-red-300 hover:text-red-200 hover:border-red-500/40">
                <Trash size={14} weight="regular" className="mr-1.5" />Remove PR
              </Button>
            </div>
            {deleteConfirm ? (
              <div className="bg-red-500/5 rounded-lg p-3 space-y-2.5">
                <div className="text-xs font-medium text-red-200">Remove this PR from ADE?</div>
                <label className="flex items-center gap-1.5 text-xs text-muted-fg cursor-pointer">
                  <input type="checkbox" checked={deleteCloseGh} onChange={(e) => setDeleteCloseGh(e.target.checked)} className="rounded" />
                  Also close on GitHub
                </label>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={deleteBusy} onClick={() => void handleDelete()} className="text-red-300 border-red-500/40 hover:bg-red-500/15">
                    {deleteBusy ? "Removing..." : "Confirm Remove"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
                </div>
              </div>
            ) : null}
            {(selectedPr.state === "open" || selectedPr.state === "draft") ? (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="primary" disabled={actionBusy || selectedPr.state !== "open"} onClick={() => void handleMerge()}>
                  {actionBusy ? "Merging..." : "Merge PR"}
                </Button>
              </div>
            ) : null}
            {actionError ? <div className="bg-red-500/5 rounded-lg px-3 py-2 text-xs text-red-200">{actionError}</div> : null}
            {actionResult ? (
              <div className={cn("rounded-lg px-3 py-2 text-xs", actionResult.success ? "bg-emerald-500/8 text-emerald-200" : "bg-red-500/5 text-red-200")}>
                {actionResult.success ? `Merged PR #${actionResult.prNumber}` : `Failed: ${actionResult.error ?? "unknown"}`}
              </div>
            ) : null}
          </div>

          <ResolverTerminalModal
            open={resolverOpen}
            onOpenChange={setResolverOpen}
            sourceLaneId={selectedPr.laneId}
            targetLaneId={resolverTargetLaneId}
            cwdLaneId={resolverTargetLaneId}
            scenario="single-merge"
            onCompleted={() => void onRefresh()}
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No PR selected" description="Select a PR to inspect checks, comments, and merge workflow." />
        </div>
      ),
    },
  }), [prs, selectedPr, selectedPrId, laneById, detailStatus, detailBusy, detailChecks, detailReviews, detailComments, actionBusy, actionError, actionResult, resolverOpen, resolverTargetLaneId, mergeMethod, deleteConfirm, deleteBusy, deleteCloseGh, navigate, onSelectPr, onRefresh]);

  return <PaneTilingLayout layoutId="prs:normal:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
