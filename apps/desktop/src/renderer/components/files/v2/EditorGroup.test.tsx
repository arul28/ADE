// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import { editorTabId } from "./editorGroupsStore";
import { EditorGroup, type EditorGroupProps } from "./EditorGroup";

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

const registry = {
  getValue: vi.fn(() => "saved text"),
  markSaved,
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
  writeText.mockResolvedValue(undefined);
  markSaved.mockClear();
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
});
