/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiffFileTree,
  buildDiffFileTree,
  collectDiffTreeFolderPaths,
  diffFileTreeStatusMark,
  diffTreeAncestorFolders,
  pruneCollapsedFolders,
  type DiffFileTreeEntry,
} from "./DiffFileTree";

const FILES: DiffFileTreeEntry[] = [
  { path: "docs/readme.md", status: "removed" },
  { path: "src/a.ts", status: "added" },
  { path: "src/b.ts", status: "modified" },
  { path: "src/nested/file2.ts", status: "renamed" },
  { path: "src/nested/file10.ts", status: "copied" },
];

describe("DiffFileTree helpers", () => {
  it("orders directories before files and sorts names numerically", () => {
    const root = buildDiffFileTree(FILES);
    expect(root.children.map((item) => item.name)).toEqual(["docs", "src"]);
    const src = collectDiffTreeFolderPaths(root);
    expect(src).toContain("src");
    expect(src).toContain("src/nested");
    const nested = buildDiffFileTree(FILES).children
      .find((item) => item.name === "src");
    const names = nested?.kind === "folder" ? nested.children.map((child) => child.name) : [];
    expect(names).toEqual(["nested", "a.ts", "b.ts"]);
    const nestedFolder = buildDiffFileTree(FILES).children
      .find((item) => item.name === "src");
    const inner = nestedFolder?.kind === "folder"
      ? nestedFolder.children.find((child) => child.name === "nested")
      : null;
    expect(inner?.kind === "folder" ? inner.children.map((child) => child.name) : []).toEqual(["file2.ts", "file10.ts"]);
  });

  it("normalizes backslash separators into one tree", () => {
    const root = buildDiffFileTree([{ path: "src\\win\\x.ts", status: "modified" }]);
    expect(collectDiffTreeFolderPaths(root)).toEqual(["src", "src/win"]);
  });

  it("marks each git status, defaulting unknown paths to modified", () => {
    expect(diffFileTreeStatusMark("added")).toBe("A");
    expect(diffFileTreeStatusMark("removed")).toBe("D");
    expect(diffFileTreeStatusMark("renamed")).toBe("R");
    expect(diffFileTreeStatusMark("copied")).toBe("C");
    expect(diffFileTreeStatusMark("modified")).toBe("M");
    expect(diffFileTreeStatusMark("something-new")).toBe("M");
    expect(diffFileTreeStatusMark(null)).toBe("M");
  });

  it("prunes collapsed folders that vanished and keeps the rest by reference", () => {
    const collapsed = new Set(["src", "src/gone"]);
    const pruned = pruneCollapsedFolders(collapsed, new Set(["src", "src/nested"]));
    expect([...pruned]).toEqual(["src"]);
    const untouched = new Set(["src"]);
    expect(pruneCollapsedFolders(untouched, new Set(["src"]))).toBe(untouched);
  });

  it("lists ancestor folders from nearest to root", () => {
    expect(diffTreeAncestorFolders("src/nested/deep/file.ts")).toEqual(["src/nested/deep", "src/nested", "src"]);
    expect(diffTreeAncestorFolders("root.ts")).toEqual([]);
  });
});

describe("DiffFileTree", () => {
  afterEach(cleanup);

  it("opens every folder by default and reports selected files", () => {
    const onSelectFile = vi.fn();
    render(<DiffFileTree files={FILES} onSelectFile={onSelectFile} />);
    expect(screen.getAllByTestId("diff-file-tree-file")).toHaveLength(5);
    fireEvent.click(screen.getByRole("treeitem", { name: /a\.ts/ }));
    expect(onSelectFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("collapses and expands folders with the arrow keys", () => {
    render(<DiffFileTree files={FILES} />);
    const src = screen.getByRole("treeitem", { name: "src" });
    fireEvent.focus(src);
    expect(src.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /a\.ts/ })).toBeNull();

    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toBeTruthy();
  });

  it("keeps folder collapse state when the file list changes", () => {
    const { rerender } = render(<DiffFileTree files={FILES} />);
    const src = screen.getByRole("treeitem", { name: "src" });
    fireEvent.focus(src);
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src.getAttribute("aria-expanded")).toBe("false");

    rerender(<DiffFileTree files={[...FILES, { path: "src/added-later.ts", status: "added" }]} />);
    const stillCollapsed = screen.getByRole("treeitem", { name: "src" });
    expect(stillCollapsed.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /added-later/ })).toBeNull();
  });
});
