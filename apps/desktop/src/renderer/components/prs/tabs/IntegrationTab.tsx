import React from "react";
import { GitMerge, Lightning, Eye, Sparkle, Trash } from "@phosphor-icons/react";
import type {
  CreateIntegrationPrResult,
  IntegrationProposal,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { PrConflictBadge } from "../PrConflictBadge";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

type IntegrationTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function IntegrationTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: IntegrationTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [simulateResult, setSimulateResult] = React.useState<IntegrationProposal | null>(null);
  const [simulateBusy, setSimulateBusy] = React.useState(false);
  const [simulateError, setSimulateError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);
  const selectedMergeContext = selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null;

  // Auto-select first (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

  const mergeSourcesResolved = React.useMemo(() => {
    if (!selectedPr) return [];
    const sourceIds = selectedMergeContext?.sourceLaneIds ?? [selectedPr.laneId];
    return sourceIds.map((id) => ({ laneId: id, laneName: laneById.get(id)?.name ?? id }));
  }, [selectedPr, selectedMergeContext, laneById]);

  const resolverTargetLaneId = React.useMemo(() => {
    if (selectedMergeContext?.targetLaneId) return selectedMergeContext.targetLaneId;
    if (!selectedPr) return null;
    return lanes.find((l) => normalizeBranchName(l.branchRef) === normalizeBranchName(selectedPr.baseBranch))?.id ?? null;
  }, [lanes, selectedPr, selectedMergeContext]);

  const handleSimulate = async () => {
    if (!selectedPr) return;
    const sourceIds = selectedMergeContext?.sourceLaneIds ?? [selectedPr.laneId];
    setSimulateBusy(true); setSimulateError(null); setSimulateResult(null);
    try {
      const result = await window.ade.prs.simulateIntegration({ sourceLaneIds: sourceIds, baseBranch: selectedPr.baseBranch });
      setSimulateResult(result);
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally { setSimulateBusy(false); }
  };

  React.useEffect(() => { setSimulateResult(null); setSimulateError(null); setDeleteConfirm(false); }, [selectedPrId]);

  const handleDelete = async () => {
    if (!selectedPr) return;
    setDeleteBusy(true);
    try {
      await window.ade.prs.delete({ prId: selectedPr.id, closeOnGitHub: deleteCloseGh });
      setDeleteConfirm(false);
      onSelectPr(null);
      await onRefresh();
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Integration PRs",
      icon: GitMerge,
      bodyClassName: "overflow-auto",
      children: (
        <div className="p-2 space-y-1">
          {!prs.length ? (
            <EmptyState title="No integration PRs" description="Create an integration proposal and PR when lane checks are green." />
          ) : (
            <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card overflow-hidden">
              <div className="flex flex-col gap-1 p-1.5">
                {prs.map((pr) => {
                  const ctx = mergeContextByPrId[pr.id];
                  const isSelected = pr.id === selectedPrId;
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      className={cn(
                        "flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition-all duration-150 border",
                        isSelected
                          ? "border-accent/40 bg-accent/12 shadow-[0_0_14px_-6px_rgba(34,211,238,0.45)]"
                          : "border-transparent hover:bg-card/65 hover:border-border/20 hover:translate-y-[-1px] hover:shadow-md"
                      )}
                      onClick={() => onSelectPr(pr.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span>
                          <span className="truncate font-semibold text-fg">{pr.title}</span>
                          <Chip className="text-[11px] text-violet-200 border-violet-500/30 bg-violet-500/12">integration</Chip>
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-fg/75">
                          <span>sources: {ctx?.sourceLaneIds.length ?? 0}</span>
                          <span className="text-muted-fg/50">into</span>
                          <span className="text-fg">{laneById.get(ctx?.targetLaneId ?? pr.laneId)?.name ?? "target"}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ),
    },
    detail: {
      title: selectedPr ? `Integration: #${selectedPr.githubPrNumber}` : "Integration Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: selectedPr ? (
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg text-muted-fg/70">#{selectedPr.githubPrNumber}</span>
              <span className="text-lg font-bold text-fg truncate">{selectedPr.title}</span>
            </div>
          </div>

          {/* Source lanes */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
            <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Source Lanes</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {mergeSourcesResolved.map((s) => (
                <Chip key={s.laneId} className="text-[11px]">{s.laneName}</Chip>
              ))}
              <span className="text-muted-fg/60">into</span>
              <Chip className="text-[11px] border-accent/30 bg-accent/10 text-accent">
                {laneById.get(resolverTargetLaneId ?? "")?.name ?? "target"}
              </Chip>
            </div>
          </div>

          {/* Simulate */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Integration Simulation</div>
              <Button size="sm" variant="outline" disabled={simulateBusy} onClick={() => void handleSimulate()}>
                <Lightning size={12} weight="fill" className="mr-1.5" />
                {simulateBusy ? "Simulating..." : "Simulate Merge"}
              </Button>
            </div>

            {simulateResult ? (
              <div className="space-y-1.5">
                <div className={cn(
                  "rounded-lg border px-2.5 py-2 text-xs font-medium",
                  simulateResult.overallOutcome === "clean" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                  simulateResult.overallOutcome === "conflict" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" :
                  "border-red-500/30 bg-red-500/10 text-red-300"
                )}>
                  Overall: {simulateResult.overallOutcome}
                </div>
                {simulateResult.steps.map((step) => (
                  <div key={step.laneId} className={cn(
                    "rounded-lg border px-2.5 py-2 text-xs",
                    step.outcome === "clean" ? "border-emerald-500/20 bg-emerald-500/5" :
                    step.outcome === "conflict" ? "border-amber-500/20 bg-amber-500/5" :
                    "border-red-500/20 bg-red-500/5"
                  )}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg">{step.laneName}</span>
                      <Chip className={cn("text-[11px] px-1.5",
                        step.outcome === "clean" ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" :
                        "text-amber-300 border-amber-500/30 bg-amber-500/10"
                      )}>{step.outcome}</Chip>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-fg/70">
                      +{step.diffStat.insertions} -{step.diffStat.deletions} ({step.diffStat.filesChanged} files)
                    </div>
                    {step.conflictingFiles.length > 0 ? (
                      <div className="mt-1 text-[11px] text-amber-300/80">
                        Conflicts: {step.conflictingFiles.map((f) => f.path).join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {simulateError ? <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{simulateError}</div> : null}
          </div>

          {/* Resolution */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-3">
            <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Resolution</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => setResolverOpen(true)}>
                <Sparkle size={14} weight="regular" className="mr-1.5" />Resolve with AI
              </Button>
              <Button size="sm" variant="outline" onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}>
                Open on GitHub
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(true)} className="text-red-300 hover:text-red-200 hover:border-red-500/40">
                <Trash size={14} weight="regular" className="mr-1.5" />Remove PR
              </Button>
            </div>
            {deleteConfirm ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 space-y-2.5">
                <div className="text-xs font-medium text-red-200">Remove this integration PR from ADE?</div>
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
          </div>

          <ResolverTerminalModal
            open={resolverOpen}
            onOpenChange={setResolverOpen}
            sourceLaneId={mergeSourcesResolved[0]?.laneId ?? selectedPr.laneId}
            sourceLaneIds={mergeSourcesResolved.length > 1 ? mergeSourcesResolved.map((s) => s.laneId) : undefined}
            targetLaneId={resolverTargetLaneId}
            cwdLaneId={resolverTargetLaneId}
            scenario={mergeSourcesResolved.length > 1 ? "integration-merge" : "single-merge"}
            onCompleted={() => void onRefresh()}
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No integration PR selected" description="Select an integration PR to view simulation and resolution." />
        </div>
      ),
    },
  }), [prs, selectedPr, selectedPrId, mergeContextByPrId, laneById, mergeSourcesResolved, resolverTargetLaneId, simulateResult, simulateBusy, simulateError, resolverOpen, deleteConfirm, deleteBusy, deleteCloseGh, onSelectPr, onRefresh]);

  return <PaneTilingLayout layoutId="prs:integration:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
