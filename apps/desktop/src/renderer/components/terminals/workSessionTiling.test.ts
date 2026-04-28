import { describe, expect, it } from "vitest";
import { collectLeafIds } from "../ui/paneTreeOps";
import { buildWorkSessionTilingTree } from "./workSessionTiling";

describe("buildWorkSessionTilingTree", () => {
  it("builds a single-pane tree for one session", () => {
    const tree = buildWorkSessionTilingTree(["one"]);
    expect(tree.direction).toBe("vertical");
    expect(collectLeafIds(tree)).toEqual(["one"]);
  });

  it("builds a single horizontal row for two sessions", () => {
    const tree = buildWorkSessionTilingTree(["one", "two"]);
    expect(tree.direction).toBe("horizontal");
    expect(collectLeafIds(tree)).toEqual(["one", "two"]);
  });

  it("builds balanced rows for five sessions", () => {
    const tree = buildWorkSessionTilingTree(["one", "two", "three", "four", "five"]);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0]?.node).toMatchObject({ type: "split", direction: "horizontal" });
    expect(tree.children[1]?.node).toMatchObject({ type: "split", direction: "horizontal" });
    expect((tree.children[0]?.node as { children: unknown[] }).children).toHaveLength(3);
    expect((tree.children[1]?.node as { children: unknown[] }).children).toHaveLength(2);
    expect(collectLeafIds(tree)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("builds an empty vertical tree when no sessions are provided", () => {
    const tree = buildWorkSessionTilingTree([]);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(0);
    expect(collectLeafIds(tree)).toEqual([]);
  });

  it("builds a two-row grid for three sessions", () => {
    const tree = buildWorkSessionTilingTree(["one", "two", "three"]);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(2);
    expect(collectLeafIds(tree)).toEqual(["one", "two", "three"]);
  });

  it("builds a 2x2 layout for four sessions", () => {
    const tree = buildWorkSessionTilingTree(["one", "two", "three", "four"]);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(2);
    for (const row of tree.children) {
      expect(row.node).toMatchObject({ type: "split", direction: "horizontal" });
      expect((row.node as { children: unknown[] }).children).toHaveLength(2);
    }
    expect(collectLeafIds(tree)).toEqual(["one", "two", "three", "four"]);
  });

  it("builds balanced rows for six sessions", () => {
    const tree = buildWorkSessionTilingTree(["a", "b", "c", "d", "e", "f"]);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(2);
    for (const row of tree.children) {
      expect(row.node).toMatchObject({ type: "split", direction: "horizontal" });
      expect((row.node as { children: unknown[] }).children).toHaveLength(3);
    }
    expect(collectLeafIds(tree)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("builds a 3x3 grid for nine sessions", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const tree = buildWorkSessionTilingTree(ids);
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(3);
    for (const row of tree.children) {
      expect(row.node).toMatchObject({ type: "split", direction: "horizontal" });
      expect((row.node as { children: unknown[] }).children).toHaveLength(3);
    }
    expect(collectLeafIds(tree)).toEqual(ids);
  });

  it("builds a single column of stacked rows for the rows preset", () => {
    const ids = ["one", "two", "three", "four"];
    const tree = buildWorkSessionTilingTree(ids, "rows");
    expect(tree.direction).toBe("vertical");
    expect(tree.children).toHaveLength(4);
    for (const child of tree.children) {
      expect(child.node).toMatchObject({ type: "pane" });
      expect(child.defaultSize).toBe(25);
    }
    expect(collectLeafIds(tree)).toEqual(ids);
  });

  it("builds a single horizontal strip for the columns preset", () => {
    const ids = ["one", "two", "three", "four"];
    const tree = buildWorkSessionTilingTree(ids, "columns");
    expect(tree.direction).toBe("horizontal");
    expect(tree.children).toHaveLength(4);
    for (const child of tree.children) {
      expect(child.node).toMatchObject({ type: "pane" });
      expect(child.defaultSize).toBe(25);
    }
    expect(collectLeafIds(tree)).toEqual(ids);
  });

  it("returns a single full-size leaf for the rows preset with one session", () => {
    const tree = buildWorkSessionTilingTree(["solo"], "rows");
    expect(collectLeafIds(tree)).toEqual(["solo"]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.defaultSize).toBe(100);
  });

  it("returns a single full-size leaf for the columns preset with one session", () => {
    const tree = buildWorkSessionTilingTree(["solo"], "columns");
    expect(collectLeafIds(tree)).toEqual(["solo"]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.defaultSize).toBe(100);
  });
});
