/**
 * The CI pipeline DAG, rendered with React Flow.
 *
 * ## Why this file is loaded lazily
 *
 * React Flow (`@xyflow/react`) plus its stylesheet is a heavy dependency, and
 * the PR detail pane is NOT a separate route — it is reachable from the web
 * client's first-loaded bundle. `apps/desktop/scripts/check-webclient-entry.mjs`
 * caps the entry graph at 1000 KB raw and additionally rejects any eagerly
 * linked chunk whose name matches /graph/. This module is only ever reached
 * through a `React.lazy(() => import("./PrChecksGraphCanvas"))` in
 * `PrChecksTab`, so it lands in its own async chunk — and because that chunk is
 * named after this file, the entry check doubles as a tripwire: if anything ever
 * imports it statically, the build fails rather than quietly shipping React Flow
 * to every first paint.
 *
 * Nothing outside this file (or its node/edge children) may import
 * `@xyflow/react`.
 *
 * ## Layout
 *
 * Positions come from `prChecksGraphLayout.ts`, which is pure and unit-tested.
 * React Flow is used strictly as a viewport: pan, zoom, fit-to-view, and edge
 * routing. Nodes are not draggable — the layout is meaningful, and letting a
 * user drag a job out of its dependency column destroys the only thing the
 * graph is for.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";

import type { PrWorkflowGraph, PrWorkflowGraphNode } from "../../../../shared/types";
import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import { matrixLegCaption, nodeElapsedMs, stepProgress } from "./prChecksModel";
import { fmtMs, tint } from "./prChecksVisuals";
import {
  CHECKS_FIT_VIEW_PADDING,
  checksCanvasHeight,
  checksNodeShowsProgress,
  layoutChecksGraph,
} from "./prChecksGraphLayout";
import { PrChecksGraphNode, type ChecksGraphFlowNode } from "./PrChecksGraphNode";
import { PrChecksGraphEdge, type ChecksGraphFlowEdge } from "./PrChecksGraphEdge";

const nodeTypes = { checksJob: PrChecksGraphNode };
const edgeTypes = { checksDep: PrChecksGraphEdge };

/**
 * Hoisted: a fresh object here would reset the viewport on every render.
 *
 * `maxZoom` above 1 so a two- or three-job pipeline fills the canvas at first
 * paint instead of sitting as three small cards in the middle of it; the cap is
 * low enough that the card never renders as a blown-up placard.
 */
const FIT_VIEW_OPTIONS = { padding: CHECKS_FIT_VIEW_PADDING, maxZoom: 1.15 } as const;

/**
 * THE reason node clicks work.
 *
 * React Flow v12's `NodeWrapper` computes
 * `pointerEvents: (isSelectable || isDraggable || onNodeClick || onNodeMouseEnter
 * || onNodeMouseMove || onNodeMouseLeave) ? 'all' : 'none'`. This graph sets
 * `nodesDraggable`, `nodesConnectable` and `elementsSelectable` to false and
 * hands React Flow no node mouse handlers, so every one of those is falsy and
 * React Flow writes `pointer-events: none` onto `.react-flow__node` — which is
 * inherited by the whole card and silently swallows every click.
 *
 * `node.style` is spread AFTER that computed value in React Flow's own inline
 * style object, so putting `pointerEvents` here is what wins.
 *
 * Restoring hit-testing this way rather than by re-enabling `elementsSelectable`
 * is deliberate: selection is already owned by `PrChecksTab` (`selectedJobId`
 * drives the log drawer). Turning React Flow's selection back on would give the
 * same fact two owners — React Flow would write `node.selected`, add its own
 * `.selected` class, and hijack Enter/Escape through `handleNodeClick` — for a
 * feature we do not use.
 *
 * Panning is unaffected. React Flow only rejects a drag that starts inside an
 * element carrying `noPanClassName` ("nopan"), and it applies that class to a
 * node wrapper *only when the node is draggable*, which these never are. So a
 * drag beginning on a card still reaches d3-zoom and pans, exactly like a drag
 * on the background — and d3-zoom suppresses the trailing `click` whenever the
 * pointer actually moved, so panning off a card cannot toggle the drawer.
 */
const INTERACTIVE_NODE_STYLE: CSSProperties = { pointerEvents: "all" };

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

export type PrChecksGraphCanvasProps = {
  graph: PrWorkflowGraph;
  /** Live clock, so running jobs keep counting without a re-fetch. */
  now: number;
  selectedJobId: string | null;
  focusedJobId: string | null;
  /** Toggles: selecting the already-open job closes the drawer. */
  onToggleNode: (node: PrWorkflowGraphNode) => void;
};

