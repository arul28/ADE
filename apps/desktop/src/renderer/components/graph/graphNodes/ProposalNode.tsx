import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import { GitMerge } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { proposalOutcomeColor } from "../graphHelpers";
import type { GraphNodeData } from "../graphTypes";

export function GraphProposalNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const borderColor = proposalOutcomeColor(data.proposalOutcome);
  const visibleIntegrationSources = data.integrationSources.slice(0, 3);
  const hiddenIntegrationSourceCount = Math.max(0, data.integrationSources.length - visibleIntegrationSources.length);
  const minHeight = data.integrationSources.length > 2 ? 112 : 96;
  return (
    <div
      className={cn(
        "group relative rounded-lg border-2 border-dashed bg-card/90 px-2 py-1.5 text-[11px] shadow-sm transition-all duration-150",
        selected && "ring-2 ring-accent",
        data.dimmed && "opacity-30",
        data.highlight && "shadow-[0_2px_8px_rgba(0,0,0,0.2)]"
      )}
      style={{ width: 220, minHeight, borderColor }}
    >
      <div className="flex items-center justify-between gap-1">
        <span
          className="inline-flex items-center rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: borderColor, backgroundColor: `${borderColor}1f`, border: `1px solid ${borderColor}55` }}
        >
          PROPOSED
        </span>
        {data.proposalOutcome ? (
          <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: borderColor }}>
            {data.proposalOutcome}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-1 text-fg">
        <GitMerge size={14} weight="bold" style={{ color: borderColor }} />
        <span className="truncate font-semibold">{data.lane.name}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-fg">{data.lane.baseRef}</div>
      {data.integrationSources.length > 0 ? (
        <div className="mt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em]" style={{ color: borderColor }}>
            Fed By
          </div>
          <div className="flex flex-wrap gap-1">
            {visibleIntegrationSources.map((source) => (
              <span
                key={source.laneId}
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{ color: borderColor, borderColor: `${borderColor}55`, backgroundColor: `${borderColor}18` }}
                title={source.laneName}
              >
                {source.laneName}
              </span>
            ))}
            {hiddenIntegrationSourceCount > 0 ? (
              <span
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{ color: borderColor, borderColor: `${borderColor}40`, backgroundColor: `${borderColor}12` }}
                title={`${hiddenIntegrationSourceCount} more source lanes`}
              >
                +{hiddenIntegrationSourceCount}
              </span>
            ) : null}
          </div>
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
