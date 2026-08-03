// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesWorkspace } from "../../../../shared/types";
import { filesProjectSessionKey, filesSessionKey } from "../treeHelpers";
import {
  createInitialGroupsState,
  editorTabId,
  openInGroup,
  type EditorTab,
  useEditorGroupsStore,
} from "./editorGroupsStore";
import { FilesWorkbench } from "./FilesWorkbench";
import {
  filesProjectCacheKey,
  filesTreeCacheKey,
  filesTreeCacheStats,
  releaseFilesProjectCaches,
  resetFilesTreeCachesForTests,
  writeCachedWorkspaces,
} from "./filesTreeCache";
import { recordRecentFile } from "./recentFiles";

const testState = vi.hoisted(() => ({
  appState: {
    project: { rootPath: "/repo" },
    projectBinding: { kind: "local" },
    selectedLaneId: "lane-a",
    lanes: [
      { id: "lane-a", color: "#ff0000" },
      { id: "lane-b", color: "#00ff00" },
    ],
  },
}));

vi.mock("../../../state/appStore", () => ({
  useAppStore: (selector: (state: typeof testState.appState) => unknown) => selector(testState.appState),
}));

vi.mock("../FilesExplorer", () => ({
  FilesExplorer: ({
    tree,
    onOpenFile,
    onToggleDirectory,
    onLoadMoreChildren,
  }: {
    tree: Array<{ path: string; children?: Array<unknown>; loadMoreOffset?: number | null }>;
    onOpenFile: (path: string) => void;
    onToggleDirectory: (path: string, isExpanded: boolean, hasLoadedChildren: boolean) => void;
    onLoadMoreChildren?: (path: string, offset: number) => void;
  }) => {
    const bigdir = tree.find((node) => node.path === "bigdir");
    return (
      <div>
        <button type="button" data-testid="open-file" onClick={() => onOpenFile("src/a.ts")}>
          Open file
        </button>
        <button
          type="button"
          data-testid="expand-bigdir"
          onClick={() => onToggleDirectory("bigdir", false, Array.isArray(bigdir?.children))}
        >
          Expand bigdir
        </button>
        <button
          type="button"
          data-testid="load-more-bigdir"
          onClick={() => {
            if (bigdir?.loadMoreOffset != null) onLoadMoreChildren?.("bigdir", bigdir.loadMoreOffset);
          }}
        >
          Load more
        </button>
        <div data-testid="bigdir-children">{bigdir?.children?.length ?? -1}</div>
        <div data-testid="bigdir-load-more-offset">{String(bigdir?.loadMoreOffset ?? "none")}</div>
      </div>
    );
  },
}));

vi.mock("./WorkspacePicker", () => ({
  WorkspacePicker: ({ onChange }: { onChange: (workspaceId: string) => void }) => (
    <div>
      <button type="button" data-testid="switch-workspace" onClick={() => onChange("workspace-b")}>
        Switch workspace
      </button>
      <button type="button" data-testid="switch-attached-workspace" onClick={() => onChange("workspace-c")}>
        Switch attached
      </button>
    </div>
  ),
}));

vi.mock("./EditorGroups", () => ({
  EditorGroups: (props: {
    state: { groups: Record<string, { tabs: Array<{ id: string }> }> };
    dirtyTabIds: ReadonlySet<string>;
    onDirtyChange: (tabId: string, dirty: boolean) => void;
  }) => {
    const tab = Object.values(props.state.groups).flatMap((group) => group.tabs)[0];
    return (
      <div>
        <div data-testid="tab-count">{tab ? 1 : 0}</div>
        <div data-testid="dirty-count">{props.dirtyTabIds.size}</div>
        <div data-testid="dirty-ids">{[...props.dirtyTabIds].join(",")}</div>
        <button
          type="button"
          data-testid="mark-dirty"
          onClick={() => {
            if (tab) props.onDirtyChange(tab.id, true);
          }}
        >
          Mark dirty
        </button>
      </div>
    );
  },
}));

