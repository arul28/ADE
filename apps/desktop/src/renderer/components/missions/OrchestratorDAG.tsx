import React, { useMemo, useState } from "react";
import type { OrchestratorStep, OrchestratorAttempt } from "../../../shared/types";
import { cn } from "../ui/cn";

type Props = {
  steps: OrchestratorStep[];
  attempts: OrchestratorAttempt[];
  onStepClick?: (stepId: string) => void;
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  ready: "#3b82f6",
  running: "#8b5cf6",
  succeeded: "#22c55e",
  failed: "#ef4444",
  blocked: "#f59e0b",
  skipped: "#9ca3af",
  canceled: "#6b7280",
};

const PHASE_TINT: Record<string, string> = {
  analysis: "rgba(59, 130, 246, 0.06)",
  code: "rgba(139, 92, 246, 0.06)",
  implementation: "rgba(139, 92, 246, 0.06)",
  test: "rgba(6, 182, 212, 0.06)",
  validation: "rgba(6, 182, 212, 0.06)",
  review: "rgba(245, 158, 11, 0.06)",
  integration: "rgba(16, 185, 129, 0.06)",
  merge: "rgba(236, 72, 153, 0.06)",
  command: "rgba(168, 85, 247, 0.06)",
};

const MERGE_NODE_KINDS = new Set(["merge", "integration"]);

function getPhaseKind(step: OrchestratorStep): string {
  const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : "";
  const taskType = typeof step.metadata?.taskType === "string" ? step.metadata.taskType : "";
  return stepType || taskType || "";
}

const NODE_W = 160;
const NODE_H = 60;
const GAP_Y = 20;
const GAP_X = 100;
const PADDING = 20;

type LayoutNode = {
  step: OrchestratorStep;
  col: number;
  row: number;
  x: number;
  y: number;
  attemptCount: number;
};

function computeLayout(steps: OrchestratorStep[], attemptsByStep: Map<string, number>): LayoutNode[] {
  if (steps.length === 0) return [];

  // Build adjacency: stepId → step
  const stepMap = new Map<string, OrchestratorStep>();
  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  // Compute depth (column) via topological BFS
  const depthMap = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    if (!dependents.has(step.id)) dependents.set(step.id, []);
    for (const depId of step.dependencyStepIds) {
      const list = dependents.get(depId) ?? [];
      list.push(step.id);
      dependents.set(depId, list);
    }
  }

  // Roots have no dependencies
  const roots = steps.filter((s) => s.dependencyStepIds.length === 0);
  const queue: Array<{ id: string; depth: number }> = roots.map((s) => ({ id: s.id, depth: 0 }));
  let maxDepth = 0;

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const existing = depthMap.get(id);
    if (existing !== undefined && existing >= depth) continue;
    depthMap.set(id, depth);
    if (depth > maxDepth) maxDepth = depth;

    for (const childId of dependents.get(id) ?? []) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }

  // For steps not reached (cycles or disconnected), assign depth 0
  for (const step of steps) {
    if (!depthMap.has(step.id)) depthMap.set(step.id, 0);
  }

  // Group by column
  const columns = new Map<number, OrchestratorStep[]>();
  for (const step of steps) {
    const col = depthMap.get(step.id) ?? 0;
    const list = columns.get(col) ?? [];
    list.push(step);
    columns.set(col, list);
  }

  // Layout nodes
  const nodes: LayoutNode[] = [];
  for (let col = 0; col <= maxDepth; col++) {
    const colSteps = columns.get(col) ?? [];
    colSteps.sort((a, b) => a.stepIndex - b.stepIndex);
    for (let row = 0; row < colSteps.length; row++) {
      const step = colSteps[row];
      nodes.push({
        step,
        col,
        row,
        x: PADDING + col * (NODE_W + GAP_X),
        y: PADDING + row * (NODE_H + GAP_Y),
        attemptCount: attemptsByStep.get(step.id) ?? 0,
      });
    }
  }

  return nodes;
}

function truncateTitle(title: string, maxLen = 18): string {
  return title.length > maxLen ? title.slice(0, maxLen - 1) + "\u2026" : title;
}