function ZoomButton({
  onClick, label, children,
}: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-[24px] w-[24px] items-center justify-center"
      style={{
        borderRadius: RADII.sm,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.borderMuted}`,
        color: COLORS.textMuted,
        cursor: "pointer",
        fontFamily: SANS_FONT,
      }}
    >
      {children}
    </button>
  );
}

export const PrChecksGraphCanvas = memo(function PrChecksGraphCanvas({
  graph,
  now,
  selectedJobId,
  focusedJobId,
  onToggleNode,
}: PrChecksGraphCanvasProps) {
  const instanceRef = useRef<ReactFlowInstance<ChecksGraphFlowNode, ChecksGraphFlowEdge> | null>(null);

  const layout = useMemo(
    () => layoutChecksGraph(graph.nodes, graph.edges, graph.criticalPath),
    [graph.nodes, graph.edges, graph.criticalPath],
  );

  const nodes = useMemo<ChecksGraphFlowNode[]>(() => layout.nodes.map((entry) => ({
    id: entry.node.jobId,
    type: "checksJob" as const,
    position: { x: entry.x, y: entry.y },
    width: entry.width,
    height: entry.height,
    draggable: false,
    selectable: false,
    connectable: false,
    // The card inside is the tab stop and the ARIA button; React Flow's wrapper
    // must not be a second one.
    focusable: false,
    style: INTERACTIVE_NODE_STYLE,
    data: {
      node: entry.node,
      onCriticalPath: entry.onCriticalPath,
      isSelected: selectedJobId === entry.node.jobId,
      isFocused: focusedJobId === entry.node.jobId,
      elapsedLabel: fmtMs(nodeElapsedMs(entry.node, now)),
      legCaption: matrixLegCaption(entry.node),
      // The layout reserved room for this on exactly the same condition, so the
      // bar can never overflow the card it was measured for.
      progress: checksNodeShowsProgress(entry.node) ? stepProgress(entry.node) : null,
      onToggle: onToggleNode,
    },
  })), [layout.nodes, selectedJobId, focusedJobId, now, onToggleNode]);

  const reducedMotion = useMemo(prefersReducedMotion, []);
  const edges = useMemo<ChecksGraphFlowEdge[]>(() => layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "checksDep" as const,
    // React Flow's own dash-flow animation, so no global keyframe is needed —
    // and only for a job that is genuinely executing right now.
    animated: edge.live && !reducedMotion,
    data: { onCriticalPath: edge.onCriticalPath, live: edge.live, pending: edge.pending },
  })), [layout.edges, reducedMotion]);

  const fitView = useCallback(() => {
    void instanceRef.current?.fitView({ ...FIT_VIEW_OPTIONS, duration: 240 });
  }, []);

  // Re-fit when the pipeline's SHAPE changes (a job appeared, an edge resolved),
  // never on a state or clock tick — refitting every second while CI runs would
  // make the viewport twitch under the user's cursor.
  const shapeKey = `${layout.nodes.length}:${layout.edges.length}:${layout.layerCount}`;
  useEffect(() => {
    if (!instanceRef.current) return undefined;
    const id = window.requestAnimationFrame(() => {
      void instanceRef.current?.fitView(FIT_VIEW_OPTIONS);
    });
    return () => window.cancelAnimationFrame(id);
  }, [shapeKey]);

  const height = checksCanvasHeight(layout.height);

  return (
    <div
      data-testid="pr-checks-graph"
      data-node-count={layout.nodes.length}
      data-edge-count={layout.edges.length}
      className="relative w-full overflow-hidden"
      style={{
        height,
        borderRadius: RADII.md,
        border: `1px solid ${COLORS.borderMuted}`,
        background: tint(COLORS.recessedBg, 100),
      }}
    >
      <ReactFlow<ChecksGraphFlowNode, ChecksGraphFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => { instanceRef.current = instance; }}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        minZoom={0.3}
        maxZoom={1.75}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={{ hideAttribution: true }}
        aria-label="CI pipeline graph"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={COLORS.borderMuted} />
      </ReactFlow>

      <div className="absolute bottom-2 right-2 flex items-center gap-1">
        <ZoomButton label="Zoom out" onClick={() => instanceRef.current?.zoomOut({ duration: 160 })}>
          <MagnifyingGlassMinus size={12} />
        </ZoomButton>
        <ZoomButton label="Zoom in" onClick={() => instanceRef.current?.zoomIn({ duration: 160 })}>
          <MagnifyingGlassPlus size={12} />
        </ZoomButton>
        <ZoomButton label="Fit graph to view" onClick={fitView}>
          <ArrowsOut size={12} />
        </ZoomButton>
      </div>
    </div>
  );
});

export default PrChecksGraphCanvas;
