import { describe, expect, it } from "vitest";
import { resolveCreateLaneRequest } from "./LanesPage";

describe("resolveCreateLaneRequest", () => {
  it("creates an independent lane from the selected primary branch", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "primary",
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
        createImportBranch: "",
      }),
    ).toEqual({
      kind: "root",
      args: {
        name: "git actions fixes",
        baseBranch: "main",
      },
    });
  });

  it("creates a stacked child lane when child mode is selected", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "child",
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
        createImportBranch: "",
      }),
    ).toEqual({
      kind: "child",
      args: {
        name: "git actions fixes",
        parentLaneId: "lane-primary",
      },
    });
  });

  it("imports an existing branch as a lane when existing mode is selected", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "existing",
        createParentLaneId: "",
        createBaseBranch: "",
        createImportBranch: "origin/ade/git-actions-fixes-5144fe89",
      }),
    ).toEqual({
      kind: "import",
      args: {
        branchRef: "origin/ade/git-actions-fixes-5144fe89",
        name: "git actions fixes",
      },
    });
  });
});
