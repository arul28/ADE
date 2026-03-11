import React from "react";
import { ArrowSquareOut, GitMerge } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { LaneSummary } from "../../../shared/types";
import type { IntegrationLaneSource } from "../../lib/integrationLanes";
import { COLORS, LABEL_STYLE, MONO_FONT, outlineButton } from "./laneDesignTokens";

const TREE_ROW_H = 28;
const TREE_INDENT = 22;
const TREE_LEFT_PAD = 16;
const TREE_DOT_R = 4;

type TreeNodeLayout = {
  lane: LaneSummary;
  row: number;
  depth: number;
  dotX: number;
  dotY: number;
};

type LaneRuntimeBucket = "running" | "awaiting-input" | "ended" | "none";
type LaneRuntimeMap = Map<string, { bucket: LaneRuntimeBucket }>;

function LaneRuntimeDot({ bucket }: { bucket: LaneRuntimeBucket }): React.ReactElement {
  if (bucket === "running") {
    return (
      <span
        className="shrink-0 animate-spin"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          border: `1.5px solid ${COLORS.success}`,
          borderTopColor: "transparent",
        }}
        title="Running"
      />
    );
  }
  if (bucket === "awaiting-input") {
    return (
      <span
        className="shrink-0 animate-spin"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          border: `1.5px solid ${COLORS.warning}`,
          borderTopColor: "transparent",
        }}
        title="Awaiting input"
      />
    );
  }
  if (bucket === "ended") {
    return (
      <span
        className="shrink-0"
        style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger }}
        title="Ended"
      />
    );
  }
  return <span className="shrink-0" style={{ width: 8, height: 8 }} />;
}

