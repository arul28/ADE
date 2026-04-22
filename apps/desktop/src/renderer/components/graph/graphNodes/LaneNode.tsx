import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import {
  ArrowsDownUp,
  CaretRight,
  ClockCounterClockwise,
  GitBranch,
  House,
  Stack,
  TreeStructure
} from "@phosphor-icons/react";
import type { ConflictStatus } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { iconGlyph, nodeDimensions } from "../graphHelpers";
import type { GraphNodeData } from "../graphTypes";

function conflictStatusLabel(status: ConflictStatus["status"] | "unknown"): string {
  switch (status) {
    case "conflict-active":
      return "Conflict";
    case "conflict-predicted":
      return "Risk";
    case "behind-base":
      return "Behind base";
    case "merge-ready":
      return "Merge ready";
    default:
      return "Unknown";
  }
}

export function GraphLaneNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const lane = data.lane;
  const dimensions = nodeDimensions(lane, data.activityBucket, data.viewMode, {
    isIntegration: data.isIntegration,
    integrationSourceCount: data.integrationSources.length
  });
  const remoteSync = data.remoteSync;
  const autoRebase = data.autoRebaseStatus;
  const pr = data.pr;
  const visibleIntegrationSources = data.integrationSources.slice(0, 3);
  const hiddenIntegrationSourceCount = Math.max(0, data.integrationSources.length - visibleIntegrationSources.length);
  const stackStale = Boolean(lane.parentLaneId && lane.status.behind > 0);
  const remoteDiverged = Boolean(remoteSync?.diverged);
  const remoteNeedsPublish = Boolean(remoteSync && ((remoteSync.hasUpstream === false) || remoteSync.ahead > 0));
  const remoteNeedsPull = Boolean(remoteSync?.hasUpstream && remoteSync.recommendedAction === "pull");
  const baseBehind = lane.status.behind > 0 || data.status === "behind-base";
  const isPrimary = lane.laneType === "primary";
  const depth = data.hierarchyDepth;
  const orphanStack = depth >= 1000;

  const syncBadge = (() => {
    if (remoteDiverged) return { label: "Diverged", className: "text-red-300" };
    if (autoRebase?.state === "rebaseConflict") return { label: "Rebase conflict", className: "text-red-300" };
    if (autoRebase?.state === "rebaseFailed") return { label: "Rebase failed", className: "text-red-300" };
    if (autoRebase?.state === "rebasePending") return { label: "Rebase pending", className: "text-amber-300" };
    if (remoteNeedsPublish) return { label: remoteSync?.hasUpstream === false ? "Publish lane" : "Needs push", className: "text-emerald-300" };
    if (remoteNeedsPull) return { label: "Needs pull", className: "text-sky-300" };
    if (baseBehind || stackStale) return { label: "Behind base", className: "text-amber-300" };
    if (autoRebase?.state === "autoRebased") return { label: "Auto-rebased", className: "text-emerald-300" };
    return { label: "In sync", className: "text-muted-fg" };
  })();

  const prBadge = (() => {
    if (!pr) return null;
    if (pr.state === "merged") return { label: `Merged PR #${pr.number}`, className: "text-emerald-300" };
    if (pr.state === "closed") return { label: `Closed PR #${pr.number}`, className: "text-muted-fg" };
    if (pr.reviewStatus === "changes_requested") return { label: `PR #${pr.number} needs changes`, className: "text-amber-300" };
    if (pr.checksStatus === "failing") return { label: `PR #${pr.number} checks failing`, className: "text-red-300" };
    if (pr.reviewStatus === "approved" && pr.checksStatus === "passing") return { label: `PR #${pr.number} ready`, className: "text-emerald-300" };
    if (pr.pendingCheckCount > 0) return { label: `PR #${pr.number} checks running`, className: "text-sky-300" };
    return { label: `PR #${pr.number} open`, className: "text-sky-300" };
  })();

  function resolveLaneRoleLabel(): string {
    switch (lane.laneType) {
      case "attached":
        return "Attached lane";
      case "worktree":
        return "Lane";
      default:
        return "Primary lane";
    }
  }
  const laneRoleLabel = resolveLaneRoleLabel();

  const accentBorder = data.isIntegration ? "#A78BFA" : (lane.color ?? data.environment?.color ?? undefined);

  function renderLaneIcon() {
    if (lane.icon) return iconGlyph(lane.icon);
    if (isPrimary) return <House size={15} weight="duotone" />;
    return null;
  }

  return (
    <div
      data-tour="graph.node"
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-white/[0.03] px-3 py-2.5 text-[11px] shadow-card backdrop-blur-sm transition-all duration-150",
        "border-white/[0.08]",
        lane.laneType === "attached" ? "border-dashed text-muted-fg" : "text-fg",
        isPrimary && "border-[2.5px] border-accent/90",
        data.isIntegration && "border-2",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
        data.dimmed && "opacity-55",
        data.highlight && "shadow-[0_4px_18px_rgba(0,0,0,0.22)]",
        data.activityBucket === "high" && "shadow-[0_0_20px_rgba(34,197,94,0.18)]",
        data.rebaseFailed && "border-red-500 ring-1 ring-red-500/80",
        data.rebasePulse && "ade-node-failed-pulse",
        data.mergeInProgress && "ade-node-merging",
        data.mergeDisappearing && "ade-node-disappear",
        data.focusGlow && "ring-2 ring-purple-400/60 shadow-[0_0_20px_rgba(167,139,250,0.35)]",
        data.isIntegration && "bg-[linear-gradient(180deg,rgba(167,139,250,0.12),rgba(24,24,27,0.88))]"
      )}
      style={{
        width: dimensions.width,
        minHeight: dimensions.height,
        borderColor: accentBorder
      }}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0 text-muted-fg">{renderLaneIcon()}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="truncate font-semibold tracking-tight text-fg">{lane.name}</span>
            {data.isIntegration ? (
              <span
                className="ml-auto flex items-center gap-0.5 rounded-md px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider"
                style={{ color: "#C4B5FD", backgroundColor: "rgba(167,139,250,0.14)", border: "1px solid rgba(167,139,250,0.35)" }}
                title="Integration lane"
              >
                <GitBranch size={10} weight="bold" />
                Integration
              </span>
            ) : (
              <span className="ml-auto rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide text-muted-fg">
                {laneRoleLabel}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-fg">
            <span className="truncate font-mono" title={lane.branchRef}>
              {lane.branchRef}
            </span>
            {!data.isIntegration && !orphanStack ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-fg/90" title="Depth from workspace primary">
                <TreeStructure size={11} weight="bold" className="text-muted-fg" />
                L{depth}
              </span>
            ) : null}
          </div>
          {!data.isIntegration && data.parentLaneName ? (
            <div className="mt-1 flex items-center gap-0.5 truncate text-[10px] text-muted-fg" title="Parent in this workspace">
              <CaretRight size={11} weight="bold" className="shrink-0 text-muted-fg/70" />
              <span className="truncate">On {data.parentLaneName}</span>
            </div>
          ) : null}
          {orphanStack && !data.isIntegration ? (
            <div className="mt-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200/90">
              Not stacked under the workspace primary — drag onto a parent or open the lane list to fix.
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-white/[0.06] pt-2">
        <span
          className={cn(
            "rounded-md border px-1.5 py-0 text-[10px] font-medium",
            data.status === "conflict-active" && "border-red-500/35 bg-red-500/10 text-red-200",
            data.status === "conflict-predicted" && "border-amber-500/35 bg-amber-500/10 text-amber-100",
            data.status === "behind-base" && "border-amber-500/25 bg-amber-500/8 text-amber-100",
            data.status === "merge-ready" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
            (data.status === "unknown" || !data.status) && "border-white/[0.06] bg-white/[0.02] text-muted-fg"
          )}
        >
          {conflictStatusLabel(data.status)}
        </span>
        <span className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-1.5 py-0 font-mono text-[10px] text-muted-fg" title="Commits ahead / behind parent base">
          <ArrowsDownUp size={10} weight="bold" />
          {lane.status.ahead}↑ {lane.status.behind}↓
        </span>
        {lane.status.remoteBehind >= 0 ? (
          <span className="rounded-md border border-white/[0.06] bg-white/[0.02] px-1.5 py-0 font-mono text-[10px] text-muted-fg" title="Remote tracking">
            r{lane.status.remoteBehind}
          </span>
        ) : null}
      </div>

      {data.integrationSources.length > 0 ? (
        <div className="mt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#C4B5FD]">Fed by</div>
          <div className="flex flex-wrap gap-1">
            {visibleIntegrationSources.map((source) => (
              <span
                key={source.laneId}
                className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-[#E9D5FF]"
                style={{ borderColor: "rgba(167,139,250,0.35)", background: "rgba(167,139,250,0.12)" }}
                title={source.laneName}
              >
                {source.laneName}
              </span>
            ))}
            {hiddenIntegrationSourceCount > 0 ? (
              <span
                className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-[#DDD6FE]"
                style={{ borderColor: "rgba(167,139,250,0.28)", background: "rgba(167,139,250,0.08)" }}
                title={`${hiddenIntegrationSourceCount} more source lanes`}
              >
                +{hiddenIntegrationSourceCount}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Chip className={cn("px-1.5 py-0 text-[10px]", lane.status.dirty ? "text-amber-200" : "text-emerald-200")}>
          {lane.status.dirty ? "Dirty" : "Clean"}
        </Chip>
        <Chip className={cn("px-1.5 py-0 text-[10px]", syncBadge.className)} title={`Compared to base ${lane.baseRef}`}>
          {syncBadge.label}
        </Chip>
        {prBadge ? (
          <Chip className={cn("px-1.5 py-0 text-[10px]", prBadge.className)} title={pr?.title}>
            {prBadge.label}
          </Chip>
        ) : null}
        {data.environment ? (
          <span
            className="rounded-md border px-1.5 py-0 text-[10px] uppercase tracking-wide"
            style={{
              borderColor: data.environment.color ?? undefined,
              color: data.environment.color ?? "var(--color-muted-fg)",
              backgroundColor: data.environment.color ? `${data.environment.color}22` : undefined
            }}
            title={`Environment: ${data.environment.env}`}
          >
            {data.environment.env.slice(0, 10)}
          </span>
        ) : null}
        {data.mergeInProgress ? <Chip className="px-1.5 py-0 text-[10px] text-accent">Merging</Chip> : null}
        {pr?.activityState === "stale" ? (
          <Chip className="px-1.5 py-0 text-[10px] text-muted-fg">
            <ClockCounterClockwise size={10} />
            Stale
          </Chip>
        ) : null}
        {data.activeSessions > 0 ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" title="Active sessions" /> : null}
      </div>

      {data.collapsedChildCount > 0 ? (
        <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[11px] text-muted-fg">
          <Stack size={12} weight="regular" />
          {data.collapsedChildCount} children hidden
        </div>
      ) : null}

      <div className="pointer-events-none mt-2 flex items-center justify-between border-t border-white/[0.05] pt-1.5 text-[9px] uppercase tracking-wide text-muted-fg/80">
        <span>Click · menu</span>
        <span>Double · lane</span>
        <span>Drag · reparent</span>
      </div>

      <Handle
        id="target"
        type="target"
        position={Position.Top}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
      <Handle
        id="source"
        type="source"
        position={Position.Bottom}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
    </div>
  );
}