export function OrchestratorDAG({ steps, attempts, onStepClick }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const attemptsByStep = useMemo(() => {
    const map = new Map<string, number>();
    for (const attempt of attempts) {
      map.set(attempt.stepId, (map.get(attempt.stepId) ?? 0) + 1);
    }
    return map;
  }, [attempts]);

  const nodes = useMemo(() => computeLayout(steps, attemptsByStep), [steps, attemptsByStep]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const node of nodes) map.set(node.step.id, node);
    return map;
  }, [nodes]);

  // Compute SVG dimensions
  const svgWidth = useMemo(() => {
    if (nodes.length === 0) return 300;
    return Math.max(...nodes.map((n) => n.x + NODE_W)) + PADDING;
  }, [nodes]);

  const svgHeight = useMemo(() => {
    if (nodes.length === 0) return 100;
    return Math.max(...nodes.map((n) => n.y + NODE_H)) + PADDING;
  }, [nodes]);

  // Compute edges
  const edges = useMemo(() => {
    const result: Array<{
      fromId: string;
      toId: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      satisfied: boolean;
    }> = [];

    for (const node of nodes) {
      for (const depId of node.step.dependencyStepIds) {
        const depNode = nodeMap.get(depId);
        if (!depNode) continue;
        const fromStep = depNode.step;
        const satisfied = fromStep.status === "succeeded";
        result.push({
          fromId: depId,
          toId: node.step.id,
          x1: depNode.x + NODE_W,
          y1: depNode.y + NODE_H / 2,
          x2: node.x,
          y2: node.y + NODE_H / 2,
          satisfied,
        });
      }
    }
    return result;
  }, [nodes, nodeMap]);

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center rounded border border-border/20 bg-card/60 p-6 text-xs text-muted-fg">
        No steps to display
      </div>
    );
  }

  return (
    <div
      className="overflow-auto rounded border border-border/20 bg-card/60"
      style={{ perspective: '1200px', perspectiveOrigin: '50% 40%' }}
    >
      <svg
        style={{ transformStyle: 'preserve-3d' }}
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="block"
      >
        {/* Edge lines */}
        {edges.map((edge) => {
          const midX = (edge.x1 + edge.x2) / 2;
          return (
            <path
              key={`${edge.fromId}-${edge.toId}`}
              d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
              fill="none"
              stroke={edge.satisfied ? "#22c55e" : "#6b7280"}
              strokeWidth={1.5}
              strokeDasharray={edge.satisfied ? "none" : "4 3"}
              opacity={0.6}
            />
          );
        })}

        {/* Step nodes */}
        {nodes.map((node) => {
          const statusColor = STATUS_COLORS[node.step.status] ?? "#6b7280";
          const isRunning = node.step.status === "running";
          const isHovered = hoveredId === node.step.id;
          const phaseKind = getPhaseKind(node.step);
          const phaseTint = PHASE_TINT[phaseKind] ?? "transparent";
          const isMergeNode = MERGE_NODE_KINDS.has(phaseKind);
          const isGateNode = phaseKind === "review" || phaseKind === "validation";

          const isFailed = node.step.status === "failed";
          const isSucceeded = node.step.status === "succeeded";

          return (
            <g
              key={node.step.id}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onStepClick?.(node.step.id)}
              onMouseEnter={() => setHoveredId(node.step.id)}
              onMouseLeave={() => setHoveredId(null)}
              className="cursor-pointer"
              style={{
                transformStyle: 'preserve-3d',
                transition: 'transform 200ms ease',
                transform: isHovered ? 'translateZ(10px) scale(1.05)' : 'none'
              }}
            >
              {/* Running: spinning ring (thin blue border, 4s rotation) */}
              {isRunning && (
                <g>
                  <rect
                    x={-3}
                    y={-3}
                    width={NODE_W + 6}
                    height={NODE_H + 6}
                    rx={11}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={1.5}
                    strokeDasharray="12 8"
                    opacity={0.7}
                  >
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from={`0 ${(NODE_W + 6) / 2} ${(NODE_H + 6) / 2}`}
                      to={`360 ${(NODE_W + 6) / 2} ${(NODE_H + 6) / 2}`}
                      dur="4s"
                      repeatCount="indefinite"
                    />
                  </rect>
                  <rect
                    x={-2}
                    y={-2}
                    width={NODE_W + 4}
                    height={NODE_H + 4}
                    rx={10}
                    fill="none"
                    stroke={statusColor}
                    strokeWidth={2}
                    opacity={0.4}
                  >
                    <animate
                      attributeName="opacity"
                      values="0.4;0.1;0.4"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  </rect>
                </g>
              )}

              {/* Phase tint background */}
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={phaseTint}
              />

              {/* Node background — diamond shape for gates, regular for others */}
              {isGateNode ? (
                <rect
                  x={4}
                  y={4}
                  width={NODE_W - 8}
                  height={NODE_H - 8}
                  rx={4}
                  fill={isHovered ? "var(--color-muted)" : "var(--color-card)"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  strokeDasharray="4 2"
                  opacity={0.9}
                />
              ) : isMergeNode ? (
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={NODE_H / 2}
                  fill={isHovered ? "var(--color-muted)" : "var(--color-card)"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  opacity={0.9}
                />
              ) : (
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill={isHovered ? "var(--color-muted)" : "var(--color-card)"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  opacity={0.9}
                />
              )}

              {/* Status indicator bar at top */}
              <rect
                x={8}
                y={0}
                width={NODE_W - 16}
                height={3}
                rx={1.5}
                fill={statusColor}
              />

              {/* Title text */}
              <text
                x={NODE_W / 2}
                y={26}
                textAnchor="middle"
                fill="var(--color-fg)"
                fontSize={11}
                fontWeight={500}
              >
                {truncateTitle(node.step.title)}
              </text>

              {/* Status text */}
              <text
                x={NODE_W / 2}
                y={42}
                textAnchor="middle"
                fill={statusColor}
                fontSize={9}
                fontWeight={400}
              >
                {node.step.status}
              </text>

              {/* Completed: green check icon */}
              {isSucceeded && (
                <g transform={`translate(${NODE_W - 18}, 2)`}>
                  <circle cx={7} cy={7} r={7} fill="#22c55e" opacity={0.2} />
                  <text x={7} y={11} textAnchor="middle" fill="#22c55e" fontSize={10} fontWeight={700}>{"\u2713"}</text>
                </g>
              )}

              {/* Failed: red X icon */}
              {isFailed && (
                <g transform={`translate(${NODE_W - 18}, 2)`}>
                  <circle cx={7} cy={7} r={7} fill="#ef4444" opacity={0.2} />
                  <text x={7} y={11} textAnchor="middle" fill="#ef4444" fontSize={10} fontWeight={700}>{"\u2717"}</text>
                </g>
              )}

              {/* Attempt count badge */}
              {node.attemptCount > 0 && (
                <g transform={`translate(${NODE_W - 16}, ${NODE_H - 16})`}>
                  <rect
                    width={20}
                    height={14}
                    rx={7}
                    fill={statusColor}
                    opacity={0.2}
                  />
                  <text
                    x={10}
                    y={10}
                    textAnchor="middle"
                    fill={statusColor}
                    fontSize={9}
                    fontWeight={600}
                  >
                    {node.attemptCount}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
