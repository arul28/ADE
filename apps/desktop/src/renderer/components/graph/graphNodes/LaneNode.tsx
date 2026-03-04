import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import { GitBranch, Stack } from "@phosphor-icons/react";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { iconGlyph, nodeDimensions } from "../graphHelpers";
import type { GraphNodeData } from "../graphTypes";

export function GraphLaneNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const lane = data.lane;
  const dimensions = nodeDimensions(lane, data.activityBucket, data.viewMode);
  const remoteSync = data.remoteSync;
  const autoRebase = data.autoRebaseStatus;
  const stackStale = Boolean(lane.parentLaneId && lane.status.behind > 0);
  const remoteDiverged = Boolean(remoteSync?.diverged);
  const remoteNeedsPublish = Boolean(remoteSync && ((remoteSync.hasUpstream === false) || remoteSync.ahead > 0));
  const remoteNeedsPull = Boolean(remoteSync?.hasUpstream && remoteSync.recommendedAction === "pull");
  const statusColor =
    data.status === "conflict-active" || data.status === "conflict-predicted"
      ? "text-red-300"
      : data.status === "behind-base"
        ? "text-amber-300"
        : data.status === "merge-ready"
          ? "text-emerald-300"
          : "text-muted-fg";

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-card/90 px-2 py-1.5 text-[11px] shadow-sm transition-all duration-150",
        lane.laneType === "attached" ? "border-dashed text-muted-fg" : "border-border text-fg",
        lane.laneType === "primary" && "border-[3px] border-accent",
        data.isIntegration && "border-2",
        selected && "ring-2 ring-accent",
        data.dimmed && "opacity-20 scale-50",
        data.highlight && "scale-[1.02] shadow-[0_2px_8px_rgba(0,0,0,0.2)]",
        data.activityBucket === "high" && "shadow-[0_0_18px_rgba(34,197,94,0.2)]",
        data.rebaseFailed && "border-red-500 ring-1 ring-red-500/80",
        data.rebasePulse && "ade-node-failed-pulse",
        data.mergeInProgress && "ade-node-merging",
        data.mergeDisappearing && "ade-node-disappear",
        data.focusGlow && "ring-2 ring-purple-400/60 shadow-[0_0_20px_rgba(167,139,250,0.35)]"
      )}
      style={{
        width: dimensions.width,
        minHeight: dimensions.height,
        borderColor: data.isIntegration ? "#A78BFA" : (lane.color ?? data.environment?.color ?? undefined)
      }}
    >
      <div className="flex items-center gap-1">
        {iconGlyph(lane.icon)}
        <span className="truncate font-semibold">{lane.name}</span>
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
      <div className="truncate text-[11px] text-muted-fg">{lane.branchRef}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Chip className="px-1 py-0 text-[10px]">{lane.status.dirty ? "dirty" : "clean"}</Chip>
        <Chip className="px-1 py-0 text-[10px]" title={`Compared to base ${lane.baseRef}`}>
          base {lane.status.ahead}↑/{lane.status.behind}↓
        </Chip>
        {remoteSync ? (
          remoteSync.hasUpstream ? (
            <Chip className="px-1 py-0 text-[10px]" title={`Compared to ${remoteSync.upstreamRef ?? "upstream"}`}>
              remote {remoteSync.ahead}↑/{remoteSync.behind}↓
            </Chip>
          ) : (
            <Chip className="px-1 py-0 text-[10px] text-amber-700" title="No upstream branch configured. Push once to publish this lane.">
              unpublished
            </Chip>
          )
        ) : (
          <Chip className="px-1 py-0 text-[10px] text-muted-fg">remote ?</Chip>
        )}
        <Chip className={cn("px-1 py-0 text-[10px]", statusColor)}>{data.status}</Chip>
        {stackStale ? <Chip className="px-1 py-0 text-[10px] text-amber-700">stack stale</Chip> : null}
        {autoRebase?.state === "autoRebased" ? <Chip className="px-1 py-0 text-[10px] text-emerald-300">auto rebased</Chip> : null}
        {autoRebase?.state === "rebasePending" ? <Chip className="px-1 py-0 text-[10px] text-amber-700">rebase pending</Chip> : null}
        {autoRebase?.state === "rebaseConflict" ? <Chip className="px-1 py-0 text-[10px] text-red-300">rebase conflict</Chip> : null}
        {remoteDiverged ? <Chip className="px-1 py-0 text-[10px] text-red-300">diverged</Chip> : null}
        {!remoteDiverged && remoteNeedsPublish ? <Chip className="px-1 py-0 text-[10px] text-emerald-300">push</Chip> : null}
        {!remoteDiverged && !remoteNeedsPublish && remoteNeedsPull ? <Chip className="px-1 py-0 text-[10px] text-sky-300">pull</Chip> : null}
        {data.environment ? (
          <span
            className="rounded border px-1 py-0 text-[10px] uppercase tracking-wide"
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
        {data.mergeInProgress ? <Chip className="px-1 py-0 text-[10px] text-accent">merging</Chip> : null}
        {data.activeSessions > 0 ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" title="Active sessions" /> : null}
      </div>
      {lane.tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {lane.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded bg-surface-recessed px-1 text-[10px] text-muted-fg">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {data.collapsedChildCount > 0 ? (
        <div className="mt-1 inline-flex items-center gap-1 rounded border border-border/10 bg-card/60 px-1 text-[11px]">
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
      <div className="pointer-events-none absolute inset-0 rounded-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)]" />
    </div>
  );
}
