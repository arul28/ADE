import { describe, expect, it } from "vitest";
import { splitByDisplayCells } from "../displayWidth";

describe("splitByDisplayCells", () => {
  it("assigns a wide cluster that crosses a split boundary to one segment", () => {
    expect(splitByDisplayCells("ab界cd", 2, 3)).toEqual({
      before: "ab",
      selected: "界",
      after: "cd",
    });
  });
});
