/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import {
  parsePluginContributionPayload,
  type PluginGraphNodePayload,
} from "../../../shared/plugins/sockets";
import { GraphPluginNode } from "./graphNodes/PluginNode";
import type { GraphNodeData } from "./graphTypes";
import { isSyntheticGraphNode } from "./graphTypes";
import type { PluginGraphNodeEntry } from "./pluginGraphNodes";

/**
 * What the node draws, and what pressing it asks for.
 *
 * The two facts a rendering test is the only place to pin: that the plugin's
 * identity is visible on the card at all — everything else on this canvas is
 * something git said, so an unattributed plugin card is the one dishonest pixel
 * on the tab — and that a press routes through the caller's dispatch rather
 * than doing anything of its own.
 */

function payloadOf(raw: Record<string, unknown>): PluginGraphNodePayload {
  const parsed = parsePluginContributionPayload("graph-node", raw);
  if (!parsed) throw new Error("fixture payload is invalid");
  return parsed;
}

function nodeData(overrides: {
  payload: Record<string, unknown>;
  onPress?: () => void;
  accent?: string | null;
}): GraphNodeData {
  const entry: PluginGraphNodeEntry = {
    // Written as the ESCAPE, never a literal NUL: a source file holding one
    // is binary to git, which stops diffing it and hides every later change.
    key: "tracker\u0000graph-node\u0000issue",
    nodeId: "plugin-node:tracker:lane:lane-a",
    pluginId: "tracker",
    identity: {
      pluginId: "tracker",
      displayName: "Tracker",
      accent: overrides.accent === undefined ? "#7C6FF0" : overrides.accent,
      icon: "kanban",
    },
    payload: payloadOf(overrides.payload),
    anchorNodeId: "lane-a",
    edges: [],
  };
  return {
    lane: {
      id: entry.nodeId,
      name: entry.payload.label,
      description: "Tracker",
      laneType: "attached",
      baseRef: "",
      branchRef: "",
      worktreePath: "",
      attachedRootPath: null,
      parentLaneId: null,
      childCount: 0,
      stackDepth: 0,
      parentStatus: null,
      isEditProtected: true,
      status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
      color: null,
      icon: null,
      tags: [],
      createdAt: "",
      archivedAt: null,
    },
    status: "unknown",
    remoteSync: null,
    autoRebaseStatus: null,
    activeSessions: 0,
    collapsedChildCount: 0,
    hierarchyDepth: 0,
    parentLaneName: null,
    dimmed: false,
    activityBucket: "medium",
    viewMode: "all",
    lastActivityAt: null,
    environment: null,
    highlight: false,
    rebaseFailed: false,
    rebasePulse: false,
    mergeInProgress: false,
    mergeDisappearing: false,
    isIntegration: false,
    focusGlow: false,
    isVirtualProposal: false,
    integrationSources: [],
    pr: null,
    pluginNode: entry,
    ...(overrides.onPress ? { onPressPluginNode: overrides.onPress } : {}),
  };
}

function renderNode(data: GraphNodeData) {
  return render(
    <ReactFlowProvider>
      <GraphPluginNode
        id={data.pluginNode!.nodeId}
        type="plugin"
        data={data}
        selected={false}
        dragging={false}
        selectable
        // The canvas sets these to match: a plugin node is never dragged,
        // reparented or deleted — every one of those handlers refuses a
        // synthetic node.
        draggable={false}
        deletable={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

afterEach(() => cleanup());

describe("a plugin's graph node", () => {
  it("draws its label, its detail and the plugin it came from", () => {
    renderNode(nodeData({ payload: { label: "ADE-142", detail: "In review", tone: "accent" } }));
    expect(screen.getByText("ADE-142")).toBeTruthy();
    expect(screen.getByText("In review")).toBeTruthy();
    // The attribution is not optional chrome: everything else on this canvas is
    // a fact git or GitHub produced.
    expect(screen.getByText("Tracker")).toBeTruthy();
  });

  it("leaves the press to the canvas, so a click fires the action exactly once", () => {
    const onPress = vi.fn();
    const data = nodeData({ payload: { label: "ADE-142", actionId: "openIssue" }, onPress });
    const { container } = renderNode(data);
    const card = container.querySelector("[data-plugin-id='tracker']");
    expect(card).toBeTruthy();

    // React Flow's `onNodeClick` is the single dispatch path — the page reads
    // `onPressPluginNode` off the node data and calls it. The card must NOT also
    // bind its own handler, or one click would invoke the plugin twice.
    fireEvent.click(card!);
    expect(onPress).not.toHaveBeenCalled();

    data.onPressPluginNode?.();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("has no press at all when the payload declares no action", () => {
    // A node that only labels something is a legitimate node — `actionId` is not
    // required — and it must not look pressable.
    const data = nodeData({ payload: { label: "ADE-142" } });
    expect(data.onPressPluginNode).toBeUndefined();
    const { container } = renderNode(data);
    expect(container.querySelector("[data-plugin-id='tracker']")?.className)
      .not.toContain("cursor-pointer");
  });

  it("draws its icon token, and puzzle-pieces one it has never heard of", () => {
    const { container: known } = renderNode(nodeData({ payload: { label: "A", icon: "kanban" } }));
    const { container: unknown } = renderNode(nodeData({ payload: { label: "A", icon: "not-a-token" } }));
    // Both render an icon; an unresolvable token degrades rather than crashing,
    // the same rule every other socket icon follows.
    expect(known.querySelector("svg")).toBeTruthy();
    expect(unknown.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a neutral frame when the plugin declares no accent", () => {
    const { container } = renderNode(nodeData({ payload: { label: "A" }, accent: null }));
    expect(container.querySelector("[data-plugin-id='tracker']")).toBeTruthy();
  });
});

describe("synthetic node guards", () => {
  it("counts a plugin node and a virtual proposal, and no lane", () => {
    // The one predicate every drag, drop, reparent and context-menu handler on
    // the canvas asks. A lane answering `true` here would become undraggable;
    // a plugin node answering `false` would become a reparent target.
    const plugin = nodeData({ payload: { label: "A" } });
    expect(isSyntheticGraphNode(plugin)).toBe(true);

    const proposal: GraphNodeData = { ...plugin, isVirtualProposal: true };
    delete (proposal as { pluginNode?: unknown }).pluginNode;
    expect(isSyntheticGraphNode(proposal)).toBe(true);

    const lane: GraphNodeData = { ...plugin, isVirtualProposal: false };
    delete (lane as { pluginNode?: unknown }).pluginNode;
    expect(isSyntheticGraphNode(lane)).toBe(false);
  });
});
