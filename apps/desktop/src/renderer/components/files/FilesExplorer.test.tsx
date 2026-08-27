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

describe("FilesExplorer header", () => {
  it("renders the search field in the compact tools-pane layout", () => {
    const props = renderExplorer({ compact: true });

    const field = screen.getByLabelText("Search files") as HTMLInputElement;
    expect(field.dataset.filesSearchField).toBe("1");
    expect(screen.getByLabelText("New file")).toBeTruthy();
    expect(screen.getByLabelText("New folder")).toBeTruthy();

    fireEvent.change(field, { target: { value: "but" } });
    expect(props.onSearchQueryChange).toHaveBeenCalledWith("but");
  });

  it("clears the query from the field's clear button", () => {
    const props = renderExplorer({ searchQuery: "button" });

    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(props.onSearchQueryChange).toHaveBeenCalledWith("");
  });

  it("anchors the clear-search control on the tooltip wrapper", () => {
    renderExplorer({ searchQuery: "button" });

    const button = screen.getByLabelText("Clear search");
    const wrapper = button.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error("clear-search tooltip wrapper is missing");
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.right).toBe("4px");
    expect(button.style.position).not.toBe("absolute");
  });
});

describe("FilesExplorer search results", () => {
  const tree: FileTreeNode[] = [
    { name: "src", path: "src", type: "directory", children: [{ name: "Button.tsx", path: "src/Button.tsx", type: "file" }] },
  ];

  it("swaps the tree for the results in the same column while a query is active", () => {
    renderExplorer({
      tree,
      searchQuery: "button",
      searchResults: <div data-testid="results">results</div>,
    });

    expect(screen.getByTestId("results")).toBeTruthy();
    // The tree is replaced, not overlaid, and the search field stays put.
    expect(screen.queryByText("Button.tsx")).toBeNull();
    expect(screen.getByLabelText("Search files")).toBeTruthy();
  });

  it("shows the tree again once the query is cleared", () => {
    renderExplorer({
      tree,
      expanded: new Set(["src"]),
      searchQuery: "",
      searchResults: <div data-testid="results">results</div>,
    });

    expect(screen.queryByTestId("results")).toBeNull();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
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
