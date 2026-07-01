// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesWorkspace } from "../../../../shared/types";
import { filesSessionKey } from "../treeHelpers";
import { useEditorGroupsStore } from "./editorGroupsStore";
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
  FilesExplorer: ({ canMutate, onOpenFile }: { canMutate?: boolean; onOpenFile: (path: string) => void }) => (
    <div>
      <div data-testid="explorer-can-mutate">{String(canMutate)}</div>
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
    resolveTabContext: (tab: { id: string }) => { canEdit: boolean };
    onDirtyChange: (tabId: string, dirty: boolean) => void;
  }) => {
    const tab = Object.values(props.state.groups).flatMap((group) => group.tabs)[0];
    return (
      <div>
        <div data-testid="tab-count">{tab ? 1 : 0}</div>
        <div data-testid="can-edit">{tab ? String(props.resolveTabContext(tab).canEdit) : "unknown"}</div>
        <div data-testid="dirty-count">{props.dirtyTabIds.size}</div>
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
    vi.restoreAllMocks();
    useEditorGroupsStore.setState({ sessions: {} });
    localStorage.clear();
  });

  it("preserves dirty open tabs when switching explorer workspaces", async () => {
    render(<FilesWorkbench active />);

    fireEvent.click(await screen.findByTestId("open-file"));
    await waitFor(() => expect(screen.getByTestId("tab-count").textContent).toBe("1"));
    expect(screen.getByTestId("can-edit").textContent).toBe("true");
    expect(window.ade.files.readFile).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "src/a.ts" });

    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));

    fireEvent.click(screen.getByTestId("switch-workspace"));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));
  });

  it("lets read-only-by-default workspaces opt into editing for the session", async () => {
    const { rerender } = render(<FilesWorkbench active />);

    fireEvent.click(await screen.findByTestId("switch-workspace"));

    await waitFor(() => expect(screen.getByTestId("explorer-can-mutate").textContent).toBe("false"));
    fireEvent.click(screen.getByTestId("open-file"));
    await waitFor(() => expect(screen.getByTestId("can-edit").textContent).toBe("false"));

    fireEvent.click(screen.getByRole("button", { name: /enable editing/i }));

    await waitFor(() => expect(screen.getByTestId("explorer-can-mutate").textContent).toBe("true"));
    expect(screen.getByTestId("can-edit").textContent).toBe("true");

    testState.appState.project = { rootPath: "/other-repo" };
    rerender(<FilesWorkbench active />);

    await waitFor(() => expect(screen.getByTestId("explorer-can-mutate").textContent).toBe("false"));
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
