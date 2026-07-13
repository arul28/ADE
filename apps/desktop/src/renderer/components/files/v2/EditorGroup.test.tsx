// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import { editorTabId } from "./editorGroupsStore";
import { EditorGroup, type EditorGroupProps } from "./EditorGroup";

vi.mock("./useFileContent", () => ({
  updateCachedFileContentText: vi.fn(),
}));
// eslint-disable-next-line import/first
import { updateCachedFileContentText } from "./useFileContent";

vi.mock("./ViewerHost", () => {
  return {
    ViewerHost: () => (
      <div>
        <button data-testid="viewer-button">Viewer</button>
        <input data-testid="viewer-input" />
      </div>
    ),
  };
});

const writeText = vi.fn();
const markSaved = vi.fn();
const isDirty = vi.fn(() => true);

const registry = {
  getValue: vi.fn(() => "saved text"),
  markSaved,
  isDirty,
} as unknown as MonacoModelRegistry;

const tabId = editorTabId("workspace-1", "src/file.ts");
const otherLaneTabId = editorTabId("workspace-2", "src/other.ts");

const baseProps: EditorGroupProps = {
  group: {
    id: "group-1",
    activeTabId: tabId,
    recentTabIds: [tabId],
    tabs: [
      {
        id: tabId,
        workspaceId: "workspace-1",
        laneId: "lane-1",
        path: "src/file.ts",
        title: "file.ts",
        viewerKind: "code",
        languageId: "typescript",
        preview: false,
        pinned: true,
      },
    ],
  },
  isActiveGroup: true,
  explorerWorkspaceId: "workspace-1",
  explorerLaneId: "lane-1",
  lanes: [{ id: "lane-1", color: "#ff0000" } as never],
  tabScope: "all",
  resolveTabContext: () => ({
    workspaceId: "workspace-1",
    rootPath: "/repo",
    laneId: "lane-1",
    canRevealInFinder: true,
  }),
  theme: "dark",
  registry,
  dirtyTabIds: new Set([tabId]),
  reloadTokensByTabId: {},
  onActivateTab: vi.fn(),
  onCloseTab: vi.fn(),
  onCloseOthers: vi.fn(),
  onPinTab: vi.fn(),
  onSplitTab: vi.fn(),
  onPromoteTab: vi.fn(),
  onFocusGroup: vi.fn(),
  onSplit: vi.fn(),
  onDirtyChange: vi.fn(),
  onError: vi.fn(),
  onTabDragStart: vi.fn(),
  onTabDragEnd: vi.fn(),
  onTabDrop: vi.fn(),
  isTabDragging: false,
  onBodyDrop: vi.fn(),
};

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  markSaved.mockClear();
  isDirty.mockReset();
  isDirty.mockReturnValue(true);
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      app: {
        writeClipboardText: vi.fn(),
        openPathInEditor: vi.fn(),
      },
      files: {
        writeText,
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("EditorGroup", () => {
  it("renders the active tab and viewer", () => {
    render(<EditorGroup {...baseProps} />);
    expect(screen.getByRole("tab", { name: /file\.ts/i })).toBeTruthy();
    expect(screen.getByTestId("viewer-button")).toBeTruthy();
    expect(screen.getByTitle("Save (⌘S)")).toBeTruthy();
  });

  it("marks the visible fallback tab active when lane scope hides the stored active tab", () => {
    render(
      <EditorGroup
        {...baseProps}
        tabScope="lane"
        group={{
          ...baseProps.group,
          activeTabId: otherLaneTabId,
          tabs: [
            ...baseProps.group.tabs,
            {
              id: otherLaneTabId,
              workspaceId: "workspace-2",
              laneId: "lane-2",
              path: "src/other.ts",
              title: "other.ts",
              viewerKind: "code",
              languageId: "typescript",
              preview: false,
              pinned: false,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: /file\.ts/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: /other\.ts/i })).toBeNull();
  });

  it("does not steal Cmd+S from focused text inputs", () => {
    render(<EditorGroup {...baseProps} />);
    const input = screen.getByTestId("viewer-input");
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    expect(writeText).not.toHaveBeenCalled();
  });

  const tabOfKind = (viewerKind: "markdown" | "csv" | "binary" | "image", path: string) => ({
    ...baseProps,
    group: {
      ...baseProps.group,
      activeTabId: editorTabId("workspace-1", path),
      recentTabIds: [editorTabId("workspace-1", path)],
      tabs: [{
        id: editorTabId("workspace-1", path),
        workspaceId: "workspace-1",
        laneId: "lane-1",
        path,
        title: path.split("/").pop()!,
        viewerKind,
        languageId: "plaintext",
        preview: false,
        pinned: false,
      }],
    },
  });

  it("saves a dirty markdown tab immediately via Cmd+S — no enable step, no read-only gate", async () => {
    const props = tabOfKind("markdown", "docs/notes.md");
    const onDirtyChange = vi.fn();
    render(<EditorGroup {...props} onDirtyChange={onDirtyChange} />);

    expect(screen.getByTitle("Save (⌘S)")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("viewer-button"), { key: "s", metaKey: true });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        path: "docs/notes.md",
        text: "saved text",
      });
    });
    await waitFor(() => {
      expect(markSaved).toHaveBeenCalledWith(editorTabId("workspace-1", "docs/notes.md"));
      expect(onDirtyChange).toHaveBeenCalledWith(editorTabId("workspace-1", "docs/notes.md"), false);
    });
    // The cached payload is synced with the write so clean-model consumers
    // (markdown preview, CSV table) render the saved text before the watcher
    // echoes the change back.
    expect(updateCachedFileContentText).toHaveBeenCalledWith("workspace-1", "docs/notes.md", "saved text");
  });

  it("saves a csv tab through the toolbar Save button", async () => {
    const props = tabOfKind("csv", "data/rows.csv");
    render(<EditorGroup {...props} />);
    fireEvent.click(screen.getByTitle("Save (⌘S)"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        path: "data/rows.csv",
        text: "saved text",
      });
    });
  });

  it("reports write failures honestly instead of claiming success", async () => {
    const props = tabOfKind("markdown", "docs/notes.md");
    const onError = vi.fn();
    writeText.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    render(<EditorGroup {...props} onError={onError} />);

    fireEvent.click(screen.getByTitle("Save (⌘S)"));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    });
    expect(markSaved).not.toHaveBeenCalled();
  });

  it("never writes a clean retained model over external changes (stale-buffer guard)", async () => {
    // A markdown/csv tab whose Source mode created a model, then went back to
    // Preview/Table: the parked model can be stale after an external reload.
    // The toolbar/Cmd+S fallback must refuse to save a clean model.
    const props = tabOfKind("markdown", "docs/notes.md");
    isDirty.mockReturnValue(false);
    render(<EditorGroup {...props} />);

    // The clean-model guard returns synchronously before any write is issued.
    fireEvent.click(screen.getByTitle("Save (⌘S)"));
    expect(writeText).not.toHaveBeenCalled();
    expect(markSaved).not.toHaveBeenCalled();
  });

  it("exposes no save affordance for non-text viewers", () => {
    for (const kind of ["binary", "image"] as const) {
      const props = tabOfKind(kind, kind === "binary" ? "blob.bin" : "logo.png");
      const { unmount } = render(<EditorGroup {...props} />);
      expect(screen.queryByTitle("Save (⌘S)")).toBeNull();
      fireEvent.keyDown(screen.getByTestId("viewer-button"), { key: "s", metaKey: true });
      expect(writeText).not.toHaveBeenCalled();
      unmount();
    }
  });
});
