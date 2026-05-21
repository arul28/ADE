import { describe, expect, it } from "vitest";
import { gridMiniMapText } from "../components/GridMiniMap";

describe("grid mini map", () => {
  it("renders focused tile markers for every supported count", () => {
    expect(gridMiniMapText(1, 0)).toBe("▣");
    expect(gridMiniMapText(2, 1)).toBe("▢▣");
    expect(gridMiniMapText(3, 2)).toBe("▢▢▣");
    expect(gridMiniMapText(4, 0)).toBe("▣▢ / ▢▢");
    expect(gridMiniMapText(5, 3)).toBe("▢▢ / ▢▣▢");
    expect(gridMiniMapText(6, 5)).toBe("▢▢▢ / ▢▢▣");
  });
});
