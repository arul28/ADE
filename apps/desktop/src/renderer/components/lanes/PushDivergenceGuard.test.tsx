/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";
import type { MachineBranchState } from "../../../shared/laneDivergence";
import { __resetLaneGitActionRuntimeForTests, LaneGitActionsPane } from "./LaneGitActionsPane";

vi.mock("./CommitTimeline", () => ({
  CommitTimeline: () => <div data-testid="commit-timeline-mock" />,
}));

vi.mock("./LaneDiffPane", () => ({
  LaneDiffPane: () => <div data-testid="lane-diff-pane-mock" />,
}));

let mockStoreState: {
  lanes: LaneSummary[];
  refreshLanes: ReturnType<typeof vi.fn>;
  selectLane: ReturnType<typeof vi.fn>;
  smartTooltipsEnabled: boolean;
  project: { rootPath: string } | null;
  projectBinding:
    | { kind: "local"; key: string; rootPath: string }
    | {
        kind: "remote";
        key: string;
        rootPath: string;
        targetId: string;
        runtimeName: string;
        projectId: string;
      }
    | null;
};

vi.mock("../../state/appStore", () => ({
  selectActiveProjectRoot: (state: { project?: { rootPath?: string | null } | null }) =>
    state.project?.rootPath?.trim() || null,
  selectActiveProjectStateKey: (state: { project?: { rootPath?: string | null } | null }) =>
    state.project?.rootPath?.trim() || null,
  useAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

const LANE_BRANCH_REF = "feature/divergence";

function buildLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Divergence lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: LANE_BRANCH_REF,
    worktreePath: "/tmp/ade/divergence",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 1,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function otherMachine(overrides: Partial<MachineBranchState> = {}): MachineBranchState {
  return {
    machineId: "machine-mbp",
    machineName: "MacBook Pro (97)",
    branchRef: LANE_BRANCH_REF,
    headSha: "bbbbbbb",
    ahead: 3,
    behind: 0,
    ...overrides,
  };
}

describe("LaneGitActionsPane push divergence guard", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;
  let mockSyncStatus: GitUpstreamSyncStatus;

  beforeEach(() => {
    globalThis.window.confirm = vi.fn(() => true);
    __resetLaneGitActionRuntimeForTests();
    mockStoreState = {
      lanes: [buildLane()],
      refreshLanes: vi.fn(async () => undefined),
      selectLane: vi.fn(),
      smartTooltipsEnabled: false,
      project: { rootPath: "/tmp/ade" },
      projectBinding: { kind: "local", key: "local:/tmp/ade", rootPath: "/tmp/ade" },
    };
    mockSyncStatus = {
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: `origin/${LANE_BRANCH_REF}`,
      ahead: 2,
      behind: 0,
      diverged: false,
      recommendedAction: "push",
    };

    globalThis.window.ade = {
      diff: { getChanges: vi.fn(async () => ({ staged: [], unstaged: [] })) },
      git: {
        push: vi.fn(async () => ({ operationId: "git-push", preHeadSha: "aaaaaaa", postHeadSha: "aaaaaaa" })),
        fetch: vi.fn(async () => ({ operationId: "git-fetch", preHeadSha: "aaaaaaa", postHeadSha: "aaaaaaa" })),
        stashList: vi.fn(async () => []),
        getSyncStatus: vi.fn(async () => mockSyncStatus),
        getConflictState: vi.fn(async () => ({
          laneId: "lane-1",
          kind: null,
          inProgress: false,
          conflictedFiles: [],
          canContinue: false,
          canAbort: false,
        })),
      },
      lanes: {
        listAutoRebaseStatuses: vi.fn(async () => []),
        onAutoRebaseEvent: vi.fn(() => () => undefined),
      },
      projectConfig: { get: vi.fn(async () => ({ effective: {} })) },
    } as any;
  });

  afterEach(() => {
    cleanup();
    __resetLaneGitActionRuntimeForTests();
    globalThis.window.confirm = originalConfirm;
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  function renderPane(overrides?: Partial<React.ComponentProps<typeof LaneGitActionsPane>>) {
    return render(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-1"
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
          {...overrides}
        />
      </MemoryRouter>,
    );
  }

  async function clickPush() {
    const pushButton = await screen.findByRole("button", { name: "PUSH" });
    await userEvent.click(pushButton);
  }

  it("pushes with no dialog when no other machine holds the branch", async () => {
    renderPane();
    await clickPush();

    await waitFor(() => {
      expect(window.ade.git.push).toHaveBeenCalledWith({ laneId: "lane-1", forceWithLease: false });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pushes with no dialog when the other machine is behind", async () => {
    renderPane({
      otherMachineBranchStates: [otherMachine({ ahead: 0, behind: 4 })],
      currentMachineHeadSha: "aaaaaaa",
    });
    await clickPush();

    await waitFor(() => {
      expect(window.ade.git.push).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("holds the push and names the machine when another machine is ahead", async () => {
    renderPane({
      otherMachineBranchStates: [otherMachine()],
      currentMachineHeadSha: "aaaaaaa",
    });
    await clickPush();

    const dialog = await screen.findByRole("dialog", { name: "MacBook Pro (97) also has this branch" });
    expect(window.ade.git.push).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain(
      "MacBook Pro (97) is 3 commits ahead of what you are about to push on feature/divergence. Pushing now makes that machine's copy diverge.",
    );
    // Never describes another machine as "remote".
    expect(dialog.textContent ?? "").not.toMatch(/\bremote\b/i);
  });

  it("cancel leaves the branch untouched", async () => {
    renderPane({
      otherMachineBranchStates: [otherMachine()],
      currentMachineHeadSha: "aaaaaaa",
    });
    await clickPush();
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(window.ade.git.push).not.toHaveBeenCalled();
  });

  it("push anyway dispatches the original push", async () => {
    renderPane({
      otherMachineBranchStates: [otherMachine()],
      currentMachineHeadSha: "aaaaaaa",
    });
    await clickPush();
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Push anyway" }));

    await waitFor(() => {
      expect(window.ade.git.push).toHaveBeenCalledWith({ laneId: "lane-1", forceWithLease: false });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The realistic case end to end: nothing in ADE records a head sha, so the
  // guard has to fire off the lane's `ahead` count alone or it never fires.
  it("warns from lane state alone, with no head sha on either side", async () => {
    renderPane({
      otherMachineBranchStates: [otherMachine({ headSha: null, ahead: 9 })],
    });
    await clickPush();

    const dialog = await screen.findByRole("dialog", {
      name: "MacBook Pro (97) also has this branch",
    });
    expect(dialog.textContent).toContain("is 9 commits ahead");
    expect(window.ade.git.push).not.toHaveBeenCalled();
  });

  it("never warns about this machine's own entry", async () => {
    renderPane({
      otherMachineBranchStates: [
        otherMachine({ machineId: "this-mac", machineName: "This Mac", headSha: null, ahead: 9 }),
      ],
    });
    await clickPush();

    await waitFor(() => {
      expect(window.ade.git.push).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the active remote binding as the current machine", async () => {
    mockStoreState.projectBinding = {
      kind: "remote",
      key: "remote:target-studio:project-a",
      rootPath: "/repo-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio (12)",
      projectId: "project-a",
    };
    renderPane({
      otherMachineBranchStates: [
        otherMachine({
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          headSha: null,
          ahead: 9,
        }),
      ],
    });
    await clickPush();

    await waitFor(() => {
      expect(window.ade.git.push).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
