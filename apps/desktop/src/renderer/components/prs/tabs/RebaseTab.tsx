import React from "react";
import { ArrowsDownUp, Clock, CheckCircle, Warning, Sparkle, Eye, XCircle } from "@phosphor-icons/react";
import type { LaneSummary, RebaseNeed } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { UrgencyGroup } from "../shared/UrgencyGroup";
import { StatusDot } from "../shared/StatusDot";
import { ModelSelector } from "../shared/ModelSelector";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

type RebaseTabProps = {
  rebaseNeeds: RebaseNeed[];
  lanes: LaneSummary[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  resolverModel: "codex" | "claude";
  resolverReasoningLevel: string;
  onResolverChange: (model: "codex" | "claude", level: string) => void;
  onRefresh: () => Promise<void>;
};

type UrgencyCategory = "attention" | "clean" | "recent" | "upToDate";

function categorize(need: RebaseNeed): UrgencyCategory {
  if (need.dismissedAt) return "upToDate";
  if (need.deferredUntil && new Date(need.deferredUntil) > new Date()) return "upToDate";
  if (need.behindBy === 0) return "upToDate";
  if (need.conflictPredicted) return "attention";
  return "clean";
}

export function RebaseTab({
  rebaseNeeds,
  lanes,
  selectedItemId,
  onSelectItem,
  resolverModel,
  resolverReasoningLevel,
  onResolverChange,
  onRefresh,
}: RebaseTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [rebaseBusy, setRebaseBusy] = React.useState(false);
  const [rebaseError, setRebaseError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);

  const [collapsed, setCollapsed] = React.useState<Record<UrgencyCategory, boolean>>({
    attention: false,
    clean: false,
    recent: true,
    upToDate: true,
  });

  const grouped = React.useMemo(() => {
    const groups: Record<UrgencyCategory, RebaseNeed[]> = {
      attention: [],
      clean: [],
      recent: [],
      upToDate: [],
    };
    for (const need of rebaseNeeds) {
      groups[categorize(need)].push(need);
    }
    // Sort attention by behindBy desc
    groups.attention.sort((a, b) => b.behindBy - a.behindBy);
    groups.clean.sort((a, b) => b.behindBy - a.behindBy);
    return groups;
  }, [rebaseNeeds]);

  const selectedNeed = React.useMemo(
    () => rebaseNeeds.find((n) => n.laneId === selectedItemId) ?? null,
    [rebaseNeeds, selectedItemId],
  );

  // Auto-select first item in highest-urgency group (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (rebaseNeeds.length === 0 && selectedItemId === null) return;
    if (selectedItemId && rebaseNeeds.some((n) => n.laneId === selectedItemId)) return;
    const first = grouped.attention[0] ?? grouped.clean[0] ?? grouped.recent[0] ?? grouped.upToDate[0];
    onSelectItem(first?.laneId ?? null);
  }, [rebaseNeeds, selectedItemId, grouped, onSelectItem]);

  React.useEffect(() => {
    setRebaseError(null);
  }, [selectedItemId]);

  const handleRebase = async (aiAssisted: boolean) => {
    if (!selectedNeed) return;
    setRebaseError(null);

    if (aiAssisted) {
      // For AI-assisted: validate that we can resolve the target lane, then open modal
      if (!resolverTargetLaneId) {
        setRebaseError(`Cannot find a lane matching base branch "${selectedNeed.baseBranch}". Create the lane first or rebase manually.`);
        return;
      }
      setResolverOpen(true);
      return;
    }

    // Manual rebase
    setRebaseBusy(true);
    try {
      await window.ade.rebase.execute({ laneId: selectedNeed.laneId, aiAssisted: false });
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (!selectedNeed) return;
    try {
      await window.ade.rebase.dismiss(selectedNeed.laneId);
      await onRefresh();
    } catch {
      /* swallow */
    }
  };

  const handleDefer = async () => {
    if (!selectedNeed) return;
    const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4 hours
    try {
      await window.ade.rebase.defer(selectedNeed.laneId, until);
      await onRefresh();
    } catch {
      /* swallow */
    }
  };

  const renderNeedItem = (need: RebaseNeed) => {
    const isSelected = need.laneId === selectedItemId;
    const laneName = laneById.get(need.laneId)?.name ?? need.laneId;
    return (
      <button
        key={need.laneId}
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition-colors duration-100",
          isSelected
            ? "border-l-2 border-l-accent bg-accent/8"
            : "border-l-2 border-l-transparent hover:bg-card/40",
        )}
        onClick={() => onSelectItem(need.laneId)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot
            color={need.conflictPredicted ? "#f59e0b" : need.behindBy > 0 ? "#3b82f6" : "#22c55e"}
            pulse={need.conflictPredicted}
          />
          <span className="font-semibold text-fg truncate">{laneName}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {need.behindBy > 0 && (
            <Chip className="text-[11px] text-blue-300 border-blue-500/30 bg-blue-500/10">
              {need.behindBy} behind
            </Chip>
          )}
          {need.conflictPredicted && (
            <Chip className="text-[11px] text-amber-300 border-amber-500/30 bg-amber-500/10">
              conflicts
            </Chip>
          )}
        </div>
      </button>
    );
  };

  const urgencyGroups: Array<{ key: UrgencyCategory; title: string; color: string; icon: typeof Warning }> = [
    { key: "attention", title: "Needs Attention", color: "#f59e0b", icon: Warning },
    { key: "clean", title: "Clean Rebase", color: "#3b82f6", icon: ArrowsDownUp },
    { key: "recent", title: "Recently Rebased", color: "#a855f7", icon: Clock },
    { key: "upToDate", title: "Up to Date", color: "#22c55e", icon: CheckCircle },
  ];

  const resolverTargetLaneId = React.useMemo(() => {
    if (!selectedNeed) return null;
    return lanes.find((l) => {
      const ref = l.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      const base = selectedNeed.baseBranch.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      return ref === base;
    })?.id ?? null;
  }, [lanes, selectedNeed]);

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      list: {
        title: "Rebase Status",
        icon: ArrowsDownUp,
        bodyClassName: "overflow-auto",
        children: (
          <div className="p-2 space-y-2">
            {rebaseNeeds.length === 0 ? (
              <EmptyState
                title="All lanes up to date"
                description="No lanes need rebasing. This view auto-populates when lanes fall behind their base branch."
              />
            ) : (
              urgencyGroups
                .filter((g) => grouped[g.key].length > 0)
                .map((g) => (
                  <UrgencyGroup
                    key={g.key}
                    title={g.title}
                    count={grouped[g.key].length}
                    color={g.color}
                    collapsed={collapsed[g.key]}
                    onToggle={() => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                  >
                    <div className="space-y-0.5 mt-1.5">
                      {grouped[g.key].map(renderNeedItem)}
                    </div>
                  </UrgencyGroup>
                ))
            )}
          </div>
        ),
      },
      detail: {
        title: selectedNeed
          ? `Rebase: ${laneById.get(selectedNeed.laneId)?.name ?? selectedNeed.laneId}`
          : "Rebase Detail",
        icon: Eye,
        bodyClassName: "overflow-auto",
        children: selectedNeed ? (
          <div className="p-4 space-y-5">
            {/* Header */}
            <div className="rounded-lg bg-card/30 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-fg">
                    {laneById.get(selectedNeed.laneId)?.name ?? selectedNeed.laneId}
                  </div>
                  <div className="text-[11px] text-muted-fg/70 font-mono mt-0.5">
                    base: {selectedNeed.baseBranch}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Chip
                    className={cn(
                      "text-xs",
                      selectedNeed.behindBy > 0
                        ? "text-blue-300 border-blue-500/30 bg-blue-500/10"
                        : "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
                    )}
                  >
                    {selectedNeed.behindBy > 0 ? `${selectedNeed.behindBy} commits behind` : "up to date"}
                  </Chip>
                  {selectedNeed.conflictPredicted && (
                    <Chip className="text-xs text-amber-300 border-amber-500/30 bg-amber-500/10">
                      conflicts predicted
                    </Chip>
                  )}
                </div>
              </div>
            </div>

            {/* Drift analysis */}
            <div className="rounded-lg bg-card/30 p-4 space-y-3">
              <div className="text-xs font-medium text-muted-fg/80">Drift Analysis</div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                  <div className="text-muted-fg/70">Behind By</div>
                  <div className={cn("font-mono font-semibold", selectedNeed.behindBy > 5 ? "text-amber-300" : "text-fg")}>
                    {selectedNeed.behindBy} commits
                  </div>
                </div>
                <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                  <div className="text-muted-fg/70">Conflict Predicted</div>
                  <div className={cn("font-semibold", selectedNeed.conflictPredicted ? "text-amber-300" : "text-emerald-300")}>
                    {selectedNeed.conflictPredicted ? "yes" : "no"}
                  </div>
                </div>
                <div className="bg-muted/15 rounded-md p-2.5 text-xs">
                  <div className="text-muted-fg/70">Linked PR</div>
                  <div className="text-fg">{selectedNeed.prId ? `PR linked` : "none"}</div>
                </div>
              </div>

              {selectedNeed.conflictingFiles.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-fg/70">Predicted conflicting files:</div>
                  <div className="grid gap-1">
                    {selectedNeed.conflictingFiles.map((f) => (
                      <div
                        key={f}
                        className="bg-amber-500/5 rounded-md px-2.5 py-1.5 text-xs font-mono text-amber-200/80"
                      >
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Resolution */}
            <div className="rounded-lg bg-card/30 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-fg/80">Resolution</div>
                <ModelSelector
                  model={resolverModel}
                  reasoningLevel={resolverReasoningLevel}
                  onChange={onResolverChange}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0}
                  onClick={() => void handleRebase(true)}
                >
                  <Sparkle size={14} weight="regular" className="mr-1.5" />
                  Rebase with AI
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0}
                  onClick={() => void handleRebase(false)}
                >
                  Manual Rebase
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleDefer()}>
                  <Clock size={12} className="mr-1" />
                  Defer 4h
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-neutral-300 hover:text-neutral-200"
                  onClick={() => void handleDismiss()}
                >
                  <XCircle size={12} className="mr-1" />
                  Dismiss
                </Button>
              </div>

              {selectedNeed.groupContext && (
                <div className="bg-muted/15 rounded-md px-2.5 py-2 text-xs text-muted-fg">
                  Part of group: <span className="text-fg font-medium">{selectedNeed.groupContext}</span>
                </div>
              )}
            </div>

            {rebaseError && (
              <div className="bg-red-500/5 rounded-lg px-3 py-2 text-xs text-red-200">
                {rebaseError}
              </div>
            )}

            {resolverOpen && resolverTargetLaneId && (
              <ResolverTerminalModal
                open={resolverOpen}
                onOpenChange={setResolverOpen}
                sourceLaneId={selectedNeed.laneId}
                targetLaneId={resolverTargetLaneId}
                cwdLaneId={selectedNeed.laneId}
                scenario="single-merge"
                onCompleted={() => void onRefresh()}
              />
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState title="No lane selected" description="Select a lane to view rebase status and resolve conflicts." />
          </div>
        ),
      },
    }),
    [
      rebaseNeeds,
      selectedNeed,
      selectedItemId,
      grouped,
      collapsed,
      laneById,
      resolverModel,
      resolverReasoningLevel,
      rebaseBusy,
      rebaseError,
      resolverOpen,
      resolverTargetLaneId,
      onSelectItem,
      onRefresh,
      onResolverChange,
    ],
  );

  return <PaneTilingLayout layoutId="prs:rebase:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
