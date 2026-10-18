/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffChanges, GitConflictState, GitStashSummary, GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";
import { __resetLaneGitActionRuntimeForTests, formatLaneGitError, LaneGitActionsPane } from "./LaneGitActionsPane";
import { laneGitListScope } from "./laneGitListCache";

const commitTimelineMock = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => null));

vi.mock("../ui/dialog/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/dialog/confirm")>()),
  confirmDialog: vi.fn(async () => true),
}));

vi.mock("./CommitTimeline", () => ({
  CommitTimeline: (props: Record<string, unknown>) => commitTimelineMock(props),
}));

vi.mock("./LaneDiffPane", () => ({
  LaneDiffPane: () => <div data-testid="lane-diff-pane-mock" />,
}));

let mockStoreState: {
  lanes: LaneSummary[];
  laneCacheByProject?: Record<string, { lanes: LaneSummary[] }>;
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
  projectStateKeyForBinding: (
    binding?: { kind?: string; key?: string | null; rootPath?: string | null } | null,
    fallbackRoot?: string | null,
  ) => {
    if (binding?.kind === "remote") return binding.key?.trim() || "";
    return (binding?.rootPath ?? fallbackRoot)?.trim() || "";
  },
  useAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
  // The pinned-lane hooks read the union from the ROOT store; this harness has
  // exactly one store, so both readings resolve to the same mock state.
  useRootAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
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

const CHANGE_LIST_VIEWPORT_PX = 600;
const CHANGE_LIST_ROW_PX = 28;
const GENERATED_FILE_ROW = /^src\/generated\/file-\d+\.ts$/;

/**
 * jsdom has no layout, and the Files list virtualizes against its viewport
 * height and each row's height (both read from offsetHeight). Give the list a
 * fixed viewport and fixed rows so the window mounts the way it does in the app.
 */
function stubChangeListLayout(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const inChangeList = (element: HTMLElement) =>
    element.closest("[data-testid='git-pane-branch'], [data-testid='git-pane-uncommitted']");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const testId = this.getAttribute("data-testid");
      if (testId === "git-pane-branch" || testId === "git-pane-uncommitted") return CHANGE_LIST_VIEWPORT_PX;
      if (this.hasAttribute("data-index") && inChangeList(this)) return CHANGE_LIST_ROW_PX;
      return original?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
  };
}

function changeListScroller(): HTMLElement {
  const scroller = document.querySelector<HTMLElement>("[data-testid='git-pane-branch'], [data-testid='git-pane-uncommitted']");
  if (!scroller) throw new Error("Files list is not mounted");
  return scroller;
}

/**
 * jsdom has no layout or scrolling, and a browser scrolls the list to bring a
 * focused row into view. The virtualizer clamps that scroll to
 * scrollHeight - clientHeight, so give the list its viewport and content heights,
 * and make scrollTo scroll and fire the scroll event a browser would. With
 * `deliverScrollEvents: false` the list still scrolls, but the virtualizer never
 * hears it.
 */
function stubListScrollTo(scroller: HTMLElement, { deliverScrollEvents = true }: { deliverScrollEvents?: boolean } = {}): void {
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => CHANGE_LIST_VIEWPORT_PX });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => parseFloat((scroller.firstElementChild as HTMLElement | null)?.style.height ?? "") || 0,
  });
  Object.defineProperty(scroller, "scrollTo", {
    configurable: true,
    value: ({ top }: ScrollToOptions) => {
      scroller.scrollTop = top ?? 0;
      // The browser fires the scroll event after the keyboard handler has returned.
      if (deliverScrollEvents) setTimeout(() => fireEvent.scroll(scroller), 0);
    },
  });
}

/** The aria-label of the focused control, or its tag when it has none. */
function focusedControlLabel(): string | null {
  return document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null;
}

/** Scrolls the Files list from the top, half a viewport at a time, until a row's text is mounted. */
async function scrollChangeListTo(text: string): Promise<HTMLElement> {
  const scroller = changeListScroller();
  fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
  for (let step = 1; step <= 400; step += 1) {
    const match = screen.queryByText(text);
    if (match) return match;
    fireEvent.scroll(scroller, { target: { scrollTop: step * (CHANGE_LIST_VIEWPORT_PX / 2) } });
  }
  throw new Error(`"${text}" never scrolled into the Files list`);
}

