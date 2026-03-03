import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import dagre from "dagre";
import type { OrchestratorStep, OrchestratorAttempt, OrchestratorClaim, DagMutationEvent } from "../../../shared/types";
import { cn } from "../ui/cn";
import { relativeWhen, formatTime } from "../../lib/format";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type Props = {
  steps: OrchestratorStep[];
  attempts: OrchestratorAttempt[];
  claims?: OrchestratorClaim[];
  selectedStepId?: string | null;
  onStepClick?: (stepId: string) => void;
  runId?: string;
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  ready: "#3b82f6",
  running: "#8b5cf6",
  succeeded: "#22c55e",
  failed: "#ef4444",
  blocked: "#f59e0b",
  skipped: "#9ca3af",
  superseded: "#f59e0b",
  canceled: "#6b7280",
};

const PHASE_TINT: Record<string, string> = {
  analysis: "rgba(59, 130, 246, 0.06)",
  code: "rgba(139, 92, 246, 0.06)",
  implementation: "rgba(139, 92, 246, 0.06)",
  test: "rgba(6, 182, 212, 0.06)",
  validation: "rgba(6, 182, 212, 0.06)",
  milestone: "rgba(167, 139, 250, 0.14)",
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function resolveMilestoneValidationCriteria(step: OrchestratorStep): string | null {
  const meta = asRecord(step.metadata);
  if (!meta) return null;

  const doneCriteria = typeof meta.doneCriteria === "string" ? meta.doneCriteria.trim() : "";
  if (doneCriteria.length > 0) return doneCriteria;

  const contract = asRecord(meta.validationContract);
  const contractCriteria = typeof contract?.criteria === "string" ? contract.criteria.trim() : "";
  if (contractCriteria.length > 0) return contractCriteria;

  const planStep = asRecord(meta.planStep);
  const outputContract = asRecord(planStep?.outputContract);
  const completionCriteria = typeof outputContract?.completionCriteria === "string"
    ? outputContract.completionCriteria.trim()
    : "";
  if (completionCriteria.length > 0) return completionCriteria;

  return null;
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

type NodeAnimState = "entering" | "exiting" | "splitting" | "normal";

/** A tracked DAG mutation for the mini-timeline. */
type MutationEntry = {
  id: string;
  mutation: DagMutationEvent["mutation"];
  timestamp: string;
  source: DagMutationEvent["source"];
};

const MUTATION_ICONS: Record<string, string> = {
  step_added: "+",
  step_skipped: "~",
  steps_merged: "M",
  step_split: "/",
  dependency_changed: "->",
  status_changed: "*",
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

/** Produce a short human description for a mutation. */
function describeMutation(m: DagMutationEvent["mutation"]): string {
  switch (m.type) {
    case "step_added":
      return `Added step '${m.step.title}'`;
    case "step_skipped":
      return `Skipped '${m.stepKey}' (${m.reason})`;
    case "steps_merged":
      return `Merged ${m.sourceKeys.join(", ")} -> '${m.targetStep.title}'`;
    case "step_split":
      return `Split '${m.sourceKey}' into ${m.children.length} steps`;
    case "dependency_changed":
      return `Deps changed for '${m.stepKey}'`;
    case "status_changed":
      return `'${m.stepKey}' -> ${m.newStatus}`;
  }
}

/** Resolve the most recent heartbeat for a step from its claims. */
function resolveHeartbeatForStep(stepId: string, stepAttemptIds: Set<string>, claims: OrchestratorClaim[]): string | null {
  const relevant = claims.filter((c) => c.stepId === stepId || (c.attemptId ? stepAttemptIds.has(c.attemptId) : false));
  if (!relevant.length) return null;
  return [...relevant].sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))[0]?.heartbeatAt ?? null;
}

type TooltipInfo = {
  title: string;
  status: string;
  heartbeat: string;
  stepKey: string;
  validationCriteria: string | null;
  x: number;
  y: number;
};

const MAX_TIMELINE_ENTRIES = 8;

export const OrchestratorDAG = React.memo(function OrchestratorDAG({ steps, attempts, claims, selectedStepId, onStepClick, runId }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Reactive mutation state ---
  const [mutations, setMutations] = useState<MutationEntry[]>([]);
  const [nodeAnimStates, setNodeAnimStates] = useState<Map<string, NodeAnimState>>(new Map());
  const [flashedEdges, setFlashedEdges] = useState<Set<string>>(new Set());

  const mutationCount = mutations.length;

  // Clear animation states after their durations expire.
  const clearAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMutation = useCallback((event: DagMutationEvent) => {
    const m = event.mutation;
    setNodeAnimStates((prev) => {
      const next = new Map(prev);
      switch (m.type) {
        case "step_added":
          next.set(m.step.id, "entering");
          break;
        case "step_skipped": {
          // Find by stepKey since we may not have the step id directly
          const found = steps.find((s) => s.stepKey === m.stepKey);
          if (found) next.set(found.id, "exiting");
          break;
        }
        case "steps_merged": {
          // The target step enters, source steps exit
          next.set(m.targetStep.id, "entering");
          for (const srcKey of m.sourceKeys) {
            const found = steps.find((s) => s.stepKey === srcKey);
            if (found && found.id !== m.targetStep.id) next.set(found.id, "exiting");
          }
          break;
        }
        case "step_split": {
          for (const child of m.children) {
            next.set(child.id, "splitting");
          }
          break;
        }
        case "dependency_changed": {
          const found = steps.find((s) => s.stepKey === m.stepKey);
          if (found) {
            setFlashedEdges((prevE) => {
              const nextE = new Set(prevE);
              for (const dep of m.newDeps) {
                nextE.add(`${dep}->${m.stepKey}`);
              }
              return nextE;
            });
          }
          break;
        }
      }
      return next;
    });

    // Auto-clear animations after 2s
    if (clearAnimTimer.current) clearTimeout(clearAnimTimer.current);
    clearAnimTimer.current = setTimeout(() => {
      setNodeAnimStates(new Map());
      setFlashedEdges(new Set());
    }, 2000);
  }, [steps]);

  // Subscribe to DagMutationEvent from IPC
  useEffect(() => {
    if (!runId) return;
    const cleanup = window.ade.orchestrator.onDagMutation((event) => {
      if (event.runId !== runId) return;
      setMutations((prev) => {
        const next = [...prev, {
          id: `${event.timestamp}-${event.mutation.type}`,
          mutation: event.mutation,
          timestamp: event.timestamp,
          source: event.source,
        }];
        // Cap at MAX_TIMELINE_ENTRIES to prevent unbounded memory growth
        return next.length > MAX_TIMELINE_ENTRIES ? next.slice(-MAX_TIMELINE_ENTRIES) : next;
      });
      handleMutation(event);
    });
    return cleanup;
  }, [runId, handleMutation]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (clearAnimTimer.current) clearTimeout(clearAnimTimer.current);
    };
  }, []);

  const attemptsByStep = useMemo(() => {
    const map = new Map<string, number>();
    for (const attempt of attempts) {
      map.set(attempt.stepId, (map.get(attempt.stepId) ?? 0) + 1);
    }
    return map;
  }, [attempts]);

  /** Map of stepId -> Set of attemptIds for that step */
  const attemptIdsByStep = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const attempt of attempts) {
      if (!map.has(attempt.stepId)) map.set(attempt.stepId, new Set());
      map.get(attempt.stepId)!.add(attempt.id);
    }
    return map;
  }, [attempts]);

  const handleNodeHover = useCallback((stepId: string | null, event?: React.MouseEvent) => {
    setHoveredId(stepId);
    if (!stepId || !event || !containerRef.current) {
      setTooltip(null);
      return;
    }
    const step = steps.find((s) => s.id === stepId);
    if (!step) { setTooltip(null); return; }

    const rect = containerRef.current.getBoundingClientRect();
    const hb = resolveHeartbeatForStep(stepId, attemptIdsByStep.get(stepId) ?? new Set(), claims ?? []);
    const phaseKind = getPhaseKind(step).toLowerCase();
    const validationCriteria = phaseKind === "milestone" ? resolveMilestoneValidationCriteria(step) : null;

    setTooltip({
      title: step.title,
      status: step.status,
      heartbeat: hb ? relativeWhen(hb) : "--",
      stepKey: step.stepKey,
      validationCriteria,
      x: event.clientX - rect.left + 12,
      y: event.clientY - rect.top - 8,
    });
  }, [steps, claims, attemptIdsByStep]);

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

  // Build a set of edges that should flash (by looking up step keys of involved edges)
  const stepKeyToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of steps) map.set(s.stepKey, s.id);
    return map;
  }, [steps]);

  const flashedEdgeIds = useMemo(() => {
    const set = new Set<string>();
    for (const key of flashedEdges) {
      const [from, to] = key.split("->");
      const fromId = stepKeyToId.get(from ?? "");
      const toId = stepKeyToId.get(to ?? "");
      if (fromId && toId) set.add(`${fromId}-${toId}`);
    }
    return set;
  }, [flashedEdges, stepKeyToId]);

  // Recent mutations for the mini-timeline (last N)
  const recentMutations = useMemo(() => {
    return mutations.slice(-MAX_TIMELINE_ENTRIES);
  }, [mutations]);

  if (steps.length === 0) {
    return (
      <div
        className="flex items-center justify-center p-6"
        style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px" }}
      >
        No steps to display
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
      {/* Header with mutation badge */}
      {mutationCount > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 10px",
            borderBottom: `1px solid ${COLORS.border}`,
            fontFamily: MONO_FONT,
            fontSize: 10,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 8px",
              background: "rgba(168, 85, 247, 0.15)",
              border: "1px solid rgba(168, 85, 247, 0.3)",
              color: "#C4B5FD",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.5px",
            }}
          >
            Plan revised {mutationCount}x
          </span>
          <span style={{ color: COLORS.textDim }}>
            Last: {recentMutations.length > 0 ? describeMutation(recentMutations[recentMutations.length - 1]!.mutation) : "--"}
          </span>
        </div>
      )}

      {/* DAG SVG */}
      <div
        ref={containerRef}
        className="overflow-auto relative"
        style={{ perspective: '1200px', perspectiveOrigin: '50% 40%' }}
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
            const edgeKey = `${edge.fromId}-${edge.toId}`;
            const isFlashed = flashedEdgeIds.has(edgeKey);
            return (
              <g key={edgeKey} className={isFlashed ? "ade-dag-edge-changed" : undefined}>
                {/* Base edge */}
                <path
                  d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
                  fill="none"
                  stroke={isFlashed ? "#a78bfa" : edge.satisfied ? "#22c55e" : "#6b7280"}
                  strokeWidth={isFlashed ? 2.5 : 1.5}
                  opacity={isFlashed ? 0.8 : 0.4}
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
            const isSelected = selectedStepId === node.step.id;
            const phaseKind = getPhaseKind(node.step).toLowerCase();
            const phaseTint = PHASE_TINT[phaseKind] ?? "transparent";
            const isMergeNode = MERGE_NODE_KINDS.has(phaseKind);
            const isMilestoneNode = phaseKind === "milestone";
            const isGateNode = phaseKind === "review" || phaseKind === "validation";
            const isSkipped = node.step.status === "skipped";
            const isSuperseded = node.step.status === "superseded";

            const isFailed = node.step.status === "failed";
            const isSucceeded = node.step.status === "succeeded";
            const nodeW = node.nodeW;
            const milestoneAccent = "var(--color-accent, #A78BFA)";
            const diamondPoints = `${nodeW / 2},0 ${nodeW},${NODE_H / 2} ${nodeW / 2},${NODE_H} 0,${NODE_H / 2}`;
            const diamondInnerPoints = `${nodeW / 2},4 ${nodeW - 4},${NODE_H / 2} ${nodeW / 2},${NODE_H - 4} 4,${NODE_H / 2}`;

            // Animation state from mutations
            const animState = nodeAnimStates.get(node.step.id) ?? "normal";
            const animClass =
              animState === "entering" ? "ade-dag-entering" :
              animState === "exiting" ? "ade-dag-exiting" :
              animState === "splitting" ? "ade-dag-splitting" :
              undefined;

            return (
              <g
                key={node.step.id}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => onStepClick?.(node.step.id)}
                onMouseEnter={(e) => handleNodeHover(node.step.id, e)}
                onMouseMove={(e) => { if (hoveredId === node.step.id && containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); setTooltip((prev) => prev ? { ...prev, x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8 } : prev); } }}
                onMouseLeave={() => handleNodeHover(null)}
                className={cn("cursor-pointer", isFailed && "ade-node-failed-pulse", animClass)}
              >
                {/* Selected node highlight ring */}
                {isSelected && !isRunning && (
                  isMilestoneNode ? (
                    <polygon
                      points={`${nodeW / 2},-3 ${nodeW + 3},${NODE_H / 2} ${nodeW / 2},${NODE_H + 3} -3,${NODE_H / 2}`}
                      fill="none"
                      stroke="#A78BFA"
                      strokeWidth={2}
                      opacity={0.6}
                    />
                  ) : (
                    <rect
                      x={-3}
                      y={-3}
                      width={nodeW + 6}
                      height={NODE_H + 6}
                      rx={0}
                      fill="none"
                      stroke="#A78BFA"
                      strokeWidth={2}
                      opacity={0.6}
                    />
                  )
                )}
                <g
                  style={{
                    transformStyle: 'preserve-3d',
                    transition: 'transform 200ms ease',
                    transformOrigin: `${nodeW / 2}px ${NODE_H / 2}px`,
                    transform: isHovered ? 'translateZ(10px) scale(1.05)' : 'scale(1)'
                  }}
                >
                {/* Running: spinning ring (thin blue border, 4s rotation) */}
                {isRunning && (
                  isMilestoneNode ? (
                    <polygon
                      points={`${nodeW / 2},-3 ${nodeW + 3},${NODE_H / 2} ${nodeW / 2},${NODE_H + 3} -3,${NODE_H / 2}`}
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth={1.5}
                      strokeDasharray="12 8"
                      opacity={0.7}
                    >
                      <animateTransform attributeName="transform" type="rotate"
                        from={`0 ${nodeW / 2} ${NODE_H / 2}`} to={`360 ${nodeW / 2} ${NODE_H / 2}`}
                        dur="4s" repeatCount="indefinite" />
                    </polygon>
                  ) : (
                    <rect x={-3} y={-3} width={nodeW + 6} height={NODE_H + 6} rx={0}
                      fill="none" stroke="#3b82f6" strokeWidth={1.5}
                      strokeDasharray="12 8" opacity={0.7}>
                      <animateTransform attributeName="transform" type="rotate"
                        from={`0 ${nodeW / 2} ${NODE_H / 2}`} to={`360 ${nodeW / 2} ${NODE_H / 2}`}
                        dur="4s" repeatCount="indefinite" />
                    </rect>
                  )
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
                {isMilestoneNode ? (
                  <polygon
                    points={diamondPoints}
                    fill={phaseTint}
                  />
                ) : (
                  <rect
                    width={nodeW}
                    height={NODE_H}
                    rx={0}
                    fill={phaseTint}
                  />
                )}

                {/* Node background -- diamond shape for gates, regular for others */}
                {isMilestoneNode ? (
                  <>
                    <polygon
                      points={diamondPoints}
                      fill={isHovered ? COLORS.hoverBg : COLORS.cardBg}
                      stroke={statusColor}
                      strokeWidth={isHovered ? 2 : 1.5}
                      opacity={0.95}
                    />
                    <polygon
                      points={diamondInnerPoints}
                      fill="none"
                      stroke={milestoneAccent}
                      strokeWidth={1}
                      strokeDasharray="3 2"
                      opacity={0.9}
                    />
                  </>
                ) : isGateNode ? (
                  <rect
                    x={4}
                    y={4}
                    width={nodeW - 8}
                    height={NODE_H - 8}
                    rx={0}
                    fill={isHovered ? COLORS.hoverBg : COLORS.cardBg}
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
                    fill={isHovered ? COLORS.hoverBg : COLORS.cardBg}
                    stroke={statusColor}
                    strokeWidth={isHovered ? 2 : 1.5}
                    opacity={0.9}
                  />
                ) : (
                  <rect
                    width={nodeW}
                    height={NODE_H}
                    rx={0}
                    fill={isHovered ? COLORS.hoverBg : COLORS.cardBg}
                    stroke={statusColor}
                    strokeWidth={isHovered ? 2 : 1.5}
                    opacity={0.9}
                  />
                )}

                {/* Status indicator bar at top */}
                {isMilestoneNode ? (
                  <rect
                    x={10}
                    y={NODE_H / 2 - 1.5}
                    width={nodeW - 20}
                    height={3}
                    rx={0}
                    fill={statusColor}
                  />
                ) : (
                  <rect
                    x={8}
                    y={0}
                    width={nodeW - 16}
                    height={3}
                    rx={0}
                    fill={statusColor}
                  />
                )}

                {/* Title text -- strikethrough for skipped/superseded steps */}
                <text
                  x={nodeW / 2}
                  y={26}
                  textAnchor="middle"
                  fill={isSkipped || isSuperseded ? COLORS.textMuted : COLORS.textPrimary}
                  fontSize={11}
                  fontWeight={500}
                  fontFamily="'Space Grotesk', sans-serif"
                  textDecoration={isSkipped || isSuperseded ? "line-through" : undefined}
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
              </g>
            );
          })}
        </svg>

        {/* Tooltip overlay */}
        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tooltip.x,
              top: tooltip.y,
              pointerEvents: "none",
              zIndex: 50,
              background: COLORS.hoverBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              padding: "6px 10px",
              maxWidth: 260,
              fontFamily: MONO_FONT,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {tooltip.title}
            </div>
            <div style={{ marginTop: 2, fontSize: 9, color: COLORS.textSecondary, display: "flex", gap: 8 }}>
              <span>
                <span style={{ color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Status: </span>
                <span style={{ color: STATUS_COLORS[tooltip.status] ?? "#6b7280" }}>{tooltip.status}</span>
              </span>
              <span>
                <span style={{ color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>HB: </span>
                <span>{tooltip.heartbeat}</span>
              </span>
            </div>
            <div style={{ marginTop: 1, fontSize: 9, color: COLORS.textDim }}>
              {tooltip.stepKey}
            </div>
            {tooltip.validationCriteria && (
              <div style={{ marginTop: 4, fontSize: 9, color: "#D4D4D8", maxWidth: 240, whiteSpace: "normal", lineHeight: "1.3" }}>
                <span style={{ color: "var(--color-accent, #A78BFA)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Validation:
                </span>{" "}
                {tooltip.validationCriteria}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mini-timeline of plan changes */}
      {recentMutations.length > 0 && (
        <div
          style={{
            borderTop: `1px solid ${COLORS.border}`,
            maxHeight: 140,
            overflowY: "auto",
            padding: "4px 0",
          }}
        >
          {recentMutations.map((entry) => (
            <div
              key={entry.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                padding: "2px 10px",
                fontFamily: MONO_FONT,
                fontSize: 10,
                lineHeight: "16px",
              }}
            >
              <span style={{ color: COLORS.textDim, flexShrink: 0 }}>
                {formatTime(entry.timestamp)}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 14,
                  fontSize: 9,
                  fontWeight: 700,
                  background: "rgba(168, 85, 247, 0.12)",
                  color: "#C4B5FD",
                  flexShrink: 0,
                }}
              >
                {MUTATION_ICONS[entry.mutation.type] ?? "?"}
              </span>
              <span style={{ color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {describeMutation(entry.mutation)}
              </span>
              {entry.source !== "coordinator" && (
                <span style={{ color: COLORS.textDim, flexShrink: 0 }}>
                  [{entry.source}]
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
