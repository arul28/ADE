import { describe, expect, it } from "vitest";
import type { LaneLinearIssue } from "./types";
import {
  ensureLinearPrIssueLinkSection,
  ensureLinearPrReferences,
  renderLinearPrIssueLinkSection,
} from "./linearMagicWords";

function issue(overrides: Partial<LaneLinearIssue>): LaneLinearIssue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "ADE-123",
    title: overrides.title ?? "Link Linear issues deeply",
    description: null,
    url: overrides.url ?? `https://linear.app/ade/issue/${overrides.identifier ?? "ADE-123"}`,
    projectId: "project-1",
    projectSlug: "ade",
    teamId: "team-1",
    teamKey: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 0,
    priorityLabel: "none",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("linearMagicWords", () => {
  it("keeps multiple Linear PR references in the requested order", () => {
    const first = issue({ id: "issue-1", identifier: "ADE-123" });
    const second = issue({ id: "issue-2", identifier: "OPS-9", title: "Update ops hooks" });

    const body = ensureLinearPrReferences("body", [
      { issue: first, closeOnMerge: true },
      { issue: second, closeOnMerge: false },
    ], { preserveExisting: false });

    expect(body).toMatch(/^Fixes ADE-123\n\nRefs OPS-9\n\nbody$/);
  });

  it("renders and replaces the linked issue section idempotently", () => {
    const first = issue({ id: "issue-1", identifier: "ADE-123" });
    const second = issue({ id: "issue-2", identifier: "OPS-9", title: "Update ops hooks" });
    const section = renderLinearPrIssueLinkSection([
      { issue: first, closeOnMerge: true },
      { issue: second, closeOnMerge: false },
    ]);

    expect(section).toContain("### Linked Linear issues");
    expect(section).toContain("closes on merge");
    expect(section).toContain("referenced");

    const once = ensureLinearPrIssueLinkSection("Summary\n", [
      { issue: first, closeOnMerge: true },
    ]);
    const twice = ensureLinearPrIssueLinkSection(once, [
      { issue: second, closeOnMerge: false },
    ]);

    expect(twice.match(/<!-- ade:linear-links/g)?.length).toBe(1);
    expect(twice).not.toContain("ADE-123");
    expect(twice).toContain("OPS-9");
  });
});
