import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import { ClockCounterClockwise, GitBranch, Stack } from "@phosphor-icons/react";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { iconGlyph, nodeDimensions } from "../graphHelpers";
import type { GraphNodeData } from "../graphTypes";

export function GraphLaneNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const lane = data.lane;
  const dimensions = nodeDimensions(lane, data.activityBucket, data.viewMode, {
    isIntegration: data.isIntegration,
    integrationSourceCount: data.integrationSources.length,
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

  const syncBadge = (() => {
    if (remoteDiverged) return { label: "Diverged", className: "text-red-300" };
    if (autoRebase?.state === "rebaseConflict") return { label: "Rebase conflict", className: "text-red-300" };
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

  return (
    <div
      className={cn(
        "group relative rounded-xl border bg-card/92 px-2.5 py-2 text-[11px] shadow-sm transition-all duration-150",
        lane.laneType === "attached" ? "border-dashed text-muted-fg" : "border-border text-fg",
        lane.laneType === "primary" && "border-[3px] border-accent",
        data.isIntegration && "border-2",
        selected && "ring-2 ring-accent",
        data.dimmed && "opacity-55",
        data.highlight && "shadow-[0_4px_14px_rgba(0,0,0,0.18)]",
        data.activityBucket === "high" && "shadow-[0_0_18px_rgba(34,197,94,0.2)]",
        data.rebaseFailed && "border-red-500 ring-1 ring-red-500/80",
        data.rebasePulse && "ade-node-failed-pulse",
        data.mergeInProgress && "ade-node-merging",
        data.mergeDisappearing && "ade-node-disappear",
        data.focusGlow && "ring-2 ring-purple-400/60 shadow-[0_0_20px_rgba(167,139,250,0.35)]",
        data.isIntegration && "bg-[linear-gradient(180deg,rgba(167,139,250,0.14),rgba(24,24,27,0.9))]"
      )}
      style={{
        width: dimensions.width,
        minHeight: dimensions.height,
        borderColor: data.isIntegration ? "#A78BFA" : (lane.color ?? data.environment?.color ?? undefined)
      }}
    >
      <div className="flex items-center gap-1">
        {iconGlyph(lane.icon)}
        <span className="truncate font-semibold text-fg">{lane.name}</span>
        {data.isIntegration ? (
          <span
            className="ml-auto flex items-center gap-0.5 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wider"
            style={{ color: "#A78BFA", backgroundColor: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.3)" }}
            title="Integration lane"
          >
            <GitBranch size={10} weight="bold" />
            Integration
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-fg">{lane.branchRef}</div>
      {data.integrationSources.length > 0 ? (
        <div className="mt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#C4B5FD]">
            Fed By
          </div>
          <div className="flex flex-wrap gap-1">
            {visibleIntegrationSources.map((source) => (
              <span
                key={source.laneId}
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium text-[#E9D5FF]"
                style={{ borderColor: "rgba(167,139,250,0.35)", background: "rgba(167,139,250,0.12)" }}
                title={source.laneName}
              >
                {source.laneName}
              </span>
            ))}
            {hiddenIntegrationSourceCount > 0 ? (
              <span
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium text-[#DDD6FE]"
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
        <Chip className={cn("px-1.5 py-0 text-[10px]", lane.status.dirty ? "text-amber-300" : "text-emerald-300")}>
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
            className="rounded border px-1.5 py-0 text-[10px] uppercase tracking-wide"
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
        <div className="mt-2 inline-flex items-center gap-1 rounded border border-border/10 bg-card/60 px-1.5 py-0.5 text-[11px]">
          <Stack size={12} weight="regular" />
          {data.collapsedChildCount} children
        </div>
      ) : null}
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
      <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)]" />
    </div>
  );
}
