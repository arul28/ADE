import React, { useMemo, useState } from "react";
import dagre from "dagre";
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

const BASE_NODE_W = 160;
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
  nodeW: number;
};

function computeLayout(steps: OrchestratorStep[], attemptsByStep: Map<string, number>, maxDepth: { value: number }): LayoutNode[] {
  if (steps.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: GAP_Y, ranksep: GAP_X, marginx: PADDING, marginy: PADDING });
  g.setDefaultEdgeLabel(() => ({}));

  const stepMap = new Map<string, OrchestratorStep>();
  for (const step of steps) {
    stepMap.set(step.id, step);
    g.setNode(step.id, { width: BASE_NODE_W, height: NODE_H });
  }

  for (const step of steps) {
    for (const depId of step.dependencyStepIds) {
      if (stepMap.has(depId)) {
        g.setEdge(depId, step.id);
      }
    }
  }

  dagre.layout(g);

  const nodes: LayoutNode[] = [];
  let mDepth = 0;

  for (const step of steps) {
    const node = g.node(step.id);
    if (!node) continue;

    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    const col = Math.round(x / (BASE_NODE_W + GAP_X));
    if (col > mDepth) mDepth = col;

    nodes.push({
      step,
      col,
      row: 0,
      x,
      y,
      attemptCount: attemptsByStep.get(step.id) ?? 0,
      nodeW: BASE_NODE_W,
    });
  }

  maxDepth.value = mDepth;
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

  const maxDepthRef = useMemo(() => ({ value: 0 }), []);
  const nodes = useMemo(() => computeLayout(steps, attemptsByStep, maxDepthRef), [steps, attemptsByStep, maxDepthRef]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const node of nodes) map.set(node.step.id, node);
    return map;
  }, [nodes]);

  // Compute SVG dimensions
  const svgWidth = useMemo(() => {
    if (nodes.length === 0) return 300;
    return Math.max(...nodes.map((n) => n.x + n.nodeW)) + PADDING;
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
          x1: depNode.x + depNode.nodeW,
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
      <div
        className="flex items-center justify-center p-6"
        style={{ border: "1px solid #1E1B26", background: "#13101A", color: "#71717A", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px" }}
      >
        No steps to display
      </div>
    );
  }

  return (
    <div
      className="overflow-auto"
      style={{ perspective: '1200px', perspectiveOrigin: '50% 40%', border: "1px solid #1E1B26", background: "#13101A" }}
    >
      {/* Inline style for flow animation */}
      <style>{`
        @keyframes ade-flow-dash {
          to { stroke-dashoffset: -14; }
        }
      `}</style>
      <svg
        style={{ transformStyle: 'preserve-3d' }}
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="block"
      >
        {/* Edge lines with animated flow */}
        {edges.map((edge) => {
          const midX = (edge.x1 + edge.x2) / 2;
          return (
            <g key={`${edge.fromId}-${edge.toId}`}>
              {/* Base edge */}
              <path
                d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
                fill="none"
                stroke={edge.satisfied ? "#22c55e" : "#6b7280"}
                strokeWidth={1.5}
                opacity={0.4}
              />
              {/* Animated dash overlay for unsatisfied edges */}
              {!edge.satisfied && (
                <path
                  d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
                  fill="none"
                  stroke="#6b7280"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  opacity={0.6}
                  style={{ animation: 'ade-flow-dash 1.5s linear infinite' }}
                />
              )}
              {/* Animated flow for satisfied edges */}
              {edge.satisfied && (
                <path
                  d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={1.5}
                  strokeDasharray="6 8"
                  opacity={0.7}
                  style={{ animation: 'ade-flow-dash 1.5s linear infinite' }}
                />
              )}
            </g>
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
          const nodeW = node.nodeW;

          return (
            <g
              key={node.step.id}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onStepClick?.(node.step.id)}
              onMouseEnter={() => setHoveredId(node.step.id)}
              onMouseLeave={() => setHoveredId(null)}
              className={cn("cursor-pointer", isFailed && "ade-node-failed-pulse")}
              style={{
                transformStyle: 'preserve-3d',
                transition: 'transform 200ms ease',
                transform: isHovered ? 'translateZ(10px) scale(1.05)' : 'none'
              }}
            >
              {/* Running: spinning ring (thin blue border, 4s rotation) */}
              {isRunning && (
                <g className="ade-spin-4s" style={{ transformOrigin: `${nodeW / 2}px ${NODE_H / 2}px` }}>
                  <rect
                    x={-3}
                    y={-3}
                    width={nodeW + 6}
                    height={NODE_H + 6}
                    rx={0}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={1.5}
                    strokeDasharray="12 8"
                    opacity={0.7}
                  />
                </g>
              )}

              {/* Running glow pulse */}
              {isRunning && (
                <rect
                  x={-2}
                  y={-2}
                  width={nodeW + 4}
                  height={NODE_H + 4}
                  rx={0}
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
              )}

              {/* Phase tint background */}
              <rect
                width={nodeW}
                height={NODE_H}
                rx={0}
                fill={phaseTint}
              />

              {/* Node background -- diamond shape for gates, regular for others */}
              {isGateNode ? (
                <rect
                  x={4}
                  y={4}
                  width={nodeW - 8}
                  height={NODE_H - 8}
                  rx={0}
                  fill={isHovered ? "#1A1720" : "#13101A"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  strokeDasharray="4 2"
                  opacity={0.9}
                />
              ) : isMergeNode ? (
                <rect
                  width={nodeW}
                  height={NODE_H}
                  rx={0}
                  fill={isHovered ? "#1A1720" : "#13101A"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  opacity={0.9}
                />
              ) : (
                <rect
                  width={nodeW}
                  height={NODE_H}
                  rx={0}
                  fill={isHovered ? "#1A1720" : "#13101A"}
                  stroke={statusColor}
                  strokeWidth={isHovered ? 2 : 1.5}
                  opacity={0.9}
                />
              )}

              {/* Status indicator bar at top */}
              <rect
                x={8}
                y={0}
                width={nodeW - 16}
                height={3}
                rx={0}
                fill={statusColor}
              />

              {/* Title text */}
              <text
                x={nodeW / 2}
                y={26}
                textAnchor="middle"
                fill="#FAFAFA"
                fontSize={11}
                fontWeight={500}
                fontFamily="'Space Grotesk', sans-serif"
              >
                {truncateTitle(node.step.title)}
              </text>

              {/* Status text */}
              <text
                x={nodeW / 2}
                y={42}
                textAnchor="middle"
                fill={statusColor}
                fontSize={9}
                fontWeight={400}
                fontFamily="JetBrains Mono, monospace"
              >
                {node.step.status}
              </text>

              {/* Completed: animated checkmark SVG */}
              {isSucceeded && (
                <g transform={`translate(${nodeW - 20}, 2)`}>
                  <circle cx={8} cy={8} r={8} fill="#22c55e" opacity={0.2} />
                  <path
                    d="M5 8.5 L7.5 11 L11.5 6"
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="12"
                    strokeDashoffset="12"
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from="12"
                      to="0"
                      dur="0.5s"
                      fill="freeze"
                    />
                  </path>
                </g>
              )}

              {/* Failed: red X icon with pulse */}
              {isFailed && (
                <g transform={`translate(${nodeW - 20}, 2)`}>
                  <circle cx={8} cy={8} r={8} fill="#ef4444" opacity={0.2}>
                    <animate
                      attributeName="opacity"
                      values="0.2;0.5;0.2"
                      dur="1s"
                      repeatCount="3"
                    />
                  </circle>
                  <path
                    d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                </g>
              )}

              {/* Attempt count badge */}
              {node.attemptCount > 0 && (
                <g transform={`translate(${nodeW - 16}, ${NODE_H - 16})`}>
                  <rect
                    width={20}
                    height={14}
                    rx={0}
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
                    fontFamily="JetBrains Mono, monospace"
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
