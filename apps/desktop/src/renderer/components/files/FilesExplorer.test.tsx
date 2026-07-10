/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "../../../shared/types";
import { FilesExplorer, type FilesExplorerProps } from "./FilesExplorer";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getTotalSize: () => count * size,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          size,
          start: index * size,
        })),
    };
  },
}));

afterEach(cleanup);

function renderExplorer(overrides: Partial<FilesExplorerProps> = {}) {
  const props: FilesExplorerProps = {
    tree: [],
    expanded: new Set(),
    loadingDirectories: new Set(),
    selectedNodePath: null,
    activeTabPath: null,
    activeContextDir: "",
    workspaceComparisonRoot: null,
    searchQuery: "",
    inlineRenameRequest: null,
    onSearchQueryChange: vi.fn(),
    singleRowHeader: true,
    onCreateFile: vi.fn(),
    onCreateDirectory: vi.fn(),
    onToggleDirectory: vi.fn(),
    onOpenFile: vi.fn(),
    onSelectNode: vi.fn(),
    onContextMenu: vi.fn(),
    onRenamePath: vi.fn(async () => undefined),
    onInlineRenameSettled: vi.fn(),
    ...overrides,
  };
  render(<FilesExplorer {...props} />);
  return props;
}

describe("FilesExplorer mutating controls", () => {
  it("keeps create controls active", () => {
    const props = renderExplorer();

    const newFile = screen.getByLabelText("New file") as HTMLButtonElement;
    const newFolder = screen.getByLabelText("New folder") as HTMLButtonElement;
    expect(newFile.disabled).toBe(false);
    expect(newFolder.disabled).toBe(false);

    fireEvent.click(newFile);
    fireEvent.click(newFolder);
    expect(props.onCreateFile).toHaveBeenCalledWith("");
    expect(props.onCreateDirectory).toHaveBeenCalledWith("");
  });
});

describe("FilesExplorer search filtering", () => {
  it("lets users collapse and re-expand folders in filtered results", () => {
    const tree: FileTreeNode[] = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "Button.tsx",
            path: "src/Button.tsx",
            type: "file",
          },
        ],
      },
    ];
    const props = renderExplorer({
      tree,
      searchQuery: "button",
    });

    expect(screen.getByText("Button.tsx")).toBeTruthy();

    fireEvent.click(screen.getByText("src"));
    expect(props.onToggleDirectory).not.toHaveBeenCalled();
    expect(screen.queryByText("Button.tsx")).toBeNull();

    fireEvent.click(screen.getByText("src"));
    expect(props.onToggleDirectory).not.toHaveBeenCalled();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
  });

  it("keeps loaded folder matches under search-local expansion", () => {
    const tree: FileTreeNode[] = [
      {
        name: "docs",
        path: "docs",
        type: "directory",
        children: [],
      },
    ];
    const props = renderExplorer({
      tree,
      searchQuery: "docs",
    });

    fireEvent.click(screen.getByText("docs"));

    expect(props.onToggleDirectory).not.toHaveBeenCalled();
    expect(screen.getByText("docs")).toBeTruthy();
  });
});
