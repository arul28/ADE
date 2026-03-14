import { describe, expect, it } from "vitest";
import { LANES_TILING_LAYOUT_VERSION, LANES_TILING_TREE } from "./laneUtils";

describe("laneUtils tiling defaults", () => {
  it("makes git actions the largest default pane", () => {
    expect(LANES_TILING_TREE.children[0]?.defaultSize).toBe(15);
    expect(LANES_TILING_TREE.children[1]?.defaultSize).toBe(30);
    expect(LANES_TILING_TREE.children[2]?.defaultSize).toBe(55);
  });

  it("raises the git actions minimum share", () => {
    expect(LANES_TILING_TREE.children[2]?.minSize).toBe(28);
  });

  it("bumps the persisted tiling layout version", () => {
    expect(LANES_TILING_LAYOUT_VERSION).toBe("v5");
  });
});