const workspaces: FilesWorkspace[] = [
  {
    id: "workspace-primary",
    kind: "primary",
    name: "Primary",
    rootPath: "/repo",
    laneId: null,
    isReadOnlyByDefault: true,
    mobileReadOnly: true,
  },
  {
    id: "workspace-a",
    kind: "worktree",
    name: "Lane A",
    rootPath: "/repo/.ade/worktrees/a",
    laneId: "lane-a",
    isReadOnlyByDefault: false,
    mobileReadOnly: true,
  },
  {
    id: "workspace-b",
    kind: "worktree",
    name: "Lane B",
    rootPath: "/repo/.ade/worktrees/b",
    laneId: "lane-b",
    isReadOnlyByDefault: true,
    mobileReadOnly: true,
  },
  {
    id: "workspace-c",
    kind: "attached",
    name: "Attached",
    rootPath: "/repo-attached",
    laneId: null,
    isReadOnlyByDefault: false,
    mobileReadOnly: true,
  },
];

describe("FilesWorkbench", () => {
  beforeEach(() => {
    resetFilesTreeCachesForTests();
    testState.appState.project = { rootPath: "/repo" };
    testState.appState.selectedLaneId = "lane-a";
    useEditorGroupsStore.setState({ sessions: {} });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          writeClipboardText: vi.fn(),
          openPathInEditor: vi.fn(),
        },
        project: {
          getDroppedPath: vi.fn(),
        },
        files: {
          listWorkspaces: vi.fn(async () => workspaces),
          listTree: vi.fn(async () => []),
          refreshGitDecorations: vi.fn(async () => null),
          readFile: vi.fn(async () => ({
            path: "src/a.ts",
            content: "const a = 1;\n",
            encoding: "utf8",
            languageId: "typescript",
            isBinary: false,
          })),
          watchChanges: vi.fn(async () => undefined),
          stopWatching: vi.fn(async () => undefined),
          onChange: vi.fn(() => () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useEditorGroupsStore.setState({ sessions: {} });
    localStorage.clear();
  });

  it("says so when the host capped the git decorations, and clears it when it stops", async () => {
    const hint = /Some git decorations hidden/;
    // A capped response leaves deep files undecorated, which is otherwise
    // indistinguishable from those files being clean.
    (window.ade.files.refreshGitDecorations as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "workspace-a",
      files: [],
      directories: [],
      truncated: true,
    });
    const view = render(<FilesWorkbench active />);
    expect(await screen.findByText(hint)).toBeTruthy();

    view.unmount();
    (window.ade.files.refreshGitDecorations as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "workspace-a",
      files: [],
      directories: [],
    });
    render(<FilesWorkbench active />);
    await waitFor(() => expect(window.ade.files.refreshGitDecorations).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
  });

  it("preserves dirty open tabs when switching explorer workspaces", async () => {
    render(<FilesWorkbench active />);

    fireEvent.click(await screen.findByTestId("open-file"));
    await waitFor(() => expect(screen.getByTestId("tab-count").textContent).toBe("1"));
    expect(window.ade.files.readFile).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "src/a.ts" });

    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));

    fireEvent.click(screen.getByTestId("switch-workspace"));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));
  });

  it("makes edit-protected workspaces editable immediately with no enable step", async () => {
    render(<FilesWorkbench active />);

    // workspace-b is isReadOnlyByDefault: true — it must still be freely editable.
    fireEvent.click(await screen.findByTestId("switch-workspace"));

    fireEvent.click(screen.getByTestId("open-file"));
    await waitFor(() => {
      expect(window.ade.files.readFile).toHaveBeenCalledWith({
        workspaceId: "workspace-b",
        path: "src/a.ts",
      });
    });

    // There is no longer any "Enable editing" affordance.
    expect(screen.queryByRole("button", { name: /enable editing/i })).toBeNull();
  });

  it("opens a chat navigation target in the matching lane workspace without using the local external-path API", async () => {
    render(
      <FilesWorkbench
        active
        navigationOpenRequest={{
          path: "src/from-chat.ts",
          laneId: "lane-b",
          nonce: "router-entry-1",
          line: 42,
          column: 5,
        }}
      />,
    );

    await waitFor(() => {
      expect(window.ade.files.readFile).toHaveBeenCalledWith({
        workspaceId: "workspace-b",
        path: "src/from-chat.ts",
      });
    });
    expect(window.ade.files.openExternalPath).toBeUndefined();
    const openedTabs = Object.values(
      useEditorGroupsStore.getState().getSession(filesProjectSessionKey("/repo"))?.groups ?? {},
    ).flatMap((group) => group.tabs);
    expect(openedTabs).toContainEqual(expect.objectContaining({
      workspaceId: "workspace-b",
      laneId: "lane-b",
      path: "src/from-chat.ts",
      preview: false,
    }));
  });

  it("remaps stale restored workspace ids by lane, then falls back to primary", async () => {
    const restoredTab = (workspaceId: string, laneId: string | null, path: string): EditorTab => ({
      id: editorTabId(workspaceId, path),
      workspaceId,
      laneId,
      path,
      title: path.split("/").pop() ?? path,
      viewerKind: "code",
      languageId: "typescript",
      preview: false,
      pinned: false,
    });
    const laneMatch = restoredTab("stale-lane-workspace", "lane-b", "src/matched.ts");
    const staleDuplicate = restoredTab("stale-duplicate-workspace", "lane-b", "src/duplicate.ts");
    const authoritativeDuplicate = restoredTab("workspace-b", "lane-b", "src/duplicate.ts");
    const primaryFallback = restoredTab("stale-unmatched-workspace", "missing-lane", "src/fallback.ts");
    let restored = createInitialGroupsState();
    restored = openInGroup(restored, "group-1", laneMatch);
    restored = openInGroup(restored, "group-1", staleDuplicate);
    restored = openInGroup(restored, "group-1", authoritativeDuplicate);
    restored = openInGroup(restored, "group-1", primaryFallback);
    const sessionKey = filesProjectSessionKey("/repo");
    useEditorGroupsStore.setState({ sessions: { [sessionKey]: restored } });

    let resolveWorkspaces!: (value: FilesWorkspace[]) => void;
    const listedWorkspaces = new Promise<FilesWorkspace[]>((resolve) => {
      resolveWorkspaces = resolve;
    });
    window.ade.files.listWorkspaces = vi.fn(() => listedWorkspaces);
    // Cached-first render from a previous visit; the authoritative list (and
    // the remap it triggers) resolves later.
    writeCachedWorkspaces(filesProjectCacheKey({ kind: "local" }, "/repo"), workspaces);

    render(<FilesWorkbench active />);
    expect(useEditorGroupsStore.getState().getSession(sessionKey)?.groups["group-1"]?.tabs)
      .toContainEqual(laneMatch);
    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-ids").textContent).toBe(laneMatch.id));

    resolveWorkspaces(workspaces);

    await waitFor(() => {
      const group = useEditorGroupsStore.getState().getSession(sessionKey)?.groups["group-1"];
      expect(group?.tabs.map((tab) => tab.id)).toEqual([
        editorTabId("workspace-b", "src/matched.ts"),
        editorTabId("workspace-b", "src/duplicate.ts"),
        editorTabId("workspace-primary", "src/fallback.ts"),
      ]);
      expect(group?.activeTabId).toBe(editorTabId("workspace-primary", "src/fallback.ts"));
      expect(screen.getByTestId("dirty-ids").textContent)
        .toBe(editorTabId("workspace-b", "src/matched.ts"));
    });
  });

  it("retries workspace listing after transient failures", async () => {
    vi.useFakeTimers();
    const listWorkspaces = vi.fn()
      .mockRejectedValueOnce(new Error("runtime warming up"))
      .mockRejectedValueOnce(new Error("runtime still warming up"))
      .mockResolvedValue(workspaces);
    window.ade.files.listWorkspaces = listWorkspaces;

    render(<FilesWorkbench active />);
    await act(async () => undefined);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(listWorkspaces).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(listWorkspaces).toHaveBeenCalledTimes(3);
  });

  it("keeps recent files scoped to the selected lane workspace", async () => {
    recordRecentFile(filesSessionKey("/repo", "lane-a"), "src/lane-a.ts");
    recordRecentFile(filesSessionKey("/repo", "lane-b"), "src/lane-b.ts");

    render(<FilesWorkbench active />);

    await screen.findByRole("button", { name: /lane-a\.ts/i });
    expect(screen.queryByRole("button", { name: /lane-b\.ts/i })).toBeNull();

    fireEvent.click(screen.getByTestId("switch-workspace"));

    await screen.findByRole("button", { name: /lane-b\.ts/i });
    expect(screen.queryByRole("button", { name: /lane-a\.ts/i })).toBeNull();
  });

  it("keeps recent files scoped to attached workspace ids", async () => {
    recordRecentFile(filesSessionKey("/repo", "lane-a"), "src/lane-a.ts");
    recordRecentFile(filesSessionKey("/repo", "workspace-c"), "src/attached.ts");

    render(<FilesWorkbench active />);

    await screen.findByRole("button", { name: /lane-a\.ts/i });
    expect(screen.queryByRole("button", { name: /attached\.ts/i })).toBeNull();

    fireEvent.click(screen.getByTestId("switch-attached-workspace"));

    await screen.findByRole("button", { name: /attached\.ts/i });
    expect(screen.queryByRole("button", { name: /lane-a\.ts/i })).toBeNull();
  });

  const installLargeDirectoryMocks = (totalChildren: number) => {
    window.ade.files.listTree = vi.fn(async () => [
      { name: "bigdir", path: "bigdir", type: "directory" as const, changeStatus: null },
    ]);
    const listTreeChildren = vi.fn(async ({ offset = 0, limit = 500 }: { offset?: number; limit?: number }) => {
      const pageEnd = Math.min(offset + limit, totalChildren);
      const children = [];
      for (let i = offset; i < pageEnd; i++) {
        children.push({ name: `f-${i}.txt`, path: `bigdir/f-${i}.txt`, type: "file" as const, changeStatus: null });
      }
      return {
        parentPath: "bigdir",
        children,
        offset,
        limit,
        total: totalChildren,
        nextOffset: pageEnd < totalChildren ? pageEnd : null,
      };
    });
    window.ade.files.listTreeChildren = listTreeChildren;
    return listTreeChildren;
  };

  it("expands a large directory with a single page request instead of eagerly loading 10,000 children", async () => {
    const listTreeChildren = installLargeDirectoryMocks(12_000);
    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));

    fireEvent.click(screen.getByTestId("expand-bigdir"));

    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));
    expect(listTreeChildren).toHaveBeenCalledTimes(1);
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ parentPath: "bigdir", offset: 0 }));
    // Correct pagination cursor: the rest stays reachable via "Load more".
    expect(screen.getByTestId("bigdir-load-more-offset").textContent).toBe("2000");
  });

  it("appends exactly one page per load-more request", async () => {
    const listTreeChildren = installLargeDirectoryMocks(12_000);
    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));

    fireEvent.click(screen.getByTestId("load-more-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"));
    expect(listTreeChildren).toHaveBeenCalledTimes(2);
    expect(listTreeChildren).toHaveBeenLastCalledWith(expect.objectContaining({ parentPath: "bigdir", offset: 2000 }));
    expect(screen.getByTestId("bigdir-load-more-offset").textContent).toBe("4000");
  });

  it("watcher refresh rematerializes only the user-grown window, not the whole directory", async () => {
    const listTreeChildren = installLargeDirectoryMocks(12_000);
    type FileChangeHandler = Parameters<typeof window.ade.files.onChange>[0];
    let changeHandler: FileChangeHandler | null = null;
    window.ade.files.onChange = vi.fn((cb: FileChangeHandler) => {
      changeHandler = cb;
      return () => undefined;
    });

    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));
    fireEvent.click(screen.getByTestId("load-more-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"));

    listTreeChildren.mockClear();
    act(() => {
      changeHandler?.({ workspaceId: "workspace-a", path: "bigdir/f-1.txt", type: "created", ts: new Date().toISOString() });
    });

    // Debounced watcher refresh refetches the 4,000 loaded children (2 pages) —
    // freshness preserved without materializing the remaining 8,000 entries.
    // (Only structural events re-list; a content-only `modified` event refreshes
    // git decorations alone.)
    await waitFor(() => expect(listTreeChildren).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"));
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ offset: 2000 }));
  });

  it("serializes a watcher refresh behind an in-flight load-more so the grown window is preserved", async () => {
    const listTreeChildren = installLargeDirectoryMocks(12_000);
    type FileChangeHandler = Parameters<typeof window.ade.files.onChange>[0];
    let changeHandler: FileChangeHandler | null = null;
    window.ade.files.onChange = vi.fn((cb: FileChangeHandler) => {
      changeHandler = cb;
      return () => undefined;
    });

    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));
    listTreeChildren.mockClear();

    // Hold the load-more page in flight…
    let releaseLoadMore!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoadMore = resolve;
    });
    const paged = listTreeChildren.getMockImplementation()!;
    listTreeChildren.mockImplementationOnce(async (args: { offset?: number; limit?: number }) => {
      await gate;
      return paged(args);
    });
    fireEvent.click(screen.getByTestId("load-more-bigdir"));

    // …while a watcher event queues a refresh that would have snapshotted the
    // pre-append 2,000-entry window.
    act(() => {
      changeHandler?.({ workspaceId: "workspace-a", path: "bigdir/f-1.txt", type: "created", ts: new Date().toISOString() });
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // debounce fires; refresh is queued behind the load-more
    releaseLoadMore();

    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"), { timeout: 3_000 });
    // load-more (1 call) ran first; the refresh then re-listed the grown
    // 4,000-entry window (2 calls) instead of shrinking it back to one page.
    await waitFor(() => expect(listTreeChildren).toHaveBeenCalledTimes(3), { timeout: 3_000 });
    expect(screen.getByTestId("bigdir-children").textContent).toBe("4000");
    expect(screen.getByTestId("bigdir-load-more-offset").textContent).toBe("4000");
  });

  it("renders the cached tree instantly on remount, then refreshes authoritatively", async () => {
    installLargeDirectoryMocks(12_000);
    const first = render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));
    first.unmount();

    const listTree = window.ade.files.listTree as ReturnType<typeof vi.fn>;
    listTree.mockClear();
    render(<FilesWorkbench active />);
    // Cached-first: the expanded children render synchronously on remount…
    expect(screen.getByTestId("bigdir-children").textContent).toBe("2000");
    // …while the authoritative root refresh still runs.
    await waitFor(() => expect(listTree).toHaveBeenCalled());
    expect(screen.getByTestId("bigdir-children").textContent).toBe("2000");
  });

  it("reloads from the backend after cache eviction without touching open editor state", async () => {
    installLargeDirectoryMocks(12_000);
    const first = render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"));

    // Open a file and mark it dirty so we can prove eviction leaves editor state alone.
    fireEvent.click(screen.getByTestId("open-file"));
    await waitFor(() => expect(screen.getByTestId("tab-count").textContent).toBe("1"));
    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));

    // Releasing another project's caches while this one is mounted never
    // touches open tabs, dirty state, or the rendered tree.
    releaseFilesProjectCaches(filesProjectCacheKey({ kind: "local" }, "/other"));
    expect(screen.getByTestId("dirty-count").textContent).toBe("1");
    expect(screen.getByTestId("tab-count").textContent).toBe("1");
    expect(screen.getByTestId("bigdir-children").textContent).toBe("2000");

    first.unmount();
    // Project-surface eviction path: caches for this project are released.
    releaseFilesProjectCaches(filesProjectCacheKey({ kind: "local" }, "/repo"));
    expect(filesTreeCacheStats().entries).toBe(0);

    render(<FilesWorkbench active />);
    // No cached roster/tree — the workbench reloads through the authoritative
    // listWorkspaces + listTree path instead of rendering stale state.
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    // Open tabs live in the editor-groups store and survived the release untouched.
    await waitFor(() => expect(screen.getByTestId("tab-count").textContent).toBe("1"));
  });

  it("pins the mounted explorer tree so cache pressure cannot evict what is on screen", async () => {
    installLargeDirectoryMocks(12_000);
    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    await waitFor(() => expect(filesTreeCacheStats().pinnedKeys).toContain(filesTreeCacheKey(filesProjectCacheKey({ kind: "local" }, "/repo"), "workspace-a")));
  });
});
