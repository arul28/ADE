// @vitest-environment jsdom

/**
 * The canvas ↔ React Flow contract.
 *
 * ## What this file exists for
 *
 * Clicking a node in the CI graph stopped working after the React Flow rebuild.
 * Nothing about the node component was wrong: React Flow v12 writes
 * `pointer-events: none` onto `.react-flow__node` whenever `nodesDraggable`,
 * `nodesConnectable` and `elementsSelectable` are all false and it holds no node
 * mouse handlers, and the inherited value made the whole card untouchable.
 *
 * jsdom has no layout, no hit testing and no `pointer-events`, so no test in
 * this repo can reproduce that by clicking. What a test CAN do — and what these
 * assertions do — is pin the props that decide it: every node must carry an
 * explicit `pointerEvents`, which React Flow spreads after (and therefore over)
 * its computed value, and the interaction flags that made it compute `none` must
 * stay where they are for the reasons documented on the canvas.
 *
 * These tests would have failed the moment the interactive style was dropped.
 * They would NOT catch a future React Flow release that stops honouring
 * `node.style`, or a CSS rule that re-disables pointer events higher up the
 * tree.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrWorkflowGraph, PrWorkflowGraphNode } from "../../../../shared/types";

type CapturedFlowProps = {
  nodes: Array<{ id: string; style?: Record<string, unknown>; focusable?: boolean; draggable?: boolean }>;
  edges: Array<{ id: string }>;
  nodesDraggable?: boolean;
  nodesConnectable?: boolean;
  elementsSelectable?: boolean;
  nodesFocusable?: boolean;
  panOnDrag?: boolean;
  zoomOnScroll?: boolean;
};

const captured: { props: CapturedFlowProps | null } = { props: null };

/**
 * React Flow needs a measured viewport that jsdom cannot give it, and this test
 * is about the props rather than the rendering, so the whole library is stubbed.
 * `PrChecksGraphNode` and `PrChecksGraphEdge` import from it too, which is why
 * `Handle`, `Position` and `BaseEdge` are stubbed alongside `ReactFlow`.
 */
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: CapturedFlowProps) => {
    captured.props = props;
    return <div data-testid="react-flow-stub" />;
  },
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  BaseEdge: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  getSmoothStepPath: () => ["M0,0", 0, 0, 0, 0],
}));
vi.mock("@xyflow/react/dist/style.css", () => ({}));

import { PrChecksGraphCanvas } from "./PrChecksGraphCanvas";
import type { NodeProps } from "@xyflow/react";
import { PrChecksGraphNode, type ChecksGraphFlowNode, type ChecksGraphNodeData } from "./PrChecksGraphNode";

function graphNode(overrides: Partial<PrWorkflowGraphNode> = {}): PrWorkflowGraphNode {
  return {
    jobId: "build",
    displayName: "build",
    workflowName: "CI",
    state: "passed",
    tier: 0,
    durationMs: 1_000,
    startedAt: null,
    completedAt: null,
    legs: [],
    steps: [],
    checkRunId: null,
    runId: null,
    detailsUrl: null,
    ...overrides,
  };
}

const graph: PrWorkflowGraph = {
  source: "worktree",
  unavailableReason: null,
  headSha: "abc1234",
  attempt: 1,
  nodes: [
    graphNode({ jobId: "build", displayName: "build" }),
    graphNode({ jobId: "test", displayName: "test", tier: 1, state: "running" }),
  ],
  edges: [{ from: "build", to: "test" }],
  criticalPath: ["build", "test"],
  externalChecks: [],
  stale: false,
  staleBehindBy: null,
} as PrWorkflowGraph;

beforeEach(() => {
  captured.props = null;
  Object.assign(window, { ade: { app: { openExternal: vi.fn() } } });
});
afterEach(cleanup);

function renderCanvas() {
  render(
    <PrChecksGraphCanvas
      graph={graph}
      now={Date.parse("2026-07-27T12:00:00.000Z")}
      selectedJobId={null}
      focusedJobId={null}
      onToggleNode={vi.fn()}
    />,
  );
  const props = captured.props;
  if (!props) throw new Error("ReactFlow was never rendered");
  return props;
}

