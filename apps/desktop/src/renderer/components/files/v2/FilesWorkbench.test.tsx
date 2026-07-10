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
  FilesExplorer: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => (
    <div>
      <button type="button" data-testid="open-file" onClick={() => onOpenFile("src/a.ts")}>
        Open file
      </button>
    </div>
  ),
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
});
