import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import {
  buildNewLaneSubmission,
  cycleNewLaneStart,
  newLaneFormFieldRowOffsets,
  newLaneFormFields,
  newLaneStartForClickX,
  normalizeNewLaneStart,
  toggleNewLaneRuntime,
} from "../newLaneForm";

function lane(id: string, name: string): LaneSummary {
  return { id, name } as LaneSummary;
}

describe("newLaneFormFields", () => {
  it("shows mode-specific fields for each start mode", () => {
    const primary = newLaneFormFields("primary").map((field) => field.name);
    expect(primary).toEqual(["name", "start", "baseBranch", "runtime"]);

    const child = newLaneFormFields("child", { activeLaneName: "Current" }).map((field) => field.name);
    expect(child).toEqual(["name", "start", "parent", "baseBranch", "runtime"]);

    const imported = newLaneFormFields("import").map((field) => field.name);
    expect(imported).toEqual(["name", "start", "branch", "baseBranch"]);
  });

  it("keeps the start row at the same index across modes so focus stays put", () => {
    for (const mode of ["primary", "child", "import"] as const) {
      expect(newLaneFormFields(mode).findIndex((field) => field.name === "start")).toBe(1);
    }
  });

  it("uses the active lane name as the parent placeholder", () => {
    const fields = newLaneFormFields("child", { activeLaneName: "Auth lane" });
    expect(fields.find((field) => field.name === "parent")?.placeholder).toBe("Auth lane");
  });
});

describe("start/runtime cycling", () => {
  it("cycles forward and backward through the start modes", () => {
    expect(cycleNewLaneStart("primary", 1)).toBe("child");
    expect(cycleNewLaneStart("child", 1)).toBe("import");
    expect(cycleNewLaneStart("import", 1)).toBe("primary");
    expect(cycleNewLaneStart("primary", -1)).toBe("import");
    expect(normalizeNewLaneStart("nonsense")).toBe("primary");
  });

  it("toggles runtime between local and the mac vm", () => {
    expect(toggleNewLaneRuntime("local")).toBe("macos-vm");
    expect(toggleNewLaneRuntime("macos-vm")).toBe("local");
    expect(toggleNewLaneRuntime(undefined)).toBe("macos-vm");
  });
});

describe("newLaneFormFieldRowOffsets", () => {
  it("matches the NewLaneFormPane block heights (3 rows per field, 4 for start)", () => {
    // primary: name(1), start(4), baseBranch(8), runtime(11)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("primary"))).toEqual([1, 4, 8, 11]);
    // child adds the parent row: name(1), start(4), parent(8), base(11), runtime(14)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("child"))).toEqual([1, 4, 8, 11, 14]);
    // import: name(1), start(4), branch(8), base(11)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("import"))).toEqual([1, 4, 8, 11]);
  });
});

describe("newLaneStartForClickX", () => {
  it("maps chip-row columns onto the start modes", () => {
    expect(newLaneStartForClickX(3)).toBe("primary");
    expect(newLaneStartForClickX(18)).toBe("child");
    expect(newLaneStartForClickX(35)).toBe("import");
  });
});

describe("buildNewLaneSubmission", () => {
  const lanes = [lane("lane-1", "Primary"), lane("lane-2", "Auth work")];

  it("builds a plain create payload, only sending macos-vm placement explicitly", () => {
    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", baseBranch: "develop", runtime: "local" },
      lanes,
      activeLaneId: "lane-1",
    })).toEqual({ kind: "create", payload: { name: "feature-x", baseBranch: "develop" } });

    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", runtime: "macos-vm" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "create", payload: { name: "feature-x", runtimePlacement: "macos-vm" } });
  });

  it("resolves the parent lane by name, id, or the active lane", () => {
    expect(buildNewLaneSubmission({
      values: { name: "stacked", start: "child", parent: "auth work" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "createChild", payload: { name: "stacked", parentLaneId: "lane-2" } });

    expect(buildNewLaneSubmission({
      values: { name: "stacked", start: "child", parent: "lane-1" },
      lanes,
      activeLaneId: null,
    })).toMatchObject({ kind: "createChild", payload: { parentLaneId: "lane-1" } });

    expect(buildNewLaneSubmission({
      values: { name: "stacked", start: "child" },
      lanes,
      activeLaneId: "lane-2",
    })).toMatchObject({ kind: "createChild", payload: { parentLaneId: "lane-2" } });
  });

  it("rejects an unknown parent lane with a readable message", () => {
    expect(buildNewLaneSubmission({
      values: { name: "stacked", start: "child", parent: "ghost" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "error", message: "No lane named \"ghost\"." });
  });

  it("builds an importBranch payload and requires the branch ref", () => {
    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import", branch: "origin/feature-y" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "importBranch", payload: { branchRef: "origin/feature-y", name: "adopted" } });

    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "error", message: "Branch to import is required." });
  });
});
