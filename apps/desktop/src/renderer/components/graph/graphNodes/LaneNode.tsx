import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import { ChatText, CheckCircle, ClockCounterClockwise, GitBranch, Stack } from "@phosphor-icons/react";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { COLORS } from "../../lanes/laneDesignTokens";
import {
  getPrChecksBadge,
  getPrCiDotColor,
  getPrReviewDotColor,
  getPrReviewsBadge,
  getPrStateBadge,
  InlinePrBadge
} from "../../prs/shared/prVisuals";
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
  let statusColor: string;
  if (data.status === "conflict-active" || data.status === "conflict-predicted") {
    statusColor = "text-red-300";
  } else if (data.status === "behind-base") {
    statusColor = "text-amber-300";
  } else if (data.status === "merge-ready") {
    statusColor = "text-emerald-300";
  } else {
    statusColor = "text-muted-fg";
  }
  const prStateBadge = pr ? getPrStateBadge(pr.state) : null;
  const prChecksBadge = pr ? getPrChecksBadge(pr.checksStatus) : null;
  const prReviewsBadge = pr ? getPrReviewsBadge(pr.reviewStatus) : null;
  const ciDotColor = pr ? getPrCiDotColor(pr) : null;
  const reviewDotColor = pr ? getPrReviewDotColor(pr) : null;

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
      {data.integrationSources.length > 0 ? (
        <div className="mt-1">
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
      {pr ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <InlinePrBadge {...prStateBadge!} />
          <InlinePrBadge {...prChecksBadge!} />
          <InlinePrBadge {...prReviewsBadge!} />
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              pr.activityState === "active" && "ade-pr-badge-pulse"
            )}
            style={{
              color: ciDotColor!,
              borderColor: `${ciDotColor}40`,
              background: `${ciDotColor}14`
            }}
            title={`CI status: ${pr.checksStatus}`}
          >
            <span
              className={cn("h-1.5 w-1.5 rounded-full", pr.pendingCheckCount > 0 && "ade-pr-ci-pending")}
              style={{ background: ciDotColor! }}
            />
            {pr.pendingCheckCount > 0 ? `${pr.pendingCheckCount} RUNNING` : pr.checksStatus}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              pr.activityState === "active" && "ade-pr-badge-pulse"
            )}
            style={{
              color: reviewDotColor!,
              borderColor: `${reviewDotColor}40`,
              background: `${reviewDotColor}14`
            }}
            title={`${pr.reviewCount} total reviews`}
          >
            <CheckCircle size={10} weight="fill" />
            {pr.reviewCount}
          </span>
          <span
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{
              color: COLORS.info,
              borderColor: `${COLORS.info}40`,
              background: `${COLORS.info}14`
            }}
            title={`${pr.commentCount} total comments`}
          >
            <ChatText size={10} weight="fill" />
            {pr.commentCount}
          </span>
          {pr.activityState === "stale" ? (
            <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-fg">
              <ClockCounterClockwise size={10} />
              stale
            </span>
          ) : null}
        </div>
      ) : null}
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
