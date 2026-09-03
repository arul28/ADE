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
import { requestFilesOpenInTools, resetFilesOpenRequestsForTests } from "./filesOpenRequests";

const dirtyBuffers = vi.hoisted(() => ({ replace: vi.fn(), clear: vi.fn() }));

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
  // The workbench reads pinned-machine liveness from the root store, which is
  // where the cross-machine slices live. Nothing here pins a machine, so the
  // empty slice map is the honest fixture.
  useRootAppStore: (selector: (state: {
    crossMachineLanesByMachineId: Record<string, unknown>;
    installedPlugins: unknown[];
  }) => unknown) =>
    selector({ crossMachineLanesByMachineId: {}, installedPlugins: [] }),
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

vi.mock("../monacoModelRegistry", () => ({
  createMonacoModelRegistry: () => ({
    getValue: () => "unsaved text",
    isDirty: () => true,
    markSaved: vi.fn(),
    dispose: vi.fn(),
    disposeAll: vi.fn(),
    rekey: vi.fn(),
    size: () => 1,
  }),
}));

vi.mock("../../../lib/dirtyWorkspaceBuffers", () => ({
  replaceDirtyBufferValuesForWorkspace: dirtyBuffers.replace,
  clearDirtyBuffersForWorkspace: dirtyBuffers.clear,
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


const remotePin = {
  kind: "remote" as const,
  key: "remote:mac-studio",
  targetId: "mac-studio",
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/repo",
  displayName: "ADE",
};

describe("FilesWorkbench", () => {
  beforeEach(() => {
    resetFilesTreeCachesForTests();
    resetFilesOpenRequestsForTests();
    dirtyBuffers.replace.mockClear();
    dirtyBuffers.clear.mockClear();
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
          listTreeChildren: vi.fn(async () => ({ children: [], nextOffset: null })),
          refreshGitDecorations: vi.fn(async () => null),
          readFile: vi.fn(async () => ({
            path: "src/a.ts",
            content: "const a = 1;\n",
            encoding: "utf8",
            languageId: "typescript",
            isBinary: false,
          })),
          openExternalPath: vi.fn(async () => ({
            workspace: workspaces[0],
            openPath: "outside.ts",
            pathType: "file" as const,
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
    expect(window.ade.files.readFile).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "src/a.ts" }, null);

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
      }, null);
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
      }, null);
    });
    // A chat navigation resolves through the workspace roster, never through
    // the local-only external-path API (which cannot cross machines).
    expect(window.ade.files.openExternalPath).not.toHaveBeenCalled();
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

  it("reads a chat file from the machine that owns it instead of rebinding the window", async () => {
    // A chat on another machine reports paths on THAT machine's disk. Before
    // the pin, every call resolved against whichever machine the project tab
    // happened to be bound to, so the Files tab opened empty.
    const pin = {
      kind: "remote" as const,
      key: "remote:mac-studio",
      targetId: "mac-studio",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/repo",
      displayName: "ADE",
    };
    render(
      <FilesWorkbench
        active
        navigationOpenRequest={{
          path: "src/from-chat.ts",
          laneId: "lane-b",
          nonce: "router-entry-pinned",
          pin,
        }}
      />,
    );

    await waitFor(() => {
      expect(window.ade.files.readFile).toHaveBeenCalledWith(
        { workspaceId: "workspace-b", path: "src/from-chat.ts" },
        pin,
      );
    });
    // Whose disk this is has to be visible, and there has to be a way back.
    expect(screen.getByText(/Mac Studio/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /back to this computer/i })).toBeTruthy();
  });

  it("reveals a directory in the tree instead of trying to open it as a file", async () => {
    // Folder names are clickable in chat prose too; opening one as a file only
    // ever produced a read error.
    render(
      <FilesWorkbench
        active
        navigationOpenRequest={{
          path: "docs/features",
          laneId: "lane-b",
          nonce: "router-entry-dir",
          pathType: "directory",
        }}
      />,
    );

    // listTree runs on every mount, so it proves nothing on its own — the
    // directory listing is what says the reveal actually happened.
    await waitFor(() => {
      expect(window.ade.files.listTreeChildren).toHaveBeenCalledWith(
        expect.objectContaining({ parentPath: "docs" }),
        null,
      );
    });
    // First argument only: `expect.anything()` does not match the explicit
    // `null` pin every unpinned call passes, so a two-argument negative here
    // would pass even if the read really happened.
    expect(window.ade.files.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "docs/features" }),
    );
  });

  it("does not replay a tools-pane request into the next panel that mounts", async () => {
    // The channel holds the request so a panel that has not mounted yet can
    // drain it. A panel that handled it live must clear that hold, or the next
    // mount — a lane switch, a project switch, reopening the tools tab —
    // re-opens a file nobody asked for.
    const view = render(<FilesWorkbench active embedded />);
    await waitFor(() => expect(window.ade.files.listWorkspaces).toHaveBeenCalled());
    requestFilesOpenInTools({
      path: "src/from-chat.ts",
      laneId: "lane-b",
      pin: null,
      pathType: "file",
      nonce: "tools-live",
    });
    await waitFor(() => expect(window.ade.files.readFile).toHaveBeenCalled());
    view.unmount();

    (window.ade.files.readFile as ReturnType<typeof vi.fn>).mockClear();
    render(<FilesWorkbench active embedded />);
    await waitFor(() => expect(window.ade.files.listWorkspaces).toHaveBeenCalled());
    expect(window.ade.files.readFile).not.toHaveBeenCalled();
  });

  it("opens a tools-pane request queued before the panel mounted", async () => {
    // Clicking a filename in a chat also switches the Work sidebar to Files, so
    // the request is made before this panel exists. It has to survive that gap.
    requestFilesOpenInTools({
      path: "src/from-chat.ts",
      laneId: "lane-b",
      pin: null,
      pathType: "file",
      nonce: "tools-1",
    });
    render(<FilesWorkbench active embedded />);

    await waitFor(() => {
      expect(window.ade.files.readFile).toHaveBeenCalledWith(
        { workspaceId: "workspace-b", path: "src/from-chat.ts" },
        null,
      );
    });
  });


  it("stops the file watcher on the machine it started it on", async () => {
    // The pin used to be read from a mutable ref, so the cleanup saw whatever
    // the pin was *now* rather than what it was at subscribe time. Leaving the
    // pinned machine is exactly when those differ: the stop then went to this
    // computer and the remote chokidar watcher was never closed.
    const view = render(
      <FilesWorkbench
        active
        navigationOpenRequest={{
          path: "src/from-chat.ts",
          laneId: "lane-b",
          nonce: "watch-pin",
          pin: remotePin,
        }}
      />,
    );
    await waitFor(() => {
      expect(window.ade.files.watchChanges).toHaveBeenCalledWith(expect.anything(), remotePin);
    });

    // Scope the assertion to the unpin itself: earlier workspace churn also
    // calls stopWatching, and a whole-history match would find those instead.
    (window.ade.files.stopWatching as ReturnType<typeof vi.fn>).mockClear();

    // Back to this computer: the watcher started on the remote must be stopped
    // there, not here.
    fireEvent.click(screen.getByRole("button", { name: /back to this computer/i }));
    await waitFor(() => expect(window.ade.files.stopWatching).toHaveBeenCalled());
    for (const call of (window.ade.files.stopWatching as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1] ?? null).toEqual(remotePin);
    }
    view.unmount();
  });

  it("never publishes another machine's unsaved buffers to local agents", async () => {
    // The dirty-buffer map is keyed by absolute path with no machine in the key,
    // and the main process serves it to agent file reads on THIS machine. Two
    // machines routinely check the same repo out at the same path, so a pinned
    // buffer would be handed to a local agent as if it were local.
    render(
      <FilesWorkbench
        active
        navigationOpenRequest={{
          path: "src/from-chat.ts",
          laneId: "lane-b",
          nonce: "pinned-dirty",
          pin: remotePin,
        }}
      />,
    );
    await waitFor(() => expect(window.ade.files.readFile).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));
    expect(dirtyBuffers.replace).not.toHaveBeenCalled();
  });

  it("keeps two open-request sources from cancelling each other's dedup key", async () => {
    // One last-key-wins slot served three keyspaces (external / navigation /
    // tools). An external open followed by a navigation left the slot holding
    // the navigation key, so the external effect stopped recognising its own
    // and re-opened a file the user had already dismissed.
    const view = render(
      <FilesWorkbench active externalOpenPath="/repo/outside.ts" externalOpenNonce="ext-1" />,
    );
    await waitFor(() => expect(window.ade.files.openExternalPath).toHaveBeenCalledTimes(1));

    // A navigation lands next, writing its own key.
    view.rerender(
      <FilesWorkbench
        active
        externalOpenPath="/repo/outside.ts"
        externalOpenNonce="ext-1"
        navigationOpenRequest={{ path: "src/a.ts", laneId: "lane-b", nonce: "nav-1" }}
      />,
    );
    await waitFor(() => expect(window.ade.files.readFile).toHaveBeenCalled());

    // Tab away and back: this re-runs the external effect with an unchanged
    // key, which is the moment a single last-key-wins slot has lost that key to
    // the navigation above.
    view.rerender(
      <FilesWorkbench
        active={false}
        externalOpenPath="/repo/outside.ts"
        externalOpenNonce="ext-1"
        navigationOpenRequest={{ path: "src/a.ts", laneId: "lane-b", nonce: "nav-1" }}
      />,
    );
    view.rerender(
      <FilesWorkbench
        active
        externalOpenPath="/repo/outside.ts"
        externalOpenNonce="ext-1"
        navigationOpenRequest={{ path: "src/a.ts", laneId: "lane-b", nonce: "nav-1" }}
      />,
    );
    await waitFor(() => expect(window.ade.files.listWorkspaces).toHaveBeenCalled());
    expect(window.ade.files.openExternalPath).toHaveBeenCalledTimes(1);
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

  const largeDirectoryPage = { timeout: 5_000 };

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

    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);
    expect(listTreeChildren).toHaveBeenCalledTimes(1);
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ parentPath: "bigdir", offset: 0 }), null);
    // Correct pagination cursor: the rest stays reachable via "Load more".
    expect(screen.getByTestId("bigdir-load-more-offset").textContent).toBe("2000");
  });

  it("appends exactly one page per load-more request", async () => {
    const listTreeChildren = installLargeDirectoryMocks(12_000);
    render(<FilesWorkbench active />);
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("-1"));
    fireEvent.click(screen.getByTestId("expand-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);

    fireEvent.click(screen.getByTestId("load-more-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"), largeDirectoryPage);
    expect(listTreeChildren).toHaveBeenCalledTimes(2);
    expect(listTreeChildren).toHaveBeenLastCalledWith(expect.objectContaining({ parentPath: "bigdir", offset: 2000 }), null);
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
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);
    fireEvent.click(screen.getByTestId("load-more-bigdir"));
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"), largeDirectoryPage);

    listTreeChildren.mockClear();
    act(() => {
      changeHandler?.({ workspaceId: "workspace-a", path: "bigdir/f-1.txt", type: "created", ts: new Date().toISOString() });
    });

    // Debounced watcher refresh refetches the 4,000 loaded children (2 pages) —
    // freshness preserved without materializing the remaining 8,000 entries.
    // (Only structural events re-list; a content-only `modified` event refreshes
    // git decorations alone.)
    await waitFor(() => expect(listTreeChildren).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("4000"), largeDirectoryPage);
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }), null);
    expect(listTreeChildren).toHaveBeenCalledWith(expect.objectContaining({ offset: 2000 }), null);
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
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);
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
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);
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
    await waitFor(() => expect(screen.getByTestId("bigdir-children").textContent).toBe("2000"), largeDirectoryPage);

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
