import { describe, expect, it } from "vitest";
import type { LaneLinearIssue, LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { LANE_COLOR_PALETTE } from "../../../../desktop/src/shared/laneColorPalette";
import {
  NEW_LANE_COLOR_OPTIONS,
  NEW_LANE_START_LABEL,
  NEW_LANE_TYPEAHEAD_ROWS,
  buildNewLaneSubmission,
  cycleNewLaneColor,
  cycleNewLaneStart,
  filterNewLaneBranchMatches,
  newLaneColorIndex,
  newLaneCreateAction,
  newLaneFormFieldRowOffsets,
  newLaneFormFields,
  newLaneStartForClickRow,
  newLaneTypeaheadField,
  normalizeNewLaneStart,
  toggleNewLaneBranchSource,
} from "../newLaneForm";

function lane(id: string, name: string): LaneSummary {
  return { id, name } as LaneSummary;
}

function linearIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Fix setup parity",
    description: null,
    url: "https://linear.app/ade/issue/ADE-123/fix-setup-parity",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 0,
    priorityLabel: "none",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    branchName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("newLaneFormFields", () => {
  it("shows mode-specific fields for each start mode, always ending in the create button", () => {
    const primary = newLaneFormFields("primary").map((field) => field.name);
    expect(primary).toEqual(["name", "color", "start", "baseBranch", "linearIssue", "templateId", "create"]);

    const child = newLaneFormFields("child", { activeLaneName: "Current" }).map((field) => field.name);
    expect(child).toEqual(["name", "color", "start", "parent", "baseBranch", "linearIssue", "templateId", "create"]);

    const imported = newLaneFormFields("import").map((field) => field.name);
    expect(imported).toEqual(["name", "color", "start", "branchSource", "branch", "baseBranch", "linearIssue", "templateId", "create"]);
  });

  it("keeps the start row at the same index across modes so focus stays put", () => {
    for (const mode of ["primary", "child", "import"] as const) {
      expect(newLaneFormFields(mode).findIndex((field) => field.name === "start")).toBe(2);
    }
  });

  it("uses the active lane name as the parent placeholder", () => {
    const fields = newLaneFormFields("child", { activeLaneName: "Auth lane" });
    expect(fields.find((field) => field.name === "parent")?.placeholder).toBe("Auth lane");
  });

  it("labels the import mode as 'branch' in UI copy while keeping the internal value", () => {
    expect(NEW_LANE_START_LABEL.import).toBe("branch");
    expect(normalizeNewLaneStart("import")).toBe("import");
  });
});

describe("start/source/color cycling", () => {
  it("cycles through the start modes in display order (primary → branch → child)", () => {
    expect(cycleNewLaneStart("primary", 1)).toBe("import");
    expect(cycleNewLaneStart("import", 1)).toBe("child");
    expect(cycleNewLaneStart("child", 1)).toBe("primary");
    expect(cycleNewLaneStart("primary", -1)).toBe("child");
    expect(normalizeNewLaneStart("nonsense")).toBe("primary");
  });

  it("toggles the branch source between remote and local (remote default)", () => {
    expect(toggleNewLaneBranchSource(undefined)).toBe("local");
    expect(toggleNewLaneBranchSource("local")).toBe("remote");
    expect(toggleNewLaneBranchSource("remote")).toBe("local");
  });
});

describe("color picker", () => {
  it("offers auto plus the desktop lane palette", () => {
    expect(NEW_LANE_COLOR_OPTIONS[0]).toEqual({ hex: null, name: "auto" });
    expect(NEW_LANE_COLOR_OPTIONS).toHaveLength(LANE_COLOR_PALETTE.length + 1);
    expect(NEW_LANE_COLOR_OPTIONS[1]?.hex).toBe(LANE_COLOR_PALETTE[0]?.hex);
  });

  it("cycles from auto through the palette and wraps", () => {
    expect(cycleNewLaneColor("", 1)).toBe(LANE_COLOR_PALETTE[0]?.hex);
    expect(cycleNewLaneColor(LANE_COLOR_PALETTE[0]?.hex, -1)).toBe("");
    expect(cycleNewLaneColor("", -1)).toBe(LANE_COLOR_PALETTE[LANE_COLOR_PALETTE.length - 1]?.hex);
    expect(newLaneColorIndex("not-a-color")).toBe(0);
    expect(newLaneColorIndex(LANE_COLOR_PALETTE[2]?.hex?.toUpperCase())).toBe(3);
  });
});

describe("branch typeahead", () => {
  const branches = [
    { name: "origin/feature-x", remote: true },
    { name: "origin/main", remote: true },
    { name: "feature-local", remote: false },
    { name: "main", remote: false },
  ];

  it("targets the branch field in import mode, the base branch in primary mode, nothing for child", () => {
    expect(newLaneTypeaheadField(newLaneFormFields("import"))).toBe("branch");
    expect(newLaneTypeaheadField(newLaneFormFields("primary"))).toBe("baseBranch");
    expect(newLaneTypeaheadField(newLaneFormFields("child"))).toBeNull();
  });

  it("filters by remote/local and ranks prefix matches first (ignoring the remote prefix)", () => {
    expect(filterNewLaneBranchMatches({ branches, query: "feat", remote: true })).toEqual(["origin/feature-x"]);
    expect(filterNewLaneBranchMatches({ branches, query: "feat", remote: false })).toEqual(["feature-local"]);
    expect(filterNewLaneBranchMatches({ branches, query: "ain", remote: true })).toEqual(["origin/main"]);
    expect(filterNewLaneBranchMatches({ branches, query: "", remote: true })).toEqual([
      "origin/feature-x",
      "origin/main",
    ]);
    expect(filterNewLaneBranchMatches({ branches: undefined, query: "x", remote: true })).toEqual([]);
    expect(filterNewLaneBranchMatches({ branches, query: "", remote: true, limit: 1 })).toEqual(["origin/feature-x"]);
  });
});

describe("newLaneFormFieldRowOffsets", () => {
  it("matches the NewLaneFormPane block heights (start = 5 rows, typeahead +4, create = 2)", () => {
    // primary: name(1), color(4), start(7), baseBranch(12, +typeahead), issue(19), template(22), create(25)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("primary"))).toEqual([1, 4, 7, 12, 19, 22, 25]);
    // child has no typeahead: name(1), color(4), start(7), parent(12), base(15), issue(18), template(21), create(24)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("child"))).toEqual([1, 4, 7, 12, 15, 18, 21, 24]);
    // import: name(1), color(4), start(7), source(12), branch(15, +typeahead), base(22), issue(25), template(28), create(31)
    expect(newLaneFormFieldRowOffsets(newLaneFormFields("import"))).toEqual([1, 4, 7, 12, 15, 22, 25, 28, 31]);
    expect(NEW_LANE_TYPEAHEAD_ROWS).toBe(4);
  });
});

describe("newLaneStartForClickRow", () => {
  it("maps option rows (1-3) onto the start modes in display order", () => {
    expect(newLaneStartForClickRow(0)).toBeNull();
    expect(newLaneStartForClickRow(1)).toBe("primary");
    expect(newLaneStartForClickRow(2)).toBe("import");
    expect(newLaneStartForClickRow(3)).toBe("child");
    expect(newLaneStartForClickRow(4)).toBeNull();
  });
});

describe("newLaneCreateAction", () => {
  it("requires a name, then a branch in import mode", () => {
    expect(newLaneCreateAction({ values: { start: "primary" }, fields: [] }))
      .toEqual({ label: "create lane", enabled: false, reason: "name required" });
    expect(newLaneCreateAction({ values: { name: "x", start: "import" }, fields: [] }))
      .toEqual({ label: "import branch", enabled: false, reason: "branch required" });
  });

  it("mirrors desktop copy with the resolved base", () => {
    expect(newLaneCreateAction({ values: { name: "x", start: "primary", baseBranch: "origin/main" }, fields: [] }))
      .toEqual({ label: "create from origin/main", enabled: true, reason: null });
    expect(newLaneCreateAction({ values: { name: "x", start: "primary" }, fields: [] }))
      .toEqual({ label: "create lane", enabled: true, reason: null });
    expect(newLaneCreateAction({ values: { name: "x", start: "import", branch: "origin/feature-x" }, fields: [] }))
      .toEqual({ label: "import origin/feature-x", enabled: true, reason: null });
    expect(newLaneCreateAction({ values: { name: "x", start: "child", parent: "Auth work" }, fields: [] }))
      .toEqual({ label: "create from lane Auth work", enabled: true, reason: null });
    // Child mode falls back to the parent field placeholder (the active lane).
    expect(newLaneCreateAction({
      values: { name: "x", start: "child" },
      fields: [{ name: "parent", placeholder: "Current" }],
    })).toEqual({ label: "create from lane Current", enabled: true, reason: null });
  });
});

describe("buildNewLaneSubmission", () => {
  const lanes = [lane("lane-1", "Primary"), lane("lane-2", "Auth work")];

  it("builds a plain create payload without runtime placement", () => {
    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", baseBranch: "develop" },
      lanes,
      activeLaneId: "lane-1",
    })).toEqual({ kind: "create", payload: { name: "feature-x", baseBranch: "develop" } });
  });

  it("carries the chosen color alongside the payload (auto/empty omitted)", () => {
    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", color: "#a78bfa" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "create", payload: { name: "feature-x" }, color: "#a78bfa" });

    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", color: "" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "create", payload: { name: "feature-x" } });

    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import", branch: "origin/feature-y", color: "#60a5fa" },
      lanes,
      activeLaneId: null,
    })).toEqual({
      kind: "importBranch",
      payload: { branchRef: "origin/feature-y", name: "adopted" },
      color: "#60a5fa",
    });
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

  it("passes the branch ref through as typed/picked and requires it", () => {
    // Remote refs stay in "origin/x" form (listBranches returns them that way
    // and lane.importBranch resolves both remote refs and bare local names).
    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import", branch: "origin/feature-y" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "importBranch", payload: { branchRef: "origin/feature-y", name: "adopted" } });

    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import" },
      lanes,
      activeLaneId: null,
    })).toEqual({ kind: "error", message: "Branch is required." });
  });

  it("attaches Linear issue metadata and selected setup template to create payloads", () => {
    const issue = linearIssue();

    expect(buildNewLaneSubmission({
      values: { name: "feature-x", start: "primary", linearIssue: "ADE-123", templateId: "tpl-default" },
      lanes,
      activeLaneId: "lane-1",
      linearIssue: issue,
    })).toEqual({
      kind: "create",
      payload: {
        name: "feature-x",
        branchName: "ade-123-fix-setup-parity",
        linearIssue: issue,
      },
      templateId: "tpl-default",
    });

    expect(buildNewLaneSubmission({
      values: { name: "stacked", start: "child", linearIssue: "ADE-123" },
      lanes,
      activeLaneId: "lane-2",
      linearIssue: issue,
    })).toMatchObject({
      kind: "createChild",
      payload: {
        name: "stacked",
        parentLaneId: "lane-2",
        branchName: "ade-123-fix-setup-parity",
        linearIssue: issue,
      },
    });
  });

  it("rejects Linear issue attachment for imported branches", () => {
    expect(buildNewLaneSubmission({
      values: { name: "adopted", start: "import", branch: "origin/feature-y", linearIssue: "ADE-123" },
      lanes,
      activeLaneId: null,
      linearIssue: linearIssue(),
    })).toEqual({
      kind: "error",
      message: "Linear issue attachment is not supported when importing an existing branch.",
    });
  });
});
