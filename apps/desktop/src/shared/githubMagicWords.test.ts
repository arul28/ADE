import { describe, expect, it } from "vitest";
import {
  buildGitHubPrReference,
  ensureGitHubPrIssueLinkSection,
  ensureGitHubPrReference,
  parseGitHubIssueRef,
} from "./githubMagicWords";
import type { LaneGitHubIssue } from "./types";

const SAMPLE_ISSUE: LaneGitHubIssue = {
  id: "ade/app#42",
  number: 42,
  owner: "ade",
  repo: "app",
  title: "Fix attach menu",
  body: "Details",
  url: "https://github.com/ade/app/issues/42",
  state: "open",
  stateReason: null,
  labels: ["bug"],
  assignees: [],
  authorLogin: "arul",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("githubMagicWords", () => {
  it("builds a Closes reference for close-on-merge", () => {
    expect(buildGitHubPrReference(SAMPLE_ISSUE, true)).toBe("Closes ade/app#42");
    expect(buildGitHubPrReference(SAMPLE_ISSUE, false)).toBe("Refs ade/app#42");
  });

  it("inserts a Closes line without duplicating an existing one", () => {
    const first = ensureGitHubPrReference("Please review", SAMPLE_ISSUE, true);
    expect(first.startsWith("Closes ade/app#42")).toBe(true);
    const second = ensureGitHubPrReference(first, SAMPLE_ISSUE, true);
    expect(second.match(/Closes ade\/app#42/g)).toHaveLength(1);
  });

  it("writes a linked GitHub issues section", () => {
    const body = ensureGitHubPrIssueLinkSection("Summary", [{ issue: SAMPLE_ISSUE, closeOnMerge: true }]);
    expect(body).toContain("<!-- ade:github-links v=1 -->");
    expect(body).toContain("ade/app#42");
    expect(body).toContain("closes on merge");
  });

  it("parses TUI issue refs", () => {
    expect(parseGitHubIssueRef("ade/app#42")).toEqual({ owner: "ade", repo: "app", number: 42 });
    expect(parseGitHubIssueRef("#42")).toEqual({ number: 42 });
    expect(parseGitHubIssueRef("ADE-123")).toBeNull();
  });
});
