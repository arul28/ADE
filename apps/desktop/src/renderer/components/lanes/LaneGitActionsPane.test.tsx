/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { useAppStore } from "../../state/appStore";
import type { GitConflictState, GitStashSummary, GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";

vi.mock("./CommitTimeline", () => ({
  CommitTimeline: ({ laneId }: { laneId: string | null }) => (
    <div data-testid="commit-timeline">timeline:{laneId ?? "none"}</div>
  ),
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Feature Lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/lane",
    worktreePath: "/tmp/lane-1",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 1,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: true, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-03-10T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

const defaultChanges = {
  staged: [{ path: "src/ready.ts", kind: "modified" as const }],
  unstaged: [{ path: "src/draft.ts", kind: "modified" as const }],
};

const defaultSyncStatus: GitUpstreamSyncStatus = {
  hasUpstream: true,
  upstreamRef: "origin/feature/lane",
  ahead: 2,
  behind: 0,
  diverged: false,
  recommendedAction: "push",
};

const defaultConflictState: GitConflictState = {
  laneId: "lane-1",
  kind: null,
  inProgress: false,
  conflictedFiles: [],
  canContinue: false,
  canAbort: false,
};

class MockResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback([
      {
        target,
        contentRect: { width: 1024, height: 720 } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  disconnect() {}
  unobserve() {}
}

function setupAde(overrides?: {
  syncStatus?: GitUpstreamSyncStatus;
  stashes?: GitStashSummary[];
  changes?: typeof defaultChanges;
  conflictState?: GitConflictState;
}) {
  const syncStatus = overrides?.syncStatus ?? defaultSyncStatus;
  const stashes = overrides?.stashes ?? [];
  const changes = overrides?.changes ?? defaultChanges;
  const conflictState = overrides?.conflictState ?? defaultConflictState;

  (window as any).ade = {
    diff: {
      getChanges: vi.fn(async () => changes),
    },
    git: {
      stashList: vi.fn(async () => stashes),
      getSyncStatus: vi.fn(async () => syncStatus),
      getConflictState: vi.fn(async () => conflictState),
      stageFile: vi.fn(async () => {}),
      unstageFile: vi.fn(async () => {}),
      stageAll: vi.fn(async () => {}),
      unstageAll: vi.fn(async () => {}),
      push: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      fetch: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      generateCommitMessage: vi.fn(async () => ({ message: "Generated commit" })),
      rebaseAbort: vi.fn(async () => {}),
      rebaseContinue: vi.fn(async () => {}),
      stashPush: vi.fn(async () => {}),
      stashApply: vi.fn(async () => {}),
      stashPop: vi.fn(async () => {}),
      stashDrop: vi.fn(async () => {}),
      listRecentCommits: vi.fn(async () => [{ sha: "abc123", shortSha: "abc123", subject: "Recent", authorName: "ADE", authoredAt: "2026-03-10T12:00:00.000Z" }]),
      revertCommit: vi.fn(async () => {}),
      cherryPickCommit: vi.fn(async () => {}),
    },
    lanes: {
      listAutoRebaseStatuses: vi.fn(async () => []),
      onAutoRebaseEvent: vi.fn(() => () => {}),
      rebaseStart: vi.fn(async () => ({
        runId: "run-1",
        run: {
          state: "completed",
          failedLaneId: null,
          error: null,
        },
      })),
    },
    projectConfig: {
      get: vi.fn(async () => ({
        effective: {
          ai: {
            features: { commit_messages: false },
            featureModelOverrides: {},
          },
        },
      })),
    },
  };
}

function renderPane() {
  return render(
    <LaneGitActionsPane
      laneId="lane-1"
      autoRebaseEnabled={false}
      onOpenSettings={vi.fn()}
      onSelectFile={vi.fn()}
      onSelectCommit={vi.fn()}
      selectedPath={null}
      selectedMode={null}
      selectedCommitSha={null}
    />
  );
}

describe("LaneGitActionsPane", () => {
  const originalStore = useAppStore.getState();

  beforeEach(() => {
    (globalThis as any).ResizeObserver = MockResizeObserver;
    useAppStore.setState({
      lanes: [makeLane()],
      refreshLanes: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    useAppStore.setState({
      lanes: originalStore.lanes,
      refreshLanes: originalStore.refreshLanes,
    });
  });

  it("renders primary sections in the compact order", async () => {
    setupAde();
    const { container } = renderPane();

    await waitFor(() => {
      expect((window as any).ade.diff.getChanges).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    const sectionIds = Array.from(container.querySelectorAll("[data-testid$='-section']")).map((node) => node.getAttribute("data-testid"));
    expect(sectionIds).toEqual([
      "sync-section",
      "commit-section",
      "files-section",
      "history-section",
      "advanced-section",
    ]);
  });

  it("shows stash controls inside files without hiding them behind an overflow menu", async () => {
    setupAde({
      stashes: [
        {
          ref: "stash@{0}",
          subject: "WIP login flow",
          createdAt: "2026-03-11T12:00:00.000Z",
        },
      ],
    });
    renderPane();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "STASH NOW" })).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "APPLY" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "POP" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DROP" })).toBeTruthy();
    expect(screen.getByText("STASHES")).toBeTruthy();
  });

  it("keeps amend in the commit flow and explains what it does", async () => {
    setupAde();
    renderPane();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "AMEND LAST COMMIT" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "AMEND LAST COMMIT" }));

    expect(screen.getByText(/Amend is on\. Your next commit will replace the latest commit/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "AMEND LAST COMMIT ON" })).toBeTruthy();
  });

  it("keeps advanced git actions visible but secondary", async () => {
    setupAde();
    renderPane();

    await waitFor(() => {
      expect(screen.getByText("Advanced Git")).toBeTruthy();
    });

    expect(screen.getByText("Force push (lease)")).toBeTruthy();
    expect(screen.getByText("Fetch only")).toBeTruthy();
    expect(screen.getByText("Revert commit")).toBeTruthy();
    expect(screen.getByText("Cherry-pick")).toBeTruthy();
  });

  it("shows publish flow for lanes without an upstream branch", async () => {
    setupAde({
      syncStatus: {
        hasUpstream: false,
        upstreamRef: null,
        ahead: 0,
        behind: 0,
        diverged: false,
        recommendedAction: "push",
      },
    });
    renderPane();

    await waitFor(() => {
      expect(screen.getAllByText("Publish lane").length).toBeGreaterThan(0);
    });

    expect(screen.getByText("REMOTE UNPUBLISHED")).toBeTruthy();
  });

  it("shows stacked-lane rebase affordances and divergence warnings", async () => {
    setupAde({
      syncStatus: {
        hasUpstream: true,
        upstreamRef: "origin/feature/lane",
        ahead: 2,
        behind: 1,
        diverged: true,
        recommendedAction: "pull",
      },
    });
    useAppStore.setState({
      lanes: [
        makeLane({
          id: "lane-parent",
          name: "Parent Lane",
          laneType: "primary",
          parentLaneId: null,
          branchRef: "main",
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
        }),
        makeLane({
          parentLaneId: "lane-parent",
          status: { dirty: true, ahead: 1, behind: 3, remoteBehind: 0, rebaseInProgress: false },
        }),
      ],
    });

    renderPane();

    await waitFor(() => {
      expect(screen.getAllByText("Rebase and push").length).toBeGreaterThan(0);
    });

    expect(screen.getByText("Force push (lease)")).toBeTruthy();
    expect(screen.getByText("CHECK FIRST")).toBeTruthy();
  });
});
