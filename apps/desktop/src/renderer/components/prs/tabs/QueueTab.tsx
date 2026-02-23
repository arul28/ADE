import React from "react";
import { CaretRight, Pause, Play, SkipForward, ArrowsDownUp, Trash } from "@phosphor-icons/react";
import type {
  LandResult,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrSummary,
  PrWithConflicts,
  QueueEntryState,
  QueueLandingState,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

type QueueGroup = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  members: Array<{ prId: string; laneId: string; laneName: string; position: number; pr: PrWithConflicts | null }>;
  landingState: QueueLandingState | null;
};

function entryStateChip(state: QueueEntryState): { label: string; className: string; pulse?: boolean } {
  switch (state) {
    case "landed": return { label: "landed", className: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" };
    case "landing": return { label: "landing", className: "text-blue-300 border-blue-500/30 bg-blue-500/10", pulse: true };
    case "rebasing": return { label: "rebasing", className: "text-amber-300 border-amber-500/30 bg-amber-500/10", pulse: true };
    case "resolving": return { label: "resolving", className: "text-violet-300 border-violet-500/30 bg-violet-500/10", pulse: true };
    case "failed": return { label: "failed", className: "text-red-300 border-red-500/30 bg-red-500/10" };
    case "paused": return { label: "paused", className: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
    case "skipped": return { label: "skipped", className: "text-neutral-300 border-neutral-500/30 bg-neutral-500/10" };
    default: return { label: "pending", className: "text-neutral-300 border-neutral-500/30 bg-neutral-500/10" };
  }
}

type QueueTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function QueueTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedGroupId, onSelectGroup, onRefresh }: QueueTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const prById = React.useMemo(() => new Map(prs.map((p) => [p.id, p])), [prs]);

  const [landBusy, setLandBusy] = React.useState(false);
  const [landError, setLandError] = React.useState<string | null>(null);
  const [landResult, setLandResult] = React.useState<LandResult | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  // Build queue groups from merge contexts
  const queueGroups = React.useMemo(() => {
    const groupMap = new Map<string, QueueGroup>();
    for (const pr of prs) {
      const ctx = mergeContextByPrId[pr.id];
      if (!ctx?.groupId || ctx.groupType !== "queue") continue;
      let group = groupMap.get(ctx.groupId);
      if (!group) {
        group = { groupId: ctx.groupId, name: null, targetBranch: null, members: [], landingState: null };
        groupMap.set(ctx.groupId, group);
      }
      const member = ctx.members?.find((m) => m.prId === pr.id);
      group.members.push({
        prId: pr.id,
        laneId: pr.laneId,
        laneName: laneById.get(pr.laneId)?.name ?? pr.laneId,
        position: member?.position ?? group.members.length,
        pr,
      });
    }
    // Sort members by position within each group
    for (const group of groupMap.values()) {
      group.members.sort((a, b) => a.position - b.position);
    }
    return [...groupMap.values()];
  }, [prs, mergeContextByPrId, laneById]);

  const selectedGroup = React.useMemo(() => queueGroups.find((g) => g.groupId === selectedGroupId) ?? null, [queueGroups, selectedGroupId]);

  // Auto-select first group (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (queueGroups.length === 0 && selectedGroupId === null) return;
    if (selectedGroupId && queueGroups.some((g) => g.groupId === selectedGroupId)) return;
    onSelectGroup(queueGroups[0]?.groupId ?? null);
  }, [queueGroups, selectedGroupId, onSelectGroup]);

  const handleLandNext = async () => {
    if (!selectedGroup) return;
    setLandBusy(true); setLandError(null); setLandResult(null);
    try {
      const result = await window.ade.prs.landQueueNext({ groupId: selectedGroup.groupId, method: mergeMethod });
      setLandResult(result);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setLandBusy(false); }
  };

  const handleDeletePr = async (prId: string) => {
    setDeleteBusy(true); setLandError(null);
    try {
      await window.ade.prs.delete({ prId, closeOnGitHub: deleteCloseGh });
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Queue Groups",
      bodyClassName: "overflow-auto",
      children: (
        <div className="p-2 space-y-1.5">
          {!queueGroups.length ? (
            <EmptyState title="No queue groups" description="Create a queue to open sequential PRs across lanes for ordered landing." />
          ) : (
            queueGroups.map((group) => {
              const isSelected = group.groupId === selectedGroupId;
              const openCount = group.members.filter((m) => m.pr?.state === "open" || m.pr?.state === "draft").length;
              const landedCount = group.members.filter((m) => m.pr?.state === "merged").length;
              return (
                <button
                  key={group.groupId}
                  type="button"
                  className={cn(
                    "w-full rounded-xl border p-3 text-left text-xs transition-all duration-150",
                    isSelected
                      ? "border-accent/40 bg-accent/12 shadow-[0_0_14px_-6px_rgba(34,211,238,0.45)]"
                      : "border-border/20 bg-card/45 backdrop-blur-sm shadow-card hover:translate-y-[-1px] hover:shadow-md"
                  )}
                  onClick={() => onSelectGroup(group.groupId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-fg">{group.name ?? `Queue ${group.groupId.slice(0, 8)}`}</div>
                    <Chip className="text-[11px] text-cyan-200 border-cyan-500/30 bg-cyan-500/12">queue</Chip>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-fg/75">
                    <span>{group.members.length} PRs</span>
                    <span className="text-emerald-300">{landedCount} landed</span>
                    <span className="text-blue-300">{openCount} open</span>
                    {group.targetBranch ? <span className="font-mono">→ {group.targetBranch}</span> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ),
    },
    detail: {
      title: selectedGroup ? `Queue: ${selectedGroup.name ?? selectedGroup.groupId.slice(0, 8)}` : "Queue Detail",
      bodyClassName: "overflow-auto",
      children: selectedGroup ? (
        <div className="p-4 space-y-4">
          {/* Controls */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">{selectedGroup.name ?? "Queue"}</div>
                <div className="text-[11px] text-muted-fg/70">{selectedGroup.members.length} PRs in pipeline</div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" disabled={landBusy} onClick={() => void handleLandNext()}>
                  <Play size={12} weight="fill" className="mr-1.5" />
                  {landBusy ? "Landing..." : "Land Next"}
                </Button>
              </div>
            </div>
          </div>

          {/* Pipeline visualization */}
          <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card p-3.5 space-y-0">
            <div className="text-xs font-medium tracking-widest uppercase text-muted-fg mb-3">Pipeline</div>
            {selectedGroup.members.map((member, idx) => {
              const isLast = idx === selectedGroup.members.length - 1;
              const prState = member.pr?.state ?? "unknown";
              const isLanded = prState === "merged";
              const isActive = prState === "open";
              return (
                <div key={member.prId} className="flex items-stretch">
                  {/* Connector */}
                  <div className="flex flex-col items-center w-8 shrink-0">
                    <div className={cn(
                      "w-3 h-3 rounded-full border-2 shrink-0",
                      isLanded ? "bg-emerald-400 border-emerald-400" : isActive ? "bg-blue-400 border-blue-400 animate-pulse" : "bg-neutral-600 border-neutral-500"
                    )} />
                    {!isLast ? (
                      <div className={cn(
                        "w-0.5 flex-1 min-h-[24px]",
                        isLanded ? "bg-emerald-500/50" : "bg-border/30"
                      )} />
                    ) : null}
                  </div>
                  {/* Node */}
                  <div className={cn(
                    "flex-1 rounded-lg border px-3 py-2.5 mb-1.5 text-xs transition-all",
                    isActive ? "border-blue-500/30 bg-blue-500/8" : isLanded ? "border-emerald-500/20 bg-emerald-500/5" : "border-border/20 bg-card/25"
                  )}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold text-fg truncate">{member.laneName}</span>
                        {member.pr ? <span className="font-mono text-[11px] text-muted-fg/70">#{member.pr.githubPrNumber}</span> : null}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Chip className={cn("text-[11px] px-1.5",
                          isLanded ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" :
                          isActive ? "text-blue-300 border-blue-500/30 bg-blue-500/10" :
                          "text-neutral-300 border-neutral-500/30 bg-neutral-500/10"
                        )}>
                          {isLanded ? "landed" : isActive ? "open" : prState}
                        </Chip>
                        {!isLanded ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(deleteTarget === member.prId ? null : member.prId); }}
                            className="p-0.5 rounded text-muted-fg/50 hover:text-red-300 transition-colors"
                            title="Remove PR"
                          >
                            <Trash size={12} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {deleteTarget === member.prId ? (
                      <div className="mt-1.5 rounded border border-red-500/30 bg-red-500/8 p-2 space-y-2">
                        <div className="text-[11px] text-red-200">Remove this PR from the queue?</div>
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-fg cursor-pointer">
                          <input type="checkbox" checked={deleteCloseGh} onChange={(e) => setDeleteCloseGh(e.target.checked)} className="rounded" />
                          Also close on GitHub
                        </label>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" disabled={deleteBusy} onClick={() => void handleDeletePr(member.prId)} className="text-red-300 border-red-500/40 hover:bg-red-500/15 text-[11px] h-6 px-2">
                            {deleteBusy ? "Removing..." : "Confirm"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDeleteTarget(null)} className="text-[11px] h-6 px-2">Cancel</Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Errors/results */}
          {landError ? <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{landError}</div> : null}
          {landResult ? (
            <div className={cn("rounded border px-3 py-2 text-xs", landResult.success ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-red-500/40 bg-red-500/10 text-red-200")}>
              {landResult.success ? `Landed PR #${landResult.prNumber}` : `Failed: ${landResult.error ?? "unknown"}`}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No queue selected" description="Select a queue group to manage landing order." />
        </div>
      ),
    },
  }), [queueGroups, selectedGroup, selectedGroupId, landBusy, landError, landResult, mergeMethod, deleteTarget, deleteBusy, deleteCloseGh, onSelectGroup, onRefresh]);

  return <PaneTilingLayout layoutId="prs:queue:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
