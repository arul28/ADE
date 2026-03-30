/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffChanges, GitConflictState, GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";
import { LaneGitActionsPane } from "./LaneGitActionsPane";

vi.mock("./CommitTimeline", () => ({
  CommitTimeline: () => null,
}));

let mockStoreState: {
  lanes: LaneSummary[];
  refreshLanes: ReturnType<typeof vi.fn>;
  selectLane: ReturnType<typeof vi.fn>;
};

let mockAutoRebaseStatuses: Array<{
  laneId: string;
  parentLaneId: string | null;
  parentHeadSha: string | null;
  state: "autoRebased" | "rebasePending" | "rebaseConflict" | "rebaseFailed";
  updatedAt: string;
  conflictCount: number;
  message: string | null;
}> = [];

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

function buildLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Parent lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/parent",
    worktreePath: "/tmp/ade/parent",
    parentLaneId: "lane-main",
    childCount: 0,
    stackDepth: 1,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: true,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-25T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("LaneGitActionsPane rescue action", () => {
  const originalAde = globalThis.window.ade;
  let mockChanges: DiffChanges;
  let mockConflictState: GitConflictState;
  let mockSyncStatus: GitUpstreamSyncStatus;

  beforeEach(() => {
    mockStoreState = {
      lanes: [buildLane()],
      refreshLanes: vi.fn(async () => undefined),
      selectLane: vi.fn(),
    };
    mockChanges = {
      staged: [],
      unstaged: [{ path: "src/file.ts", kind: "modified" }],
    };
    mockConflictState = {
      laneId: "lane-1",
      kind: null,
      inProgress: false,
      conflictedFiles: [],
      canContinue: false,
      canAbort: false,
    };
    mockSyncStatus = {
      hasUpstream: false,
      upstreamRef: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      recommendedAction: "push",
    };
    mockAutoRebaseStatuses = [];

    globalThis.window.ade = {
      diff: {
        getChanges: vi.fn(async () => mockChanges),
      },
      git: {
        stashList: vi.fn(async () => []),
        getSyncStatus: vi.fn(async () => mockSyncStatus),
        getConflictState: vi.fn(async () => mockConflictState),
      },
      lanes: {
        listAutoRebaseStatuses: vi.fn(async () => mockAutoRebaseStatuses),
        onAutoRebaseEvent: vi.fn(() => () => undefined),
        createFromUnstaged: vi.fn(async () => buildLane({ id: "lane-2", name: "Rescue lane", status: { dirty: true, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false } })),
      },
      projectConfig: {
        get: vi.fn(async () => ({ effective: { ai: {} } })),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  function renderPane(overrides?: Partial<React.ComponentProps<typeof LaneGitActionsPane>>) {
    render(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-1"
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommitSha={null}
          {...overrides}
        />
      </MemoryRouter>,
    );
  }

  it("enables the rescue button for unstaged-only changes and submits the quick prompt", async () => {
    const user = userEvent.setup();
    renderPane();

    const rescueButton = await screen.findByRole("button", { name: /create new lane with current changes/i });
    expect((rescueButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(rescueButton);
    await user.type(screen.getByPlaceholderText(/feature\/rescue-work/i), "Rescue lane");
    await user.click(screen.getByRole("button", { name: /create lane/i }));

    await waitFor(() => {
      expect(window.ade.lanes.createFromUnstaged).toHaveBeenCalledWith({
        sourceLaneId: "lane-1",
        name: "Rescue lane",
      });
    });
    expect(mockStoreState.refreshLanes).toHaveBeenCalled();
    expect(mockStoreState.selectLane).toHaveBeenCalledWith("lane-2");
  });

  it("disables the rescue button when staged changes are present", async () => {
    mockChanges = {
      staged: [{ path: "src/file.ts", kind: "modified" }],
      unstaged: [{ path: "src/file.ts", kind: "modified" }],
    };

    renderPane();

    const rescueButton = await screen.findByRole("button", { name: /create new lane with current changes/i });
    expect((rescueButton as HTMLButtonElement).disabled).toBe(true);
    expect(rescueButton.getAttribute("title")).toMatch(/unstage all changes/i);
  });

  it("disables the rescue button during an in-progress merge or rebase", async () => {
    mockConflictState = {
      laneId: "lane-1",
      kind: "merge",
      inProgress: true,
      conflictedFiles: ["src/file.ts"],
      canContinue: false,
      canAbort: true,
    };

    renderPane();

    const rescueButton = await screen.findByRole("button", { name: /create new lane with current changes/i });
    expect((rescueButton as HTMLButtonElement).disabled).toBe(true);
    expect(rescueButton.getAttribute("title")).toMatch(/finish the current merge/i);
  });

  it("treats auto-rebase conflicts as failures and links to the Rebase tab", async () => {
    const user = userEvent.setup();
    const resolveRebaseConflict = vi.fn();
    mockAutoRebaseStatuses = [
      {
        laneId: "lane-1",
        parentLaneId: "lane-main",
        parentHeadSha: "parent-sha",
        state: "rebaseConflict",
        updatedAt: "2026-03-30T12:00:00.000Z",
        conflictCount: 2,
        message: "Files need follow-up before this lane can be pushed.",
      },
    ];

    renderPane({ onResolveRebaseConflict: resolveRebaseConflict });

    const rebaseTabButton = await screen.findByRole("button", { name: /open rebase tab/i });
    screen.getByText("AUTO-REBASE FAILED");
    screen.getByText(/auto-rebase failed\. files need follow-up before this lane can be pushed\./i);

    await user.click(rebaseTabButton);

    expect(resolveRebaseConflict).toHaveBeenCalledWith("lane-1", "lane-main");
  });
});
