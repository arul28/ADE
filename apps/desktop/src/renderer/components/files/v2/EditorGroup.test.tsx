// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
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

const baseProps: EditorGroupProps = {
  group: {
    id: "group-1",
    activeTabId: "src/file.ts",
    recentTabIds: ["src/file.ts"],
    tabs: [
      {
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
  workspaceId: "workspace-1",
  rootPath: "/repo",
  laneId: null,
  canEdit: true,
  canRevealInFinder: true,
  theme: "dark",
  registry,
  dirtyPaths: new Set(["src/file.ts"]),
  reloadTokensByPath: {},
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
  vi.clearAllMocks();
});

describe("EditorGroup save shortcut", () => {
  it("saves when Cmd/Ctrl+S originates inside the active group", () => {
    render(<EditorGroup {...baseProps} />);

    fireEvent.keyDown(screen.getByTestId("viewer-button"), { key: "s", metaKey: true });

    expect(writeText).toHaveBeenCalledWith({ workspaceId: "workspace-1", path: "src/file.ts", text: "saved text" });
  });

  it("ignores Cmd/Ctrl+S from unrelated or text-input focus targets", () => {
    render(
      <>
        <input data-testid="outside-input" />
        <EditorGroup {...baseProps} />
      </>,
    );

    fireEvent.keyDown(screen.getByTestId("outside-input"), { key: "s", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("viewer-input"), { key: "s", metaKey: true });

    expect(writeText).not.toHaveBeenCalled();
  });
});