describe("PrChecksGraphCanvas → React Flow props", () => {
  it("gives every node explicit pointer events, or React Flow makes the card unclickable", () => {
    const props = renderCanvas();
    expect(props.nodes).toHaveLength(2);
    for (const node of props.nodes) {
      expect(node.style?.pointerEvents).toBe("all");
    }
  });

  it("keeps drag, connect and React Flow's own selection off", () => {
    const props = renderCanvas();
    // These three are exactly what makes React Flow compute `pointer-events:
    // none`, so they are asserted next to the style that compensates for them.
    expect(props.nodesDraggable).toBe(false);
    expect(props.nodesConnectable).toBe(false);
    expect(props.elementsSelectable).toBe(false);
    expect(props.nodes.every((node) => node.draggable === false)).toBe(true);
  });

  it("keeps panning and zooming, which is the only thing the viewport is for", () => {
    const props = renderCanvas();
    // React Flow refuses a drag only when it starts inside `nopan`, a class it
    // applies to a node wrapper solely when that node is draggable. Nodes are
    // never draggable here, so no card can ever block a pan.
    expect(props.panOnDrag).toBe(true);
    expect(props.zoomOnScroll).toBe(true);
  });

  it("leaves React Flow's wrapper out of the tab order so each job is one stop", () => {
    const props = renderCanvas();
    expect(props.nodesFocusable).toBe(false);
    expect(props.nodes.every((node) => node.focusable === false)).toBe(true);
  });
});


/* -- Folded in from `PrChecksGraphNode.test.tsx` --
   The node the canvas renders. This file already stubs `Handle`, which is exactly what the node needs. */

afterEach(cleanup);

function PrChecksGraphNodeGraphNode(overrides: Partial<PrWorkflowGraphNode> = {}): PrWorkflowGraphNode {
  return {
    jobId: "job-build",
    displayName: "build",
    workflowName: "CI",
    state: "passed",
    tier: 0,
    durationMs: 80_000,
    startedAt: null,
    completedAt: null,
    legs: [],
    steps: [],
    checkRunId: null,
    runId: null,
    detailsUrl: null,
    ...overrides,
  };
}

function renderNode(overrides: Partial<ChecksGraphNodeData> = {}) {
  const onToggle = vi.fn();
  const openExternal = vi.fn(() => Promise.resolve());
  (window as unknown as { ade: unknown }).ade = { app: { openExternal } };
  const data: ChecksGraphNodeData = {
    node: PrChecksGraphNodeGraphNode(),
    onCriticalPath: false,
    isSelected: false,
    isFocused: false,
    elapsedLabel: "1m 20s",
    legCaption: null,
    progress: null,
    onToggle,
    ...overrides,
  };
  // Both handles render unconditionally now, and a real `Handle` reads React
  // Flow's store — but this file already stubs the whole library, so no
  // provider is needed here.
  render(<PrChecksGraphNode {...({ data } as unknown as NodeProps<ChecksGraphFlowNode>)} />);
  return { onToggle, openExternal, node: data.node };
}

describe("PrChecksGraphNode", () => {
  it("calls onToggle when the card is clicked", () => {
    const { onToggle, node } = renderNode();
    fireEvent.click(screen.getByTestId("pr-checks-graph-node"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(node);
  });

  it.each(["Enter", " "])("calls onToggle on %j, so the card is not mouse-only", (key) => {
    const { onToggle, node } = renderNode();
    fireEvent.keyDown(screen.getByTestId("pr-checks-graph-node"), { key });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(node);
  });

  it("ignores keys that are not an activation", () => {
    const { onToggle } = renderNode();
    const card = screen.getByTestId("pr-checks-graph-node");
    fireEvent.keyDown(card, { key: "a" });
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is a focusable button that names the job and its status", () => {
    renderNode({
      node: PrChecksGraphNodeGraphNode({ displayName: "typecheck", state: "failed" }),
      elapsedLabel: "43s",
      onCriticalPath: true,
    });
    const card = screen.getByRole("button", { name: "typecheck, failed, 43s, on the longest path" });
    expect(card.getAttribute("tabindex")).toBe("0");
    expect(card.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the drawer it opened through aria-pressed", () => {
    renderNode({ isSelected: true });
    expect(screen.getByTestId("pr-checks-graph-node").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens GitHub without also toggling the drawer", () => {
    const { onToggle, openExternal } = renderNode({
      node: PrChecksGraphNodeGraphNode({ detailsUrl: "https://github.com/ade-dev/ade/runs/1" }),
    });
    const external = screen.getByTestId("pr-checks-open-on-github");

    fireEvent.click(external);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/ade-dev/ade/runs/1");
    expect(onToggle).not.toHaveBeenCalled();

    // The card's own Enter handler must not swallow this button's activation.
    fireEvent.keyDown(external, { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
