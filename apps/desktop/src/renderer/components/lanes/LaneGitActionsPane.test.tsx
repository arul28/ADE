/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffChanges, GitConflictState, GitStashSummary, GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";
import { __resetLaneGitActionRuntimeForTests, LaneGitActionsPane } from "./LaneGitActionsPane";

const commitTimelineMock = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => null));

vi.mock("./CommitTimeline", () => ({
  CommitTimeline: (props: Record<string, unknown>) => commitTimelineMock(props),
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
    | {
        kind: "local" | "remote";
        key: string;
        rootPath: string;
      }
    | null;
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
  selectActiveProjectRoot: (state: {
    projectBinding?: { kind?: string; rootPath?: string | null } | null;
    project?: { rootPath?: string | null } | null;
  }) => {
    if (state.projectBinding?.kind === "remote") return state.projectBinding.rootPath?.trim() || null;
    return state.project?.rootPath?.trim() || null;
  },
  selectActiveProjectStateKey: (state: {
    projectBinding?: { kind?: string; key?: string | null } | null;
    project?: { rootPath?: string | null } | null;
  }) => {
    if (state.projectBinding?.kind === "remote") return state.projectBinding.key?.trim() || null;
    return state.project?.rootPath?.trim() || null;
  },
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

function buildStash(
  ref: string,
  subject: string,
  createdAt = "2026-03-31T12:00:00.000Z",
  oid = `${ref}-oid`,
): GitStashSummary {
  return {
    oid,
    ref,
    subject,
    createdAt,
  };
}

describe("LaneGitActionsPane rescue action", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;
  let mockChangesByLaneId: Record<string, DiffChanges>;
  let mockStashesByLaneId: Record<string, GitStashSummary[]>;
  let mockConflictState: GitConflictState;
  let mockSyncStatus: GitUpstreamSyncStatus;
  let failDiffRefresh: boolean;

  beforeEach(() => {
    globalThis.window.confirm = vi.fn(() => true);
    mockStoreState = {
      lanes: [
        buildLane(),
        buildLane({
          id: "lane-2",
          name: "Second lane",
          branchRef: "feature/second",
          worktreePath: "/tmp/ade/second",
          status: {
            dirty: false,
            ahead: 0,
            behind: 0,
            remoteBehind: -1,
            rebaseInProgress: false,
          },
        }),
      ],
      refreshLanes: vi.fn(async () => undefined),
      selectLane: vi.fn(),
      smartTooltipsEnabled: false,
      project: { rootPath: "/tmp/ade" },
      projectBinding: {
        kind: "local",
        key: "local:/tmp/ade",
        rootPath: "/tmp/ade",
      },
    };
    __resetLaneGitActionRuntimeForTests();
    mockChangesByLaneId = {
      "lane-1": {
        staged: [],
        unstaged: [{ path: "src/file.ts", kind: "modified" }],
      },
      "lane-2": {
        staged: [],
        unstaged: [],
      },
    };
    mockStashesByLaneId = {
      "lane-1": [],
      "lane-2": [],
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
      upstreamState: "none",
      upstreamRef: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      recommendedAction: "push",
    };
    mockAutoRebaseStatuses = [];
    failDiffRefresh = false;
    commitTimelineMock.mockClear();

    globalThis.window.ade = {
      diff: {
        getChanges: vi.fn(async ({ laneId }: { laneId: string }) => {
          if (failDiffRefresh) {
            throw new Error("diff refresh noisy");
          }
          return mockChangesByLaneId[laneId] ?? { staged: [], unstaged: [] };
        }),
      },
      git: {
        commit: vi.fn(async () => ({ operationId: "git-commit", preHeadSha: "abc", postHeadSha: "def" })),
        stageFile: vi.fn(async () => ({ operationId: "stage-file", preHeadSha: "abc", postHeadSha: "abc" })),
        stageAll: vi.fn(async () => ({ operationId: "stage-all", preHeadSha: "abc", postHeadSha: "abc" })),
        unstageFile: vi.fn(async () => ({ operationId: "unstage-file", preHeadSha: "abc", postHeadSha: "abc" })),
        discardFile: vi.fn(async () => ({ operationId: "discard-file", preHeadSha: "abc", postHeadSha: "abc" })),
        restoreStagedFile: vi.fn(async () => ({ operationId: "restore-staged-file", preHeadSha: "abc", postHeadSha: "abc" })),
        generateCommitMessage: vi.fn(async () => ({ message: "feat: auto", model: "openai/gpt-5.4-mini" })),
        stashList: vi.fn(async ({ laneId }: { laneId: string }) => mockStashesByLaneId[laneId] ?? []),
        stashPush: vi.fn(async () => ({ operationId: "stash-push", preHeadSha: "abc", postHeadSha: "abc" })),
        stashApply: vi.fn(async () => ({ operationId: "stash-apply", preHeadSha: "abc", postHeadSha: "abc" })),
        stashPop: vi.fn(async () => ({ operationId: "stash-pop", preHeadSha: "abc", postHeadSha: "abc" })),
        stashDrop: vi.fn(async () => ({ operationId: "stash-drop", preHeadSha: "abc", postHeadSha: "abc" })),
        stashClear: vi.fn(async () => ({ operationId: "stash-clear", preHeadSha: "abc", postHeadSha: "abc" })),
        getSyncStatus: vi.fn(async () => mockSyncStatus),
        getConflictState: vi.fn(async () => mockConflictState),
      },
      lanes: {
        listAutoRebaseStatuses: vi.fn(async () => mockAutoRebaseStatuses),
        onAutoRebaseEvent: vi.fn(() => () => undefined),
        createFromUnstaged: vi.fn(async () => buildLane({ id: "lane-2", name: "Rescue lane", status: { dirty: true, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false } })),
      },
      projectConfig: {
        get: vi.fn(async () => ({
          effective: {
            ai: {
              features: { commit_messages: true },
              featureModelOverrides: { commit_messages: "openai/gpt-5.4-mini" },
            },
          },
        })),
      },
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

  it("does not start Git Actions effects while inactive", async () => {
    renderPane({ active: false });

    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();
    expect(window.ade.git.stashList).not.toHaveBeenCalled();
    expect(window.ade.git.getSyncStatus).not.toHaveBeenCalled();
    expect(window.ade.git.getConflictState).not.toHaveBeenCalled();
    expect(window.ade.lanes.onAutoRebaseEvent).not.toHaveBeenCalled();
    expect(commitTimelineMock).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it("loads Git Actions once when an inactive pane becomes active", async () => {
    const view = renderPane({ active: false });
    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();

    view.rerender(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-1"
          active
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "SYNC" });

    expect(window.ade.diff.getChanges).toHaveBeenCalledTimes(1);
    expect(window.ade.git.stashList).toHaveBeenCalledTimes(1);
    expect(window.ade.git.getSyncStatus).toHaveBeenCalledTimes(1);
    expect(window.ade.git.getConflictState).toHaveBeenCalledTimes(1);
    expect(window.ade.lanes.onAutoRebaseEvent).toHaveBeenCalledTimes(1);
    expect(commitTimelineMock).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  it("isolates cached Git state for remote bindings with the same root and lane id", async () => {
    const sharedRoot = "/srv/shared";
    const bindingA = {
      kind: "remote" as const,
      key: "remote:studio-a:project-1",
      rootPath: sharedRoot,
    };
    const bindingB = {
      kind: "remote" as const,
      key: "remote:studio-b:project-1",
      rootPath: sharedRoot,
    };
    mockStoreState.project = { rootPath: sharedRoot };
    mockStoreState.projectBinding = bindingA;
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: [{ path: "src/studio-a.ts", kind: "modified" }],
    };

    const studioAView = renderPane({ active: true });
    expect(await screen.findByText("src/studio-a.ts")).toBeTruthy();
    studioAView.unmount();

    mockStoreState.projectBinding = bindingB;
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: [{ path: "src/studio-b.ts", kind: "modified" }],
    };
    const studioBView = renderPane({ active: false });
    expect(screen.queryByText("src/studio-a.ts")).toBeNull();
    expect(screen.getByText("No changes")).toBeTruthy();

    studioBView.rerender(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-1"
          active
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("src/studio-b.ts")).toBeTruthy();
    studioBView.unmount();

    mockStoreState.projectBinding = bindingA;
    renderPane({ active: false });
    expect(screen.getByText("src/studio-a.ts")).toBeTruthy();
    expect(screen.queryByText("src/studio-b.ts")).toBeNull();
  });

  it("does not refresh the global lane store on initial mount", async () => {
    renderPane();

    await screen.findByRole("button", { name: "SYNC" });

    expect(mockStoreState.refreshLanes).not.toHaveBeenCalled();
    expect(window.ade.diff.getChanges).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(window.ade.git.getSyncStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(window.ade.git.getSyncStatus).toHaveBeenCalledTimes(1);
    expect(window.ade.lanes.listAutoRebaseStatuses).not.toHaveBeenCalled();
  });

  it("blocks pull and surfaces merge recovery actions when a merge is in progress", async () => {
    const user = userEvent.setup();
    mockConflictState = {
      laneId: "lane-1",
      kind: "merge",
      inProgress: true,
      conflictedFiles: ["src/file.ts"],
      canContinue: false,
      canAbort: true,
    };
    mockSyncStatus = {
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: "origin/feature/parent",
      ahead: 0,
      behind: 2,
      diverged: false,
      recommendedAction: "pull",
    };
    (window.ade.git as any).mergeAbort = vi.fn(async () => ({ operationId: "merge-abort", preHeadSha: "abc", postHeadSha: "abc" }));
    (window.ade.git as any).mergeContinue = vi.fn(async () => ({ operationId: "merge-continue", preHeadSha: "abc", postHeadSha: "abc" }));

    renderPane();

    expect(await screen.findByText(/merge in progress/i)).toBeTruthy();
    const pullButton = await screen.findByRole("button", { name: /pull/i });
    expect((pullButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/next: resolve merge/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /abort merge/i }));

    await waitFor(() => {
      expect((window.ade.git as any).mergeAbort).toHaveBeenCalledWith("lane-1");
    });
  });

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
    mockChangesByLaneId["lane-1"] = {
      staged: [{ path: "src/file.ts", kind: "modified" }],
      unstaged: [{ path: "src/file.ts", kind: "modified" }],
    };

    renderPane();

    const rescueButton = await screen.findByRole("button", { name: /create new lane with current changes/i });
    expect((rescueButton as HTMLButtonElement).disabled).toBe(true);
    expect(rescueButton.getAttribute("title")).toMatch(/unstage all changes/i);
  });

  it("discards a staged partial file through the staged row action", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [{ path: ".claude/worktrees/fix-session-auto-naming", kind: "modified" }],
      unstaged: [{ path: ".claude/worktrees/fix-session-auto-naming", kind: "modified" }],
    };
    (window.ade.git.restoreStagedFile as any).mockImplementationOnce(async () => {
      mockChangesByLaneId["lane-1"] = { staged: [], unstaged: [] };
      return { operationId: "restore-staged-file", preHeadSha: "abc", postHeadSha: "abc" };
    });

    renderPane();

    await screen.findAllByText(".claude/worktrees/fix-session-auto-naming");
    await user.click(screen.getByRole("button", { name: /discard staged changes to \.claude\/worktrees\/fix-session-auto-naming/i }));

    await waitFor(() => {
      expect(window.ade.git.restoreStagedFile).toHaveBeenCalledWith({
        laneId: "lane-1",
        path: ".claude/worktrees/fix-session-auto-naming",
      });
    });
    await waitFor(() => {
      expect(mockStoreState.refreshLanes).toHaveBeenCalledWith({
        includeStatus: true,
        includeSnapshots: false,
      });
    });
    await waitFor(() => {
      expect(screen.queryByText(".claude/worktrees/fix-session-auto-naming")).toBeNull();
    });
  });

  it("labels and invokes per-file stage and unstage controls", async () => {
    const user = userEvent.setup();

    renderPane();

    const stageButton = await screen.findByRole("button", { name: "Stage src/file.ts" });
    expect(stageButton.getAttribute("title")).toBe("Stage src/file.ts");
    await user.click(stageButton);

    await waitFor(() => {
      expect(window.ade.git.stageFile).toHaveBeenCalledWith({
        laneId: "lane-1",
        path: "src/file.ts",
      });
    });

    cleanup();
    mockChangesByLaneId["lane-1"] = {
      staged: [{ path: "src/file.ts", kind: "modified" }],
      unstaged: [],
    };
    renderPane();

    const unstageButton = await screen.findByRole("button", { name: "Unstage src/file.ts" });
    expect(unstageButton.getAttribute("title")).toBe("Unstage src/file.ts");
    await user.click(unstageButton);

    await waitFor(() => {
      expect(window.ade.git.unstageFile).toHaveBeenCalledWith({
        laneId: "lane-1",
        path: "src/file.ts",
      });
    });
  });

  it("includes untracked files when saving changes to a stash", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: [{ path: "scratch-note.txt", kind: "untracked" }],
    };

    renderPane();

    await user.click(await screen.findByRole("button", { name: "SAVE CHANGES" }));
    await user.type(await screen.findByPlaceholderText("Optional note"), "stash untracked audit");
    await user.click(screen.getByRole("button", { name: "SAVE STASH" }));

    await waitFor(() => {
      expect(window.ade.git.stashPush).toHaveBeenCalledWith({
        laneId: "lane-1",
        message: "stash untracked audit",
        includeUntracked: true,
      });
    });
  });

  it("bounds rendered change rows for large file lists", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: Array.from({ length: 305 }, (_, index) => ({
        path: `src/generated/file-${index}.ts`,
        kind: "modified" as const,
      })),
    };

    renderPane();

    expect(await screen.findByText("UNSTAGED (305)")).toBeTruthy();
    expect(screen.getByText("src/generated/file-0.ts")).toBeTruthy();
    expect(screen.getByText("Showing first 300 of 305 unstaged files.")).toBeTruthy();
    expect(screen.queryByText("src/generated/file-300.ts")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    expect(screen.getByText("src/generated/file-300.ts")).toBeTruthy();
  });

  it("shows all staged change rows on request", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: Array.from({ length: 305 }, (_, index) => ({
        path: `src/staged/file-${index}.ts`,
        kind: "modified" as const,
      })),
      unstaged: [],
    };

    renderPane();

    expect(await screen.findByText("STAGED (305)")).toBeTruthy();
    expect(screen.getByText("src/staged/file-0.ts")).toBeTruthy();
    expect(screen.getByText("Showing first 300 of 305 staged files.")).toBeTruthy();
    expect(screen.queryByText("src/staged/file-300.ts")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    expect(screen.getByText("src/staged/file-300.ts")).toBeTruthy();
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

  it("explains why sync is disabled when the lane is behind but still dirty", async () => {
    mockStoreState = {
      ...mockStoreState,
      lanes: [
        buildLane({
          name: "PR-CONVERGENCE-CHILD",
          status: {
            dirty: true,
            ahead: 0,
            behind: 2,
            remoteBehind: 0,
            rebaseInProgress: false,
          },
        }),
      ],
    };

    renderPane();

    const syncButton = await screen.findByRole("button", { name: "SYNC" });
    expect((syncButton as HTMLButtonElement).disabled).toBe(true);
    expect(syncButton.getAttribute("title")).toMatch(/has uncommitted changes/i);
    expect(syncButton.getAttribute("title")).toMatch(/before rebasing and pushing/i);
  });

  it("treats auto-rebase conflicts as failures and links to the Rebase/Merge tab", async () => {
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

    renderPane({
      autoRebaseStatusSnapshot: mockAutoRebaseStatuses[0] ?? null,
      onResolveRebaseConflict: resolveRebaseConflict,
    });

    const rebaseTabButton = await screen.findByRole("button", { name: /open rebase\/merge tab/i });
    screen.getByText("AUTO-REBASE FAILED");
    screen.getByText(/auto-rebase failed\. files need follow-up before this lane can be pushed\./i);

    await user.click(rebaseTabButton);

    expect(resolveRebaseConflict).toHaveBeenCalledWith("lane-1", "lane-main");
  });

  it("updates the stash count after deleting a stash", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "drop me", "2026-03-31T12:00:00.000Z", "oid-drop"),
      buildStash("stash@{1}", "keep me", "2026-03-30T12:00:00.000Z"),
    ];
    (window.ade.git.stashDrop as any).mockImplementationOnce(async (
      { stashRef, stashOid }: { stashRef: string; stashOid?: string },
    ) => {
      expect(stashRef).toBe("stash@{0}");
      expect(stashOid).toBe("oid-drop");
      mockStashesByLaneId["lane-1"] = [buildStash("stash@{0}", "keep me", "2026-03-30T12:00:00.000Z")];
      return { operationId: "stash-drop", preHeadSha: "abc", postHeadSha: "abc" };
    });

    renderPane();

    await screen.findByText("2 saved");
    expect(screen.getByText("drop me")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "DELETE STASH" }));

    await waitFor(() => {
      expect(window.ade.git.stashDrop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-drop",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("1 saved")).toBeTruthy();
    });
    expect(screen.queryByText("drop me")).toBeNull();
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("updates the stash count after restoring a stash", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "restore me", "2026-03-31T12:00:00.000Z", "oid-restore"),
      buildStash("stash@{1}", "keep me", "2026-03-30T12:00:00.000Z"),
    ];
    (window.ade.git.stashPop as any).mockImplementationOnce(async (
      { stashRef, stashOid }: { stashRef: string; stashOid?: string },
    ) => {
      expect(stashRef).toBe("stash@{0}");
      expect(stashOid).toBe("oid-restore");
      mockStashesByLaneId["lane-1"] = [buildStash("stash@{0}", "keep me", "2026-03-30T12:00:00.000Z")];
      return { operationId: "stash-pop", preHeadSha: "abc", postHeadSha: "abc" };
    });

    renderPane();

    await screen.findByText("2 saved");
    expect(screen.getByText("restore me")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "RESTORE" })[0]);

    await waitFor(() => {
      expect(window.ade.git.stashPop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-restore",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("1 saved")).toBeTruthy();
    });
    expect(screen.queryByText("restore me")).toBeNull();
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("sends stash oid when copying a stash to the worktree", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "copy me", "2026-03-31T12:00:00.000Z", "oid-copy"),
    ];

    renderPane();

    await screen.findByText("1 saved");
    await user.click(screen.getByRole("button", { name: "COPY TO WORKTREE" }));

    await waitFor(() => {
      expect(window.ade.git.stashApply).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-copy",
      });
    });
  });

  it("closes advanced git actions on Escape and Refresh", async () => {
    const user = userEvent.setup();

    renderPane();

    await user.click(await screen.findByRole("button", { name: /more/i }));
    expect(screen.getByRole("button", { name: /fetch only/i })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /fetch only/i })).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByRole("button", { name: /fetch only/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /refresh git state/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /fetch only/i })).toBeNull();
    });
  });

  it("updates the stash section even if the broader refresh fails afterward", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "drop me"),
      buildStash("stash@{1}", "keep me", "2026-03-30T12:00:00.000Z"),
    ];
    (window.ade.git.stashDrop as any).mockImplementationOnce(async () => {
      mockStashesByLaneId["lane-1"] = [buildStash("stash@{0}", "keep me", "2026-03-30T12:00:00.000Z")];
      failDiffRefresh = true;
      return { operationId: "stash-drop", preHeadSha: "abc", postHeadSha: "abc" };
    });

    renderPane();

    await screen.findByText("2 saved");
    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "DELETE STASH" }));

    await waitFor(() => {
      expect(screen.getByText("1 saved")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("ERROR: diff refresh noisy")).toBeTruthy();
    });
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("clears all stash entries after confirmation", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "drop me"),
      buildStash("stash@{1}", "keep me", "2026-03-30T12:00:00.000Z"),
    ];
    (window.ade.git.stashClear as any).mockImplementationOnce(async () => {
      mockStashesByLaneId["lane-1"] = [];
      return { operationId: "stash-clear", preHeadSha: "abc", postHeadSha: "abc" };
    });

    renderPane();

    await screen.findByText("2 saved");
    await user.click(screen.getByRole("button", { name: "CLEAR STASHES" }));
    await user.type(await screen.findByPlaceholderText("Type 2 to confirm"), "2");
    await user.click(screen.getByRole("button", { name: "DELETE ALL" }));

    await waitFor(() => {
      expect(window.ade.git.stashClear).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
    await waitFor(() => {
      expect(screen.getByText("None saved")).toBeTruthy();
    });
  });

  it("leaves the stash list unchanged when deleting a stash fails", async () => {
    const user = userEvent.setup();
    mockStashesByLaneId["lane-1"] = [
      buildStash("stash@{0}", "drop me"),
      buildStash("stash@{1}", "keep me", "2026-03-30T12:00:00.000Z"),
    ];
    (window.ade.git.stashDrop as any).mockRejectedValueOnce(new Error("drop failed"));

    renderPane();

    await screen.findByText("2 saved");
    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "DELETE STASH" }));

    await waitFor(() => {
      expect(screen.getByText("ERROR: drop failed")).toBeTruthy();
    });
    expect(screen.getByText("2 saved")).toBeTruthy();
    expect(screen.getByText("drop me")).toBeTruthy();
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("keeps the generating commit state when leaving and returning to the lane", async () => {
    const user = userEvent.setup();
    let resolveGeneratedMessage: ((value: { message: string; model: string | null }) => void) | undefined;
    const generatedMessagePromise = new Promise<{ message: string; model: string | null }>((resolve) => {
      resolveGeneratedMessage = resolve;
    });
    mockChangesByLaneId["lane-1"] = {
      staged: [{ path: "src/file.ts", kind: "modified" }],
      unstaged: [],
    };
    (window.ade.git.generateCommitMessage as any).mockImplementation(() => generatedMessagePromise);

    const { rerender } = render(
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
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "COMMIT" }));
    await waitFor(() => {
      expect(window.ade.git.generateCommitMessage).toHaveBeenCalledWith({ laneId: "lane-1", amend: false });
    });
    expect(screen.getByRole("button", { name: "GENERATING..." })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-2"
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "COMMIT" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "GENERATING..." })).toBeNull();

    rerender(
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
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "GENERATING..." })).toBeTruthy();
    });

    rerender(
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-2"
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>,
    );

    resolveGeneratedMessage!({ message: "feat: auto", model: "openai/gpt-5.4-mini" });
    await waitFor(() => {
      expect(window.ade.git.commit).toHaveBeenCalledWith({ laneId: "lane-1", message: "feat: auto", amend: false });
    });

    const commitInput = screen.getByPlaceholderText(/commit message/i) as HTMLInputElement;
    expect(commitInput.value).toBe("");
  });
});
