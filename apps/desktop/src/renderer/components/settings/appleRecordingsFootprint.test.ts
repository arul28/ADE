import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "../../../shared/types/files";
import { sumFileTreeBytes } from "./appleRecordingsFootprint";

function file(path: string, size: number): FileTreeNode {
  return { name: path.split("/").pop() ?? path, path, type: "file", size };
}

function dir(path: string, children: FileTreeNode[]): FileTreeNode {
  return { name: path.split("/").pop() ?? path, path, type: "directory", children };
}

describe("sumFileTreeBytes", () => {
  it("sums nested recording files and ignores directories without a size", () => {
    const tree: FileTreeNode[] = [
      dir("lane-a", [
        file("lane-a/one.mp4", 100),
        file("lane-a/one.json", 20),
      ]),
      dir("lane-b", [
        file("lane-b/two.mp4", 50),
      ]),
    ];
    expect(sumFileTreeBytes(tree)).toBe(170);
  });

  it("treats missing or non-finite sizes as zero", () => {
    expect(sumFileTreeBytes([
      file("a.mp4", Number.NaN),
      { name: "b.mp4", path: "b.mp4", type: "file" },
      file("c.mp4", 8),
    ])).toBe(8);
  });
});
