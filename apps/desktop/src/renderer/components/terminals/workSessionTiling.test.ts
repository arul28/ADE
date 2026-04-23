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
});
