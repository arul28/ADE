// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BatchAssessmentResult, LaneSummary, ProjectInfo } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { WorkspaceGraphPage } from "./WorkspaceGraphPage";

const xyflowMocks = vi.hoisted(() => {
  const latest = {
    nodes: [] as Array<{ id: string }>,
    edges: [] as Array<{ id: string }>
  };
  return {
    latest,
    api: {
      fitView: vi.fn(async () => true),
      zoomIn: vi.fn(async () => true),
      zoomOut: vi.fn(async () => true),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
      getNodes: vi.fn(() => latest.nodes)
    }
  };
});

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");

  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Edge: class {},
    Handle: () => null,
    MarkerType: { ArrowClosed: "arrow-closed" },
    MiniMap: () => <div data-testid="graph-minimap" />,
    Node: class {},
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Position: { Top: "top", Bottom: "bottom" },
    ReactFlow: ({
      nodes = [],
      edges = [],
      children
    }: {
      nodes?: Array<{ id: string }>;
      edges?: Array<{ id: string }>;
      children?: React.ReactNode;
    }) => {
      xyflowMocks.latest.nodes = nodes;
      xyflowMocks.latest.edges = edges;
      return (
        <div data-testid="mock-react-flow">
          <div data-testid="mock-node-ids">{nodes.map((node) => node.id).join(",")}</div>
          <div data-testid="mock-edge-ids">{edges.map((edge) => edge.id).join(",")}</div>
          {children}
        </div>
      );
    },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    useReactFlow: () => xyflowMocks.api
  };
});

const PROJECT: ProjectInfo = {
  rootPath: "/tmp/ade-graph-tests",
  displayName: "ADE",
  baseRef: "main"
};

const EMPTY_BATCH: BatchAssessmentResult = {
  lanes: [],
  matrix: [],
  overlaps: [],
  computedAt: "2026-03-11T12:00:00.000Z"
};

function buildLane(overrides: Partial<LaneSummary>): LaneSummary {
  return {
    id: overrides.id ?? "lane-1",
    name: overrides.name ?? "Lane",
    description: overrides.description ?? null,
    laneType: overrides.laneType ?? "worktree",
    baseRef: overrides.baseRef ?? "main",
    branchRef: overrides.branchRef ?? `refs/heads/${overrides.id ?? "lane-1"}`,
    worktreePath: overrides.worktreePath ?? `/tmp/${overrides.id ?? "lane-1"}`,
    attachedRootPath: overrides.attachedRootPath ?? null,
    parentLaneId: overrides.parentLaneId ?? null,
    childCount: overrides.childCount ?? 0,
    stackDepth: overrides.stackDepth ?? 0,
    parentStatus: overrides.parentStatus ?? null,
    isEditProtected: overrides.isEditProtected ?? overrides.laneType === "primary",
    status: overrides.status ?? { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: overrides.color ?? null,
    icon: overrides.icon ?? null,
    tags: overrides.tags ?? [],
    folder: overrides.folder ?? null,
    createdAt: overrides.createdAt ?? "2026-03-11T12:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null
  };
}

function buildBridge(options?: {
  lanes?: LaneSummary[];
  graphState?: unknown;
  environments?: Array<{ env: string; branch: string; color?: string | null }>;
}) {
  let storedGraphState = options?.graphState ?? null;
  const laneList = options?.lanes ?? [];
  const environments = options?.environments ?? [];

  return {
    bridge: {
      projectConfig: {
        get: vi.fn(async () => ({
          effective: { environments }
        }))
      },
      prs: {
        listWithConflicts: vi.fn(async () => []),
        listProposals: vi.fn(async () => []),
        onEvent: vi.fn(() => () => {}),
        getStatus: vi.fn(async () => null),
        getChecks: vi.fn(async () => []),
        getReviews: vi.fn(async () => []),
        getComments: vi.fn(async () => []),
        draftDescription: vi.fn(async () => ({ title: "Draft PR", body: "Draft body" })),
        createFromLane: vi.fn(),
        land: vi.fn(),
        submitReview: vi.fn(),
      },
      conflicts: {
        getBatchAssessment: vi.fn(async () => EMPTY_BATCH),
        onEvent: vi.fn(() => () => {}),
        simulateMerge: vi.fn(async () => ({
          outcome: "clean",
          mergedFiles: [],
          conflictingFiles: [],
          diffStat: { insertions: 0, deletions: 0, filesChanged: 0 }
        })),
      },
      sessions: {
        list: vi.fn(async () => [])
      },
      history: {
        listOperations: vi.fn(async () => [])
      },
      graphState: {
        get: vi.fn(async () => storedGraphState),
        set: vi.fn(async (_projectId: string, state: unknown) => {
          storedGraphState = state;
        })
      },
      pty: {
        onData: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {})
      },
      lanes: {
        list: vi.fn(async () => laneList),
        listAutoRebaseStatuses: vi.fn(async () => []),
        onAutoRebaseEvent: vi.fn(() => () => {})
      },
      git: {
        getSyncStatus: vi.fn(async () => ({
          laneId: "unused",
          hasUpstream: true,
          upstreamRef: "origin/main",
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "none"
        }))
      }
    },
    getStoredGraphState: () => storedGraphState
  };
}

