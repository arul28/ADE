import { describe, expect, it } from "vitest";
import { linearIssueLinkTarget, linearIssueRef, normalizeLinearIdentifier } from "./issueRefs";

// The identifier shape every issue link, deeplink and chip goes through before
// the viewer opens. Linear team keys are a letter plus up to nine letters or
// digits; a key Linear accepts must open, anything else must not.
describe("Linear identifiers", () => {
  it.each([
    ["A-123", "A-123"],
    ["ade-7", "ADE-7"],
    [" ENG42-1 ", "ENG42-1"],
    ["ABCDEFGHIJ-9", "ABCDEFGHIJ-9"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeLinearIdentifier(input)).toBe(expected);
    expect(linearIssueRef(input)).toMatchObject({ provider: "linear", identifier: expected });
  });

  it.each(["ABCDEFGHIJK-9", "1A-2", "ADE-", "ADE", "SHA-256x", "feat/ADE-1"])("rejects %s", (input) => {
    expect(normalizeLinearIdentifier(input)).toBeNull();
    expect(linearIssueRef(input)).toBeNull();
  });
});

// Links in PR text come from anyone who can comment. A link must never throw
// while the PR renders, and a linear.app link carries its workspace: an
// identifier is only unique inside one, so another workspace's ENG-12 must not
// pass for ours (the viewer would open, and let you edit, the wrong issue).
describe("Linear issue link targets", () => {
  it.each([
    ["https://linear.app/ade-linear/issue/ADE-178/background-jobs", { identifier: "ADE-178", workspace: "ade-linear", adeLink: false, branch: null }],
    ["https://linear.app/OtherCorp/issue/ENG-12", { identifier: "ENG-12", workspace: "othercorp", adeLink: false, branch: null }],
    ["https://linear.app/%E0%A4%A/issue/ADE-1", { identifier: "ADE-1", workspace: "%e0%a4%a", adeLink: false, branch: null }],
    ["https://ade-app.dev/open?type=linear-issue&issue=ADE-5&branch=feat%2Fx", { identifier: "ADE-5", workspace: null, adeLink: true, branch: "feat/x" }],
  ])("reads %s", (href, expected) => {
    const target = linearIssueLinkTarget(href);
    expect(target, "a Linear link resolves").not.toBeNull();
    expect(target!.ref).toMatchObject({ provider: "linear", identifier: expected.identifier });
    expect({ workspace: target!.workspace, adeLink: target!.adeLink, branch: target!.branch }).toEqual({
      workspace: expected.workspace,
      adeLink: expected.adeLink,
      branch: expected.branch,
    });
  });

  it.each(["https://github.com/acme/ade/issues/1", "https://example.com/issue/ADE-1", "not a url", ""])("ignores %s", (href) => {
    expect(linearIssueLinkTarget(href)).toBeNull();
  });
});
