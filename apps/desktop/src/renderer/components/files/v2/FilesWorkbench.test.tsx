// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesWorkspace } from "../../../../shared/types";
import { useEditorGroupsStore } from "./editorGroupsStore";
import { FilesWorkbench } from "./FilesWorkbench";

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
    <button type="button" data-testid="open-file" onClick={() => onOpenFile("src/a.ts")}>
      Open file
    </button>
  ),
}));

vi.mock("./WorkspacePicker", () => ({
  WorkspacePicker: ({ onChange }: { onChange: (workspaceId: string) => void }) => (
    <button type="button" data-testid="switch-workspace" onClick={() => onChange("workspace-b")}>
      Switch workspace
    </button>
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
  },
  {
    id: "workspace-b",
    kind: "worktree",
    name: "Lane B",
    rootPath: "/repo/.ade/worktrees/b",
    laneId: "lane-b",
    isReadOnlyByDefault: false,
  },
];

describe("FilesWorkbench", () => {
  beforeEach(() => {
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
    expect(window.ade.files.readFile).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "src/a.ts" });

    fireEvent.click(screen.getByTestId("mark-dirty"));
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));

    fireEvent.click(screen.getByTestId("switch-workspace"));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("dirty-count").textContent).toBe("1"));
  });
});
