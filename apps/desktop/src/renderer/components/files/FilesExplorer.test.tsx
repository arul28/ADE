/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesExplorer, type FilesExplorerProps } from "./FilesExplorer";

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
  it("disables create controls for read-only workspaces", () => {
    const props = renderExplorer({ canMutate: false });

    const newFile = screen.getByLabelText("New file") as HTMLButtonElement;
    const newFolder = screen.getByLabelText("New folder") as HTMLButtonElement;
    expect(newFile.disabled).toBe(true);
    expect(newFolder.disabled).toBe(true);

    fireEvent.click(newFile);
    fireEvent.click(newFolder);
    expect(props.onCreateFile).not.toHaveBeenCalled();
    expect(props.onCreateDirectory).not.toHaveBeenCalled();
  });

  it("keeps create controls active for mutable workspaces", () => {
    const props = renderExplorer({ canMutate: true });

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