function renderGraphPage() {
  return render(
    <MemoryRouter initialEntries={["/graph"]}>
      <Routes>
        <Route path="/graph" element={<WorkspaceGraphPage />} />
        <Route path="/lanes" element={<div>Lane page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("WorkspaceGraphPage", () => {
  beforeEach(() => {
    xyflowMocks.api.fitView.mockClear();
    xyflowMocks.api.zoomIn.mockClear();
    xyflowMocks.api.zoomOut.mockClear();
    xyflowMocks.latest.nodes = [];
    xyflowMocks.latest.edges = [];
    useAppStore.setState({
      project: PROJECT,
      showWelcome: false,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    (window as any).ade = undefined;
    useAppStore.setState({
      project: null,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {}
    });
  });

  it("shows the empty state and loads graph preferences for the current project", async () => {
    const { bridge } = buildBridge();
    (window as any).ade = bridge;

    renderGraphPage();

    await waitFor(() => expect(screen.getByText("No lanes yet")).toBeTruthy());
    expect(bridge.graphState.get).toHaveBeenCalledWith(PROJECT.rootPath);
    expect(bridge.lanes.list).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy graph state and renders the simplified top bar", async () => {
    const primaryLane = buildLane({
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      isEditProtected: true
    });
    const legacyState = {
      activePreset: "Risk preset",
      presets: [
        {
          name: "Risk preset",
          byViewMode: {
            risk: { viewMode: "risk" }
          }
        }
      ]
    };
    const { bridge } = buildBridge({ lanes: [primaryLane], graphState: legacyState });
    (window as any).ade = bridge;

    renderGraphPage();

    await waitFor(() => expect(screen.getByText("Conflict Risk")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Highlight overlapping work and jump into the pair matrix when you need file-level conflict detail.")).toBeTruthy());
    await waitFor(() => expect(bridge.graphState.set).toHaveBeenCalledWith(PROJECT.rootPath, { lastViewMode: "risk" }));

    expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dependencies" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conflict Risk" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pair Matrix/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Reset View/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Save Layout/i)).toBeNull();
  });

  it("persists only the last selected view mode across reopen", async () => {
    const primaryLane = buildLane({
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      isEditProtected: true
    });
    const setup = buildBridge({ lanes: [primaryLane] });
    (window as any).ade = setup.bridge;

    const firstRender = renderGraphPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Activity" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    await waitFor(() => expect(setup.getStoredGraphState()).toEqual({ lastViewMode: "activity" }));

    firstRender.unmount();
    renderGraphPage();

    await waitFor(() => expect(screen.getByText("Surface the lanes with the most recent work, sessions, and movement.")).toBeTruthy());
  });

  it("does not re-enter the full-screen loader after the initial lane load", async () => {
    const primaryLane = buildLane({
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      isEditProtected: true
    });
    const featureLane = buildLane({
      id: "feature-a",
      name: "Feature A",
      parentLaneId: "primary",
      childCount: 0,
      stackDepth: 1,
      branchRef: "refs/heads/feature-a"
    });
    const { bridge } = buildBridge({ lanes: [primaryLane] });
    (window as any).ade = bridge;

    renderGraphPage();

    await waitFor(() => expect(screen.getByText("Create a worktree lane to see your topology.")).toBeTruthy());
    expect(screen.queryByText("Loading topology…")).toBeNull();

    act(() => {
      useAppStore.setState({
        lanes: [primaryLane, featureLane],
        selectedLaneId: "primary",
        runLaneId: "primary"
      });
    });

    await waitFor(() => expect(screen.getByText("See the full workspace map with dependencies, environments, and active pull requests.")).toBeTruthy());
    expect(screen.queryByText("Loading topology…")).toBeNull();
  });

  it("removes orphaned edges when filters leave only one visible lane", async () => {
    const primaryLane = buildLane({
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      childCount: 1,
      isEditProtected: true
    });
    const featureALane = buildLane({
      id: "feature-a",
      name: "Feature A",
      parentLaneId: "primary",
      childCount: 1,
      stackDepth: 1,
      branchRef: "refs/heads/feature-a"
    });
    const featureBLane = buildLane({
      id: "feature-b",
      name: "Feature B",
      parentLaneId: "feature-a",
      childCount: 0,
      stackDepth: 2,
      branchRef: "refs/heads/feature-b"
    });
    const { bridge } = buildBridge({ lanes: [primaryLane, featureALane, featureBLane] });
    (window as any).ade = bridge;

    renderGraphPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("mock-edge-ids").textContent).toContain("topology:primary:feature-a"));

    fireEvent.change(screen.getByPlaceholderText("Filter lanes or tags"), { target: { value: "Feature B" } });

    await waitFor(() => expect(screen.getByRole("button", { name: /Focus Results/i })).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("mock-edge-ids").textContent).toBe(""));
  });
});
