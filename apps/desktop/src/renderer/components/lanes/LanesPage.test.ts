import { describe, expect, it } from "vitest";
import { resolveCreateLaneRequest } from "./LanesPage";

describe("resolveCreateLaneRequest", () => {
  it("creates an independent lane from the selected primary branch", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createAsChild: false,
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
      }),
    ).toEqual({
      kind: "root",
      args: {
        name: "git actions fixes",
        baseBranch: "main",
      },
    });
  });

  it("creates a stacked child lane only when child mode is selected", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createAsChild: true,
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
      }),
    ).toEqual({
      kind: "child",
      args: {
        name: "git actions fixes",
        parentLaneId: "lane-primary",
      },
    });
  });
});
