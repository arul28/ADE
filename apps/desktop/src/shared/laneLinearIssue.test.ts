import { describe, expect, it } from "vitest";
import { parseLaneLinearIssueValue } from "./laneLinearIssue";

describe("parseLaneLinearIssueValue", () => {
  it("rejects identifier-only stubs that would crash finalize", () => {
    expect(parseLaneLinearIssueValue({ id: "ADE-123", identifier: "ADE-123" })).toBeNull();
  });
});