describe("LaneGitActionsPane rescue action", () => {
  const originalAde = globalThis.window.ade;
  let mockChangesByLaneId: Record<string, DiffChanges>;
  let mockStashesByLaneId: Record<string, GitStashSummary[]>;
  let mockConflictState: GitConflictState;
  let mockSyncStatus: GitUpstreamSyncStatus;
  let failDiffRefresh: boolean;
  let hangDiffRefresh: boolean;
  let restoreChangeListLayout: () => void = () => undefined;

  beforeEach(() => {
    mockStoreState = {
      laneCacheByProject: {},
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
    hangDiffRefresh = false;
    commitTimelineMock.mockClear();

    globalThis.window.ade = {
      diff: {
        getChanges: vi.fn(async ({ laneId }: { laneId: string }) => {
          if (failDiffRefresh) {
            throw new Error("diff refresh noisy");
          }
          if (hangDiffRefresh) {
            return new Promise<DiffChanges>(() => undefined);
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
        push: vi.fn(async () => ({ operationId: "git-push", preHeadSha: "abc", postHeadSha: "abc" })),
        sync: vi.fn(async () => ({ operationId: "git-sync", preHeadSha: "abc", postHeadSha: "abc" })),
        getSyncStatus: vi.fn(async () => mockSyncStatus),
        getConflictState: vi.fn(async () => mockConflictState),
      },
      lanes: {
        listAutoRebaseStatuses: vi.fn(async () => mockAutoRebaseStatuses),
        onAutoRebaseEvent: vi.fn(() => () => undefined),
        createFromUnstaged: vi.fn(async () => buildLane({ id: "lane-2", name: "Rescue lane", status: { dirty: true, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false } })),
      },
    } as any;
    restoreChangeListLayout = stubChangeListLayout();
  });

  afterEach(() => {
    cleanup();
    restoreChangeListLayout();
    __resetLaneGitActionRuntimeForTests();
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

  it("spends the pane's chrome row on the same push and pull actions", async () => {
    const user = userEvent.setup();
    renderPane();

    // The uppercase status header is replaced by one row: the branch, how far
    // it has drifted, and ghost glyphs for what you do about it.
    const chrome = await screen.findByTestId("git-pane-chrome");
    expect(chrome.textContent).toContain("feature/parent");
    expect(screen.queryByText("DIRTY")).toBeNull();

    await user.click(screen.getByTestId("git-pane-push"));
    await waitFor(() => expect(window.ade.git.push).toHaveBeenCalledWith(
      { laneId: "lane-1", forceWithLease: false },
      null,
    ));

    await user.click(screen.getByTestId("git-pane-pull"));
    await waitFor(() => expect(window.ade.git.sync).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1" }),
      null,
    ));
  });

  it("lets History follow a clean file list instead of a stretched empty half", async () => {
    mockChangesByLaneId["lane-1"] = { staged: [], unstaged: [] };
    renderPane();

    expect(await screen.findByTestId("git-pane-clean")).toBeTruthy();
    const sections = screen.getByTestId("git-sections");
    // The regression: stacked, the two sections split the pane evenly whatever
    // they held, so "Clean · nothing to commit" sat above ~320px of nothing.
    expect(sections.dataset.filesCollapsed).toBe("true");
  });

  it("keeps the even split while the file list has rows to scroll", async () => {
    renderPane();

    await screen.findByTestId("git-pane-chrome");
    const sections = screen.getByTestId("git-sections");
    expect(sections.dataset.filesCollapsed).toBeUndefined();
  });

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

    await screen.findByTestId("git-pane-rebase");

    expect(window.ade.diff.getChanges).toHaveBeenCalledTimes(1);
    expect(window.ade.git.stashList).toHaveBeenCalledTimes(1);
    expect(window.ade.git.getSyncStatus).toHaveBeenCalledTimes(1);
    expect(window.ade.git.getConflictState).toHaveBeenCalledTimes(1);
    expect(window.ade.lanes.onAutoRebaseEvent).toHaveBeenCalledTimes(1);
    expect(commitTimelineMock).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  function mockBranchChanges(paths: () => string[]) {
    (window.ade.diff as any).getBranchChanges = vi.fn(async () => {
      const files = paths().map((path) => ({ path, kind: "modified" as const, additions: 1, deletions: 0 }));
      return { baseRef: "main", mergeBase: "0123456789abcdef", files, additions: files.length, deletions: 0 };
    });
  }

  it("re-reads the Branch diff when a clean lane's pane becomes active again", async () => {
    let branchFiles = ["src/alpha.ts"];
    mockBranchChanges(() => branchFiles);
    const pane = (active: boolean) => (
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-2"
          active={active}
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>
    );
    const view = render(pane(true));
    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();

    // A commit made elsewhere: the working tree stays clean, the branch grows.
    view.rerender(pane(false));
    branchFiles = ["src/alpha.ts", "src/beta.ts"];
    view.rerender(pane(true));

    expect(await screen.findByTitle("src/beta.ts")).toBeTruthy();
  });

  it("reads the Branch diff even when the first working-tree read fails", async () => {
    failDiffRefresh = true;
    mockBranchChanges(() => ["src/alpha.ts"]);
    renderPane({ laneId: "lane-2" });

    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();
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
    expect(screen.getByTestId("git-pane-clean")).toBeTruthy();

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

  it("paints the last uncommitted changes on a revisit before the read lands", async () => {
    const first = renderPane();
    expect(await screen.findByText("src/file.ts")).toBeTruthy();
    first.unmount();

    hangDiffRefresh = true;
    renderPane();

    expect(screen.getByText("src/file.ts")).toBeTruthy();
  });

  it("never paints the pre-stage changes on a remount after a stage", async () => {
    const user = userEvent.setup();
    const first = renderPane();
    expect(await screen.findByText("src/file.ts")).toBeTruthy();

    hangDiffRefresh = true;
    await user.click(screen.getByRole("button", { name: "Stage src/file.ts" }));
    await waitFor(() => {
      expect(window.ade.git.stageFile).toHaveBeenCalled();
    });
    first.unmount();

    renderPane();

    expect(screen.queryByText("src/file.ts")).toBeNull();
  });

  it("keeps a revisit's first commit free of the cached Branch rows, and paints them in a later commit", async () => {
    mockBranchChanges(() => ["src/alpha.ts"]);
    const first = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();
    first.unmount();

    (window.ade.diff as any).getBranchChanges = vi.fn(() => new Promise(() => undefined));
    // What each commit shows: the React Profiler runs after its commit is in the DOM.
    const commits: Array<{ loading: boolean; rows: boolean }> = [];
    render(
      <React.Profiler
        id="pane"
        onRender={() =>
          commits.push({
            loading: document.body.textContent?.includes("Reading branch changes") ?? false,
            rows: document.querySelector('[title="src/alpha.ts"]') !== null,
          })
        }
      >
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
        </MemoryRouter>
      </React.Profiler>,
    );

    // The mount commit is the cold shell (the read's placeholder, no rows), as on main.
    expect(commits[0]).toEqual({ loading: true, rows: false });
    expect(commits.at(-1)).toEqual({ loading: false, rows: true });
    expect(screen.getByTitle("src/alpha.ts")).toBeTruthy();
    expect((window.ade.diff as any).getBranchChanges).toHaveBeenCalledTimes(1);
  });

  it("paints the last Branch diff on a revisit before the fresh read lands", async () => {
    mockBranchChanges(() => ["src/alpha.ts"]);
    const first = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();
    first.unmount();

    (window.ade.diff as any).getBranchChanges = vi.fn(() => new Promise(() => undefined));
    renderPane({ laneId: "lane-2" });

    expect(screen.getByTitle("src/alpha.ts")).toBeTruthy();
    expect((window.ade.diff as any).getBranchChanges).toHaveBeenCalledWith({ laneId: "lane-2" }, null);
  });

  it("clears a revisit's cached Branch summary when the fresh read fails", async () => {
    mockBranchChanges(() => ["src/alpha.ts"]);
    const first = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();
    first.unmount();

    let rejectRead: (error: Error) => void = () => undefined;
    (window.ade.diff as any).getBranchChanges = vi.fn(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    renderPane({ laneId: "lane-2" });
    expect(await screen.findByText(/vs main/)).toBeTruthy();

    await act(async () => { rejectRead(new Error("Lane worktree is missing. Restore it.")); });

    expect(await screen.findByText("Lane worktree is missing. Restore it.")).toBeTruthy();
    expect(screen.queryByText(/vs main/)).toBeNull();
    expect(screen.queryByTitle("src/alpha.ts")).toBeNull();
  });

  it("ends a revisit with the same Branch rows as a cold read of the same fixture", async () => {
    mockBranchChanges(() => ["src/alpha.ts", "src/beta.ts"]);
    const cold = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/beta.ts")).toBeTruthy();
    const coldHtml = cold.container.innerHTML;
    cold.unmount();

    const warm = renderPane({ laneId: "lane-2" });
    expect(warm.container.innerHTML).not.toContain("Reading branch changes");
    const freshRead = (window.ade.diff as any).getBranchChanges.mock.results[1].value;
    await act(async () => {
      await freshRead;
    });

    expect(warm.container.innerHTML).toBe(coldHtml);
  });

  it("never paints the old branch's Branch rows after the lane's branch changes", async () => {
    mockBranchChanges(() => ["src/alpha.ts"]);
    const view = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/alpha.ts")).toBeTruthy();

    (window.ade.diff as any).getBranchChanges = vi.fn(() => new Promise(() => undefined));
    mockStoreState.lanes = mockStoreState.lanes.map((lane) =>
      lane.id === "lane-2" ? { ...lane, branchRef: "feature/renamed" } : lane,
    );
    view.rerender(
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

    expect(await screen.findByText("Reading branch changes…")).toBeTruthy();
    expect(screen.queryByTitle("src/alpha.ts")).toBeNull();
  });

  it("never paints the old branch's rows when a read started before a branch rename lands", async () => {
    let resolveOldBranchRead: ((value: unknown) => void) | null = null;
    (window.ade.diff as any).getBranchChanges = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldBranchRead = resolve; }))
      .mockImplementation(() => new Promise(() => undefined));
    const view = renderPane({ laneId: "lane-2" });
    await waitFor(() => expect(resolveOldBranchRead).not.toBeNull());

    mockStoreState.lanes = mockStoreState.lanes.map((lane) =>
      lane.id === "lane-2" ? { ...lane, branchRef: "feature/renamed" } : lane,
    );
    view.rerender(
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

    await act(async () => {
      resolveOldBranchRead!({
        baseRef: "main",
        mergeBase: "0123456789abcdef",
        files: [{ path: "src/alpha.ts", kind: "modified", additions: 1, deletions: 0 }],
        additions: 1,
        deletions: 0,
      });
    });

    expect(screen.queryByTitle("src/alpha.ts")).toBeNull();
  });

  it("paints a revisit's cached Branch diff through the Files list window, not every row", async () => {
    mockBranchChanges(() => Array.from({ length: 188 }, (_, index) => `src/generated/file-${index}.ts`));
    const first = renderPane({ laneId: "lane-2" });
    expect(await screen.findByTitle("src/generated/file-0.ts")).toBeTruthy();
    first.unmount();

    (window.ade.diff as any).getBranchChanges = vi.fn(() => new Promise(() => undefined));
    renderPane({ laneId: "lane-2" });

    // The cached rows paint on mount, and only the window of them mounts.
    expect(screen.getByTitle("src/generated/file-0.ts")).toBeTruthy();
    const mounted = document.querySelectorAll("[data-testid='git-pane-branch'] [data-index]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
  });

  it("paints a revisit's cached uncommitted list through the Files list window, not every row", async () => {
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: Array.from({ length: 188 }, (_, index) => ({ path: `src/generated/file-${index}.ts`, kind: "modified" as const })),
    };
    const first = renderPane();
    expect(await screen.findByText("Unstaged (188)")).toBeTruthy();
    first.unmount();

    hangDiffRefresh = true;
    renderPane();

    expect(screen.getByText("src/generated/file-0.ts")).toBeTruthy();
    const mounted = document.querySelectorAll("[data-testid='git-pane-uncommitted'] [data-index]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
  });

  it("never caches a read that lands while a stage is still running", async () => {
    const user = userEvent.setup();
    const pane = (active: boolean) => (
      <MemoryRouter>
        <LaneGitActionsPane
          laneId="lane-1"
          active={active}
          autoRebaseEnabled={false}
          onOpenSettings={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCommit={vi.fn()}
          selectedPath={null}
          selectedMode={null}
          selectedCommit={null}
          selectedCommitSha={null}
        />
      </MemoryRouter>
    );
    const first = render(pane(true));
    expect(await screen.findByText("src/file.ts")).toBeTruthy();

    let finishStage: () => void = () => undefined;
    (window.ade.git as any).stageFile = vi.fn(() => new Promise((resolve) => {
      finishStage = () => resolve({ operationId: "stage-file", preHeadSha: "abc", postHeadSha: "abc" });
    }));
    void user.click(screen.getByRole("button", { name: "Stage src/file.ts" }));
    await waitFor(() => expect(window.ade.git.stageFile).toHaveBeenCalled());

    // A read that starts while the stage runs still sees the file unstaged, and lands.
    const readsBefore = (window.ade.diff.getChanges as any).mock.calls.length;
    first.rerender(pane(false));
    first.rerender(pane(true));
    await waitFor(() => expect((window.ade.diff.getChanges as any).mock.calls.length).toBeGreaterThan(readsBefore));
    await act(async () => undefined);

    hangDiffRefresh = true;
    await act(async () => {
      finishStage();
    });
    first.unmount();

    renderPane();

    expect(screen.queryByText("src/file.ts")).toBeNull();
  });

  it("keys the History list by the lane's cache scope and branch", async () => {
    renderPane({ laneId: "lane-2" });
    await screen.findByTestId("git-pane-rebase");

    expect(commitTimelineMock).toHaveBeenLastCalledWith(expect.objectContaining({
      cacheScope: laneGitListScope("/tmp/ade", "lane-2"),
      cacheBranchRef: "feature/second",
    }));
  });

  it("does not refresh the global lane store on initial mount", async () => {
    renderPane();

    await screen.findByTestId("git-pane-rebase");

    expect(mockStoreState.refreshLanes).not.toHaveBeenCalled();
    expect(window.ade.diff.getChanges).toHaveBeenCalledWith({ laneId: "lane-1" }, null);
    expect(window.ade.git.getSyncStatus).toHaveBeenCalledWith({ laneId: "lane-1" }, null);
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
    const pullButton = await screen.findByTestId("git-pane-pull");
    expect((pullButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /abort merge/i }));

    await waitFor(() => {
      expect((window.ade.git as any).mergeAbort).toHaveBeenCalledWith("lane-1", null);
    });
  });

  it.each([
    { where: "a lane on this machine", runtimePin: null },
    {
      where: "a lane on another machine",
      runtimePin: {
        kind: "remote",
        key: "remote:target-win:project-win",
        targetId: "target-win",
        projectId: "project-win",
        runtimeName: "Windows PC",
        displayName: "ADE",
        rootPath: "C:\\Users\\arul2\\ADE",
      },
    },
  ])("moves unstaged changes to a new lane on the lane's own machine for $where", async ({ runtimePin }) => {
    const user = userEvent.setup();
    renderPane({ runtimePin: runtimePin as any });

    const rescueButton = await screen.findByRole("button", { name: /create new lane with current changes/i });
    expect((rescueButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(rescueButton);
    await user.type(screen.getByPlaceholderText(/feature\/rescue-work/i), "Rescue lane");
    await user.click(screen.getByRole("button", { name: /create lane/i }));

    await waitFor(() => {
      expect(window.ade.lanes.createFromUnstaged).toHaveBeenCalledWith({
        sourceLaneId: "lane-1",
        name: "Rescue lane",
      }, runtimePin);
    });
    if (runtimePin) {
      // The new lane is on the other machine: this tab's lane list and Lanes
      // page cannot select it, so the pane stays and says where it went.
      expect(await screen.findByText(/moved unstaged changes to new lane rescue lane/i)).toBeTruthy();
      expect(mockStoreState.selectLane).not.toHaveBeenCalled();
      expect(screen.queryByText(/only works on the machine/i)).toBeNull();
    } else {
      expect(mockStoreState.refreshLanes).toHaveBeenCalled();
      expect(mockStoreState.selectLane).toHaveBeenCalledWith("lane-2");
    }
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
      }, null);
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
      }, null);
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
      }, null);
    });
  });

  it("includes untracked files when saving changes to a stash", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: [{ path: "scratch-note.txt", kind: "untracked" }],
    };

    renderPane();

    await user.click(await screen.findByTestId("git-pane-more"));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    await user.type(await screen.findByPlaceholderText("Optional note"), "stash untracked audit");
    await user.click(screen.getByRole("button", { name: "Save stash" }));

    await waitFor(() => {
      expect(window.ade.git.stashPush).toHaveBeenCalledWith({
        laneId: "lane-1",
        message: "stash untracked audit",
        includeUntracked: true,
      }, null);
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

    expect(await screen.findByText("Unstaged (305)")).toBeTruthy();
    expect(screen.getByText("src/generated/file-0.ts")).toBeTruthy();
    // The notice closes the list, so reaching it means scrolling there.
    await scrollChangeListTo("Showing first 300 of 305 unstaged files.");
    expect(screen.queryByText("src/generated/file-300.ts")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    await scrollChangeListTo("src/generated/file-300.ts");
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

    expect(await screen.findByText("Staged (305)")).toBeTruthy();
    expect(screen.getByText("src/staged/file-0.ts")).toBeTruthy();
    await scrollChangeListTo("Showing first 300 of 305 staged files.");
    expect(screen.queryByText("src/staged/file-300.ts")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    await scrollChangeListTo("src/staged/file-300.ts");
    expect(screen.getByText("src/staged/file-300.ts")).toBeTruthy();
  });

  it("reads every row of a long Files list in order as it scrolls", async () => {
    const paths = Array.from({ length: 300 }, (_, index) => `src/generated/file-${index}.ts`);
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: paths.map((path) => ({ path, kind: "modified" as const })),
    };

    renderPane();

    const firstRow = await screen.findByText("src/generated/file-0.ts");
    const scroller = firstRow.closest<HTMLElement>("[style*='overflow: auto']");
    if (!scroller) throw new Error("Files list is not scrollable");
    // Only the rows near the viewport are mounted, not all 300 files.
    expect(screen.queryAllByText(GENERATED_FILE_ROW).length).toBeLessThan(60);

    const seen: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      fireEvent.scroll(scroller, { target: { scrollTop: step * (CHANGE_LIST_VIEWPORT_PX / 2) } });
      for (const row of screen.queryAllByText(GENERATED_FILE_ROW)) {
        const label = row.textContent ?? "";
        if (!seen.includes(label)) seen.push(label);
      }
    }

    expect(seen).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("collapses and expands a folder in the Files list", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: [
        { path: "src/alpha/one.ts", kind: "modified" },
        { path: "src/alpha/two.ts", kind: "modified" },
        { path: "README.md", kind: "modified" },
      ],
    };

    renderPane();

    expect(await screen.findByText("src/alpha/one.ts")).toBeTruthy();
    const folder = screen.getByText("alpha").closest("button");
    if (!folder) throw new Error("folder row is not a button");

    await user.click(folder);
    expect(screen.queryByText("src/alpha/one.ts")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();

    await user.click(folder);
    expect(screen.getByText("src/alpha/one.ts")).toBeTruthy();
  });

  it("Tab walks every Files row's controls in order, past the mounted window", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 80 }, (_, index) => `src/generated/file-${index}.ts`).sort((a, b) => a.localeCompare(b));
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: paths.map((path) => ({ path, kind: "modified" as const })),
    };

    renderPane();

    await screen.findByText(paths[0]!);
    const scroller = changeListScroller();
    stubListScrollTo(scroller);
    const controls = paths.flatMap((path) => [`Stage ${path}`, `Discard changes to ${path}`]);

    screen.getByRole("button", { name: controls[0] }).focus();
    const reached: Array<string | null> = [];
    for (let step = 1; step < controls.length; step += 1) {
      await user.tab();
      reached.push(focusedControlLabel());
    }

    expect(reached).toEqual(controls.slice(1));
    await user.tab();
    expect(scroller.contains(document.activeElement)).toBe(false);
  });

  it("Shift+Tab walks the same controls back, from the last row", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 80 }, (_, index) => `src/generated/file-${index}.ts`).sort((a, b) => a.localeCompare(b));
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: paths.map((path) => ({ path, kind: "modified" as const })),
    };

    renderPane();

    await screen.findByText(paths[0]!);
    await scrollChangeListTo(paths[paths.length - 1]!);
    const scroller = changeListScroller();
    stubListScrollTo(scroller);
    const controls = paths.flatMap((path) => [`Stage ${path}`, `Discard changes to ${path}`]);

    screen.getByRole("button", { name: controls[controls.length - 1]! }).focus();
    const reached: Array<string | null> = [];
    for (let step = 0; step < controls.length - 1; step += 1) {
      await user.tab({ shift: true });
      reached.push(focusedControlLabel());
    }

    expect(reached).toEqual(controls.slice(0, -1).reverse());
    // The two folders above the first file come next, then focus leaves the list.
    for (const folder of ["generated", "src"]) {
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(screen.getByText(folder).closest("button"));
    }
    await user.tab({ shift: true });
    expect(scroller.contains(document.activeElement)).toBe(false);
  });

  it("keeps keyboard focus on a row that scrolls out of the mounted window", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 80 }, (_, index) => `src/generated/file-${index}.ts`).sort((a, b) => a.localeCompare(b));
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: paths.map((path) => ({ path, kind: "modified" as const })),
    };

    renderPane();

    await screen.findByText(paths[0]!);
    const scroller = changeListScroller();
    stubListScrollTo(scroller);
    const discard = screen.getByRole("button", { name: `Discard changes to ${paths[0]}` });
    discard.focus();

    // Far enough down that the focused row is no longer in the window.
    fireEvent.scroll(scroller, { target: { scrollTop: 2000 } });
    expect(discard.isConnected).toBe(true);
    expect(document.activeElement).toBe(discard);

    await user.tab();
    expect(focusedControlLabel()).toBe(`Stage ${paths[1]}`);
  });

  it("Tab still walks past the window when the list never hears its own scroll", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 80 }, (_, index) => `src/generated/file-${index}.ts`).sort((a, b) => a.localeCompare(b));
    mockChangesByLaneId["lane-1"] = {
      staged: [],
      unstaged: paths.map((path) => ({ path, kind: "modified" as const })),
    };

    renderPane();

    await screen.findByText(paths[0]!);
    const scroller = changeListScroller();
    // The list scrolls for Tab, but the scroll event never reaches the window, so the window keeps the rows it had.
    stubListScrollTo(scroller, { deliverScrollEvents: false });
    const controls = paths.flatMap((path) => [`Stage ${path}`, `Discard changes to ${path}`]);

    screen.getByRole("button", { name: controls[0]! }).focus();
    const reached: Array<string | null> = [];
    for (let step = 1; step < controls.length; step += 1) {
      await user.tab();
      reached.push(focusedControlLabel());
    }

    expect(reached).toEqual(controls.slice(1));
    await user.tab();
    expect(scroller.contains(document.activeElement)).toBe(false);
  });

  it("Branch mode: Tab reaches every folder, past the mounted window", async () => {
    const user = userEvent.setup();
    const folders = ["alpha", "beta", "gamma"];
    const paths = folders.flatMap((folder) => Array.from({ length: 40 }, (_, index) => `${folder}/file-${index}.ts`));
    mockBranchChanges(() => paths);

    // A clean lane opens on the Branch scope.
    renderPane({ laneId: "lane-2" });

    await screen.findByText("alpha/file-0.ts");
    const scroller = changeListScroller();
    stubListScrollTo(scroller);
    const folderButton = (name: string) => screen.getByText(name).closest("button");

    folderButton("alpha")!.focus();
    for (const folder of ["beta", "gamma"]) {
      await user.tab();
      expect(document.activeElement).toBe(folderButton(folder));
    }
    await user.tab();
    expect(scroller.contains(document.activeElement)).toBe(false);
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

    const rebaseButton = await screen.findByTestId("git-pane-rebase");
    expect(rebaseButton.getAttribute("aria-label")).toBe("Rebase on parent and push");
    expect((rebaseButton as HTMLButtonElement).disabled).toBe(true);
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
    screen.getByText("Auto-rebase failed");
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
    await user.click(screen.getByTestId("git-pane-more"));
    expect(screen.getByText("drop me")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "Delete stash" }));

    await waitFor(() => {
      expect(window.ade.git.stashDrop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-drop",
      }, null);
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
    await user.click(screen.getByTestId("git-pane-more"));
    expect(screen.getByText("restore me")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "RESTORE" })[0]);

    await waitFor(() => {
      expect(window.ade.git.stashPop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-restore",
      }, null);
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
    await user.click(screen.getByTestId("git-pane-more"));
    await user.click(screen.getByRole("button", { name: "COPY TO WORKTREE" }));

    await waitFor(() => {
      expect(window.ade.git.stashApply).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-copy",
      }, null);
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

    await user.click(screen.getByTestId("git-pane-refresh"));
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
    await user.click(screen.getByTestId("git-pane-more"));
    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "Delete stash" }));

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
    await user.click(screen.getByTestId("git-pane-more"));
    await user.click(screen.getByRole("button", { name: "Clear stashes" }));
    await user.type(await screen.findByPlaceholderText("Type 2 to confirm"), "2");
    await user.click(screen.getByRole("button", { name: "Delete all" }));

    await waitFor(() => {
      expect(window.ade.git.stashClear).toHaveBeenCalledWith({ laneId: "lane-1" }, null);
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
    await user.click(screen.getByTestId("git-pane-more"));
    await user.click(screen.getAllByRole("button", { name: "DELETE" })[0]);
    await user.type(await screen.findByPlaceholderText("Type delete to confirm"), "delete");
    await user.click(screen.getByRole("button", { name: "Delete stash" }));

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

    await user.click(await screen.findByTestId("git-pane-commit"));
    await waitFor(() => {
      expect(window.ade.git.generateCommitMessage).toHaveBeenCalledWith({ laneId: "lane-1", amend: false }, null);
    });
    expect(screen.getByText("GENERATING COMMIT MESSAGE...")).toBeTruthy();

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
      expect(screen.getByTestId("git-pane-commit")).toBeTruthy();
    });
    expect(screen.queryByText("GENERATING COMMIT MESSAGE...")).toBeNull();

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
      expect(screen.getByText("GENERATING COMMIT MESSAGE...")).toBeTruthy();
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
      expect(window.ade.git.commit).toHaveBeenCalledWith({ laneId: "lane-1", message: "feat: auto", amend: false }, null);
    });

    const commitInput = screen.getByPlaceholderText(/commit message/i) as HTMLInputElement;
    expect(commitInput.value).toBe("");
  });

  it("does not commit when generated message is empty", async () => {
    const user = userEvent.setup();
    mockChangesByLaneId["lane-1"] = {
      staged: [{ path: "src/file.ts", kind: "modified" }],
      unstaged: [],
    };
    (window.ade.git.generateCommitMessage as any).mockResolvedValueOnce({ message: "", model: null });

    renderPane();
    await user.click(await screen.findByTestId("git-pane-commit"));

    await waitFor(() => {
      expect(window.ade.git.generateCommitMessage).toHaveBeenCalledWith({ laneId: "lane-1", amend: false }, null);
    });
    expect(window.ade.git.commit).not.toHaveBeenCalled();
    expect(screen.getByText(/No turned chat on this lane to suggest a commit message/)).toBeTruthy();
  });
});

describe("formatLaneGitError", () => {
  const remotePin = {
    kind: "remote" as const,
    key: "remote:target-studio:project-a",
    targetId: "target-studio",
    projectId: "project-a",
    rootPath: "/remote/repo",
    displayName: "repo",
    runtimeName: "Mac Studio",
  };

  it("rewrites a remote ADE disconnect", () => {
    expect(formatLaneGitError(new Error("Remote ADE service connection closed."), remotePin))
      .toMatch(/That machine disconnected.*switch back to reconnect/i);
  });

  it("leaves a local git connection-closed error alone", () => {
    expect(formatLaneGitError(new Error("ssh: connection closed by remote host")))
      .toBe("ssh: connection closed by remote host");
  });
});