function StackGraph({
  lanes,
  selectedLaneId,
  onSelect,
  runtimeByLaneId,
  integrationSourcesByLaneId,
}: {
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  onSelect: (id: string) => void;
  runtimeByLaneId: LaneRuntimeMap;
  integrationSourcesByLaneId: Map<string, IntegrationLaneSource[]>;
}) {
  const layout = React.useMemo(() => {
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
    const primaryId = primary?.id ?? null;

    const parentById = new Map<string, string | null>();
    for (const lane of lanes) {
      if (lane.laneType === "primary") {
        parentById.set(lane.id, null);
        continue;
      }
      const parent =
        lane.parentLaneId && laneById.has(lane.parentLaneId)
          ? lane.parentLaneId
          : primaryId;
      parentById.set(lane.id, parent ?? null);
    }

    const depthMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const depthFor = (laneId: string): number => {
      if (depthMemo.has(laneId)) return depthMemo.get(laneId)!;
      if (visiting.has(laneId)) return 0;
      visiting.add(laneId);
      const lane = laneById.get(laneId);
      if (!lane) {
        visiting.delete(laneId);
        depthMemo.set(laneId, 0);
        return 0;
      }
      if (lane.laneType === "primary") {
        visiting.delete(laneId);
        depthMemo.set(laneId, 0);
        return 0;
      }
      const parent = parentById.get(laneId) ?? null;
      const depth = parent ? depthFor(parent) + 1 : 0;
      visiting.delete(laneId);
      depthMemo.set(laneId, depth);
      return depth;
    };

    return lanes.map((lane, idx) => {
      const depth = depthFor(lane.id);
      return {
        lane,
        row: idx,
        depth,
        dotX: TREE_LEFT_PAD + depth * TREE_INDENT,
        dotY: idx * TREE_ROW_H + TREE_ROW_H / 2
      } satisfies TreeNodeLayout;
    });
  }, [lanes]);
  const layoutById = React.useMemo(() => new Map(layout.map((n) => [n.lane.id, n])), [layout]);

  const totalHeight = layout.length * TREE_ROW_H + 4;

  const childrenByParent = React.useMemo(() => {
    const map = new Map<string, TreeNodeLayout[]>();
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
    const primaryId = primary?.id ?? null;
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    for (const node of layout) {
      const parentId =
        node.lane.laneType === "primary"
          ? null
          : node.lane.parentLaneId && laneById.has(node.lane.parentLaneId)
            ? node.lane.parentLaneId
            : primaryId;
      if (!parentId) continue;
      const arr = map.get(parentId) ?? [];
      arr.push(node);
      map.set(parentId, arr);
    }
    return map;
  }, [layout, lanes]);

  const connectors: React.ReactNode[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = layoutById.get(parentId);
    if (!parent || children.length === 0) continue;

    const lastChild = children[children.length - 1]!;

    connectors.push(
      <line
        key={`v:${parentId}`}
        x1={parent.dotX}
        y1={parent.dotY + TREE_DOT_R + 2}
        x2={parent.dotX}
        y2={lastChild.dotY}
        stroke={COLORS.border}
        strokeWidth={1.5}
      />
    );

    for (const child of children) {
      connectors.push(
        <line
          key={`h:${child.lane.id}`}
          x1={parent.dotX}
          y1={child.dotY}
          x2={child.dotX - TREE_DOT_R - 3}
          y2={child.dotY}
          stroke={COLORS.border}
          strokeWidth={1.5}
        />
      );
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="relative py-1" style={{ height: totalHeight, minWidth: "100%" }}>
        <svg className="absolute inset-0 pointer-events-none" width="100%" height={totalHeight}>
          {connectors}
          {layout.map((node) => (
            <circle
              key={`dot:${node.lane.id}`}
              cx={node.dotX}
              cy={node.dotY}
              r={TREE_DOT_R}
              fill={
                node.lane.laneType === "primary"
                  ? COLORS.accent
                  : node.lane.status.dirty
                    ? COLORS.warning
                    : COLORS.info
              }
            />
          ))}
        </svg>

        {layout.map((node) => {
          const { lane } = node;
          const integrationSources = integrationSourcesByLaneId.get(lane.id) ?? [];
          const isSelected = selectedLaneId === lane.id;
          return (
            <button
              key={`label:${lane.id}`}
              type="button"
              className="absolute flex items-center gap-1.5 transition-all duration-150 whitespace-nowrap"
              style={{
                left: node.dotX + TREE_DOT_R + 5,
                top: node.dotY - (TREE_ROW_H - 6) / 2,
                height: TREE_ROW_H - 6,
                padding: "0 6px",
                background: isSelected ? COLORS.accentSubtle : "transparent",
                color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                border: "none",
                cursor: "pointer",
              }}
              onClick={() => onSelect(lane.id)}
              title={
                integrationSources.length > 0
                  ? `Integration lane fed by ${integrationSources.map((source) => source.laneName).join(", ")}`
                  : lane.parentLaneId
                  ? `Child of ${layoutById.get(lane.parentLaneId)?.lane.name ?? "parent"}`
                  : lane.laneType === "primary"
                    ? "Primary lane"
                    : "Based on primary"
              }
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = COLORS.hoverBg;
                  e.currentTarget.style.color = COLORS.textPrimary;
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = COLORS.textMuted;
                }
              }}
            >
              <LaneRuntimeDot bucket={runtimeByLaneId.get(lane.id)?.bucket ?? "none"} />
              <span className="truncate" style={{
                maxWidth: integrationSources.length > 0 ? 120 : 160,
                fontFamily: MONO_FONT,
                fontSize: 11,
                fontWeight: isSelected ? 600 : 500,
              }}>{lane.name}</span>
              {integrationSources.length > 0 ? (
                <span
                  className="inline-flex items-center gap-1 rounded border px-1 py-0 text-[9px] uppercase tracking-[0.08em]"
                  style={{
                    color: "#C4B5FD",
                    borderColor: "rgba(167,139,250,0.35)",
                    background: "rgba(167,139,250,0.10)",
                  }}
                >
                  <GitMerge size={9} weight="bold" />
                  {integrationSources.length}
                </span>
              ) : null}
              <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }} className="shrink-0">
                {lane.status.ahead}\u2191 {lane.status.behind}\u2193
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LaneStackPane({
  lanes,
  selectedLaneId,
  onSelect,
  runtimeByLaneId,
  integrationSourcesByLaneId,
}: {
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  onSelect: (id: string) => void;
  runtimeByLaneId: LaneRuntimeMap;
  integrationSourcesByLaneId?: Map<string, IntegrationLaneSource[]>;
}) {
  const navigate = useNavigate();
  const effectiveIntegrationSourcesByLaneId = React.useMemo(
    () => integrationSourcesByLaneId ?? new Map<string, IntegrationLaneSource[]>(),
    [integrationSourcesByLaneId],
  );
  const selectedIntegrationSources = React.useMemo(() => {
    if (!selectedLaneId) return [];
    return effectiveIntegrationSourcesByLaneId.get(selectedLaneId) ?? [];
  }, [effectiveIntegrationSourcesByLaneId, selectedLaneId]);

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      <div
        className="shrink-0 flex items-center justify-between"
        style={{ height: 36, padding: "0 16px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}
      >
        <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>STACK GRAPH</span>
        <button
          type="button"
          style={outlineButton({ height: 24, gap: 4, padding: "4px 8px", fontSize: 10, fontWeight: 500, color: COLORS.textMuted })}
          onClick={() => navigate("/graph")}
          title="Open workspace canvas"
        >
          <ArrowSquareOut size={12} />
          CANVAS
        </button>
      </div>
      {selectedIntegrationSources.length > 0 ? (
        <div
          className="shrink-0"
          style={{
            padding: "10px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: "rgba(167,139,250,0.08)",
          }}
        >
          <div
            className="mb-2 flex items-center gap-2"
            style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#C4B5FD" }}
          >
            <GitMerge size={12} weight="bold" />
            INTEGRATION LANE
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selectedIntegrationSources.map((source) => (
              <span
                key={source.laneId}
                className="rounded border px-2 py-0.5 text-[10px] font-medium"
                style={{
                  color: "#E9D5FF",
                  borderColor: "rgba(167,139,250,0.35)",
                  background: "rgba(167,139,250,0.12)",
                }}
              >
                {source.laneName}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <StackGraph
        lanes={lanes}
        selectedLaneId={selectedLaneId}
        onSelect={onSelect}
        runtimeByLaneId={runtimeByLaneId}
        integrationSourcesByLaneId={effectiveIntegrationSourcesByLaneId}
      />
    </div>
  );
}
