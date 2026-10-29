import { describe, expect, it } from "vitest";
import type { LaneLinearIssue, LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { LANE_COLOR_PALETTE } from "../../../../desktop/src/shared/laneColorPalette";
import {
  NEW_LANE_START_LABEL,
  buildNewLaneSubmission,
  cycleNewLaneColor,
  cycleNewLaneFrom,
  cycleNewLaneOn,
  cycleNewLaneStart,
  filterNewLaneBranchMatches,
  newLaneColorIndex,
  newLaneCreateAction,
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

describe("new lane choices", () => {
  it("shows branch typeahead only when a branch is needed", () => {
    expect(newLaneTypeaheadField(newLaneFormFields("new", { from: "default" }))).toBeNull();
    expect(newLaneTypeaheadField(newLaneFormFields("new", { from: "primary" }))).toBeNull();
    expect(newLaneTypeaheadField(newLaneFormFields("new", { from: "branch" }))).toBe("branch");
    expect(newLaneTypeaheadField(newLaneFormFields("existing"))).toBe("branch");
    expect(newLaneFormFields("existing").some(field => field.name === "on")).toBe(false);
  });
  it("cycles choices and wraps in both directions", () => {
    expect(cycleNewLaneStart("new", 1)).toBe("existing");
    expect(cycleNewLaneStart("existing", 1)).toBe("new");
    expect(cycleNewLaneFrom("default", 1)).toBe("primary");
    expect(cycleNewLaneFrom("primary", 1)).toBe("branch");
    expect(cycleNewLaneFrom("default", -1)).toBe("branch");
    expect(cycleNewLaneOn("remote", 1)).toBe("local");
    expect(cycleNewLaneOn("local", 1)).toBe("uncommitted");
    expect(cycleNewLaneOn("remote", -1)).toBe("uncommitted");
    expect(toggleNewLaneBranchSource("local")).toBe("remote");
    expect(normalizeNewLaneStart("unknown")).toBe("new");
    expect(NEW_LANE_START_LABEL.existing).toBe("Use existing branch");
    expect(newLaneStartForClickRow(2)).toBe("existing");
    expect(newLaneStartForClickRow(3)).toBeNull();
    expect(cycleNewLaneColor("", 1)).toBe(LANE_COLOR_PALETTE[0]?.hex);
    expect(newLaneColorIndex("not-a-color")).toBe(0);
  });
  it("filters branches by source", () => {
    const branches = [{ name: "origin/feature-x", remote: true }, { name: "feature-local", remote: false }];
    expect(filterNewLaneBranchMatches({ branches, query: "feat", remote: true })).toEqual(["origin/feature-x"]);
    expect(filterNewLaneBranchMatches({ branches, query: "feat", remote: false })).toEqual(["feature-local"]);
  });
});

describe("new lane submission", () => {
  const lanes = [lane("lane-1", "Primary")];
  const submit = (values: Record<string, string>) => buildNewLaneSubmission({ values, lanes, activeLaneId: "lane-1" });
  it("creates from the selected source and work", () => {
    expect(submit({ name: "feature", from: "primary", on: "local" })).toEqual({
      kind: "create", payload: { name: "feature", start: { from: "primary", on: "local" } },
    });
    expect(submit({ name: "feature", from: "branch", branch: "origin/topic", on: "uncommitted" })).toEqual({
      kind: "create", payload: { name: "feature", start: { from: "branch", branch: "topic", on: "uncommitted" } },
    });
    expect(submit({ name: "feature", from: "branch" })).toEqual({ kind: "error", message: "Branch is required." });
    expect(newLaneCreateAction({ values: { name: "feature", from: "branch" }, fields: [] }).enabled).toBe(false);
  });
  it("imports the selected existing branch", () => {
    expect(submit({ name: "feature", start: "existing", branch: "origin/topic", color: "#60a5fa" })).toEqual({
      kind: "importBranch", payload: { name: "feature", branchRef: "origin/topic" }, color: "#60a5fa",
    });
    expect(submit({ name: "feature", start: "existing" })).toEqual({ kind: "error", message: "Branch is required." });
  });
  it("keeps the issue and template on new branches", () => {
    const issue = linearIssue();
    expect(buildNewLaneSubmission({ values: { name: "feature", templateId: "tpl", linearIssue: "ADE-123" }, lanes, activeLaneId: "lane-1", linearIssue: issue })).toEqual({
      kind: "create", payload: { name: "feature", start: { from: "default", on: "remote" }, branchName: "ade-123-fix-setup-parity", linearIssue: issue }, templateId: "tpl",
    });
    expect(buildNewLaneSubmission({ values: { name: "feature", start: "existing", branch: "topic", linearIssue: "ADE-123" }, lanes, activeLaneId: "lane-1", linearIssue: issue })).toEqual({
      kind: "error", message: "Linear issue attachment is not supported when importing an existing branch.",
    });
  });
});
