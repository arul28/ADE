/**
 * What the canvas does WHILE a lane is being dragged.
 *
 * Two defects lived here, and both were invisible to every other test because
 * both need a drag in flight:
 *
 * 1. The effect that pushes a rebuilt model into React Flow ran mid-drag. React
 *    Flow owns the dragged node's position until the pointer is released, so a
 *    `setNodes` from the model snapped the node back under the cursor — the
 *    flicker the owner saw on every drag.
 * 2. Dropping a node saves its position, a save stamps the snapshot's
 *    `updatedAt`, and `updatedAt` was part of the key that decided when to
 *    re-fit the viewport. So finishing a drag re-fitted the canvas and threw
 *    away the pan the person had just made.
 *
 * React Flow cannot be dragged in jsdom: a node it has not measured refuses the
 * gesture. So the canvas is mounted with `ReactFlow` replaced by a prop
 * recorder, and the test calls the drag handlers the real canvas would call.
 * That is the same seam — the props this page hands React Flow — and it is the
 * one the two defects lived on.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";

import type { GraphEdgeData, GraphNodeData } from "../src/lib/graphTypes";
import { CHILD_LANE, installFakeBridge, uninstallFakeBridge, type FakeBridge } from "./fakeBridge";

type FlowProps = {
  nodes: Array<Node<GraphNodeData>>;
  edges: Array<Edge<GraphEdgeData>>;
  onNodeDragStart: (event: unknown, node: Node<GraphNodeData>) => void;
  onNodeDrag: (event: unknown, node: Node<GraphNodeData>) => void;
  onNodeDragStop: (event: unknown, node: Node<GraphNodeData>) => void;
};

const harness = vi.hoisted(() => ({
  flow: {
    fitView: vi.fn(() => Promise.resolve(true)),
    getNodes: vi.fn(() => [] as unknown[]),
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  },
  props: { current: null as FlowProps | null },
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => harness.flow,
    // Children are dropped on purpose: `Panel` and `MiniMap` read a store this
    // stub does not own, and neither is what these two cases are about.
    ReactFlow: (props: FlowProps) => {
      harness.props.current = props;
      return React.createElement("div", { "data-testid": "flow-stub" });
    },
  };
});

const { WorkspaceGraph } = await import("../src/components/WorkspaceGraph");

let host: FakeBridge;

beforeEach(() => {
  host = installFakeBridge();
  harness.flow.fitView.mockClear();
  harness.props.current = null;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

function tabContext() {
  return {
    subject: null,
    surfaceId: "graph",
    placement: "tab" as const,
    project: { projectId: "project-1", root: "/repo", binding: "local" as const },
  };
}

function flowProps(): FlowProps {
  const props = harness.props.current;
  if (!props) throw new Error("The canvas has not handed React Flow its props yet.");
  return props;
}

function draggedNode(): Node<GraphNodeData> {
  const node = flowProps().nodes.find((entry) => entry.id === CHILD_LANE.id);
  if (!node) throw new Error("The child lane node is not on the canvas.");
  return node;
}

function laneNameOnCanvas(laneId: string): string | null {
  return flowProps().nodes.find((entry) => entry.id === laneId)?.data.lane.name ?? null;
}

async function mountedCanvas(): Promise<void> {
  render(<WorkspaceGraph context={tabContext()} />);
  await waitFor(() => {
    expect(flowProps().nodes.some((node) => node.id === CHILD_LANE.id)).toBe(true);
  });
  // The first fit is queued on a zero-delay timer; let it run so the counts
  // below measure re-fits rather than the opening one.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Rename the dragged lane in the child and tell the page something moved. */
async function renameLaneUpstream(name: string): Promise<void> {
  const before = host.callsTo("invoke:pageLanes").length;
  const renamed = host.lanes.map((lane) => (lane.id === CHILD_LANE.id ? { ...lane, name } : lane));
  host.setAction("pageLanes", () => renamed);
  await act(async () => {
    host.emit("host", { kind: "lane", ids: [CHILD_LANE.id], overflow: false });
  });
  await waitFor(() => {
    expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(before);
  });
}

describe("a drag in flight", () => {
  it("leaves the nodes React Flow is holding untouched when the model changes", async () => {
    await mountedCanvas();
    expect(laneNameOnCanvas(CHILD_LANE.id)).toBe(CHILD_LANE.name);

    const node = draggedNode();
    await act(async () => {
      flowProps().onNodeDragStart({}, node);
    });
    await act(async () => {
      flowProps().onNodeDrag({}, { ...node, position: { x: node.position.x + 40, y: node.position.y + 24 } });
    });

    await renameLaneUpstream("renamed-mid-drag");
    expect(laneNameOnCanvas(CHILD_LANE.id)).toBe(CHILD_LANE.name);

    await act(async () => {
      flowProps().onNodeDragStop({}, { ...node, position: { x: node.position.x + 40, y: node.position.y + 24 } });
    });
    await waitFor(() => {
      expect(laneNameOnCanvas(CHILD_LANE.id)).toBe("renamed-mid-drag");
    });
  });

  it("does not re-fit the viewport when the drop saves the new position", async () => {
    await mountedCanvas();
    const node = draggedNode();
    const fitsBefore = harness.flow.fitView.mock.calls.length;

    await act(async () => {
      flowProps().onNodeDragStart({}, node);
    });
    await act(async () => {
      flowProps().onNodeDragStop({}, { ...node, position: { x: node.position.x + 64, y: node.position.y } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.flow.fitView.mock.calls.length).toBe(fitsBefore);
  });
});
