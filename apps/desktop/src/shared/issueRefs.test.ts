import { describe, expect, it } from "vitest";
import { linearIssueRef, normalizeLinearIdentifier } from "./issueRefs";

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
