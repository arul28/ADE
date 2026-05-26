import { describe, expect, it } from "vitest";
import {
  finalizeLaneLinearIssue,
  isLinkableLaneLinearIssue,
  laneLinearIssueMissingFields,
  parseLaneLinearIssueJson,
  parseLaneLinearIssueValue,
} from "./laneLinearIssue";

const VALID_ISSUE_INPUT = {
  id: "issue-1",
  identifier: "ADE-45",
  title: "Run Cursor SDK audit",
  projectId: "",
  projectSlug: "",
  teamId: "team-ade",
  teamKey: "ADE",
  stateId: "backlog",
  stateName: "Backlog",
  stateType: "backlog",
  createdAt: "2026-05-23T20:28:17.439Z",
  updatedAt: "2026-05-25T20:32:37.271Z",
};

describe("laneLinearIssue", () => {
  it("parses a valid issue and reports no missing fields after finalization", () => {
    const issue = parseLaneLinearIssueValue(VALID_ISSUE_INPUT);

    expect(issue).toEqual(expect.objectContaining({
      identifier: "ADE-45",
      projectId: "",
      projectSlug: "",
      teamKey: "ADE",
    }));
    expect(laneLinearIssueMissingFields(finalizeLaneLinearIssue(issue!, "feature/ade-45"))).toEqual([]);
    expect(finalizeLaneLinearIssue(issue!, "feature/ade-45").branchName).toBe("feature/ade-45");
  });

  it("returns null for objects missing required fields", () => {
    expect(parseLaneLinearIssueValue({ id: "issue-1" })).toBeNull();
    expect(parseLaneLinearIssueValue(null)).toBeNull();
    expect(parseLaneLinearIssueValue("not-an-object")).toBeNull();
    expect(parseLaneLinearIssueValue([])).toBeNull();
  });

  it("normalizes unrecognized priority labels to 'none'", () => {
    const issue = parseLaneLinearIssueValue({
      ...VALID_ISSUE_INPUT,
      priorityLabel: "critical",
    });

    expect(issue).not.toBeNull();
    expect(issue!.priorityLabel).toBe("none");
  });

  it("parses valid JSON and rejects malformed JSON", () => {
    const valid = parseLaneLinearIssueJson(JSON.stringify(VALID_ISSUE_INPUT));
    expect(valid).not.toBeNull();
    expect(valid!.identifier).toBe("ADE-45");

    expect(parseLaneLinearIssueJson(null)).toBeNull();
    expect(parseLaneLinearIssueJson("{invalid json")).toBeNull();
    expect(parseLaneLinearIssueJson("")).toBeNull();
  });

  it("reports missing fields for issues with blank required values", () => {
    const issue = parseLaneLinearIssueValue(VALID_ISSUE_INPUT)!;
    const blanked = { ...issue, id: "  ", teamKey: "  " };
    const missing = laneLinearIssueMissingFields(blanked);

    expect(missing).toContain("id");
    expect(missing).toContain("teamKey");
    expect(missing).not.toContain("identifier");
  });

  it("identifies linkable vs non-linkable issues", () => {
    const issue = parseLaneLinearIssueValue(VALID_ISSUE_INPUT)!;
    expect(isLinkableLaneLinearIssue(issue)).toBe(true);

    const unlinked = { ...issue, teamKey: "  " };
    expect(isLinkableLaneLinearIssue(unlinked)).toBe(false);
  });
});
