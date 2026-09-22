import { describe, expect, it } from "vitest";
import {
  buildClaudeToolApprovalOptions,
  claudeApprovalDecisionFromOptionAnswers,
  claudeToolApprovalFlags,
} from "./claudePermissionDialog";

describe("claude permission dialog options", () => {
  it("reads both SDK ask flags from either camelCase or snake_case options", () => {
    expect(claudeToolApprovalFlags({ defaultToNo: true, suppressAlwaysAllowRule: true })).toEqual({
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    });
    expect(claudeToolApprovalFlags({ default_to_no: true, suppress_always_allow_rule: true })).toEqual({
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    });
    expect(claudeToolApprovalFlags({ defaultToNo: false })).toEqual({
      defaultToNo: false,
      suppressAlwaysAllowRule: false,
    });
    expect(claudeToolApprovalFlags({})).toEqual({ defaultToNo: false, suppressAlwaysAllowRule: false });
    expect(claudeToolApprovalFlags(null)).toEqual({ defaultToNo: false, suppressAlwaysAllowRule: false });
    expect(claudeToolApprovalFlags([])).toEqual({ defaultToNo: false, suppressAlwaysAllowRule: false });
  });

  it("omits a recommended Allow and the session override on elevated-risk asks", () => {
    expect(buildClaudeToolApprovalOptions({ defaultToNo: true, suppressAlwaysAllowRule: false })).toEqual([
      { label: "Allow", value: "allow" },
      { label: "Deny", value: "deny" },
    ]);
  });

  it("drops Allow for Session when the SDK suppresses the always-allow rule", () => {
    expect(buildClaudeToolApprovalOptions({ defaultToNo: false, suppressAlwaysAllowRule: true })).toEqual([
      { label: "Allow", value: "allow" },
      { label: "Deny", value: "deny" },
    ]);
  });

  it("keeps Allow recommended plus Allow for Session on ordinary asks", () => {
    expect(buildClaudeToolApprovalOptions({ defaultToNo: false, suppressAlwaysAllowRule: false })).toEqual([
      { label: "Allow", value: "allow", recommended: true },
      { label: "Allow for Session", value: "allow_session" },
      { label: "Deny", value: "deny" },
    ]);
  });
});

describe("claude approval option answers", () => {
  // A question-card client (iOS) taps an option chip and sends `accept` plus
  // the chosen value in `answers`. The host reads `decision`, so this mapping
  // is what keeps the chip labeled "Deny" from allowing the tool.
  const questions = [{
    id: "tool_decision",
    question: "Claude wants to run: rm -rf ./build",
    options: [
      { label: "Allow", value: "allow" },
      { label: "Allow for Session", value: "allow_session" },
      { label: "Deny", value: "deny" },
    ],
  }];

  it("maps the request's own option values to a decision", () => {
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: "deny" })).toBe("decline");
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: "allow_session" })).toBe("accept_for_session");
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: "allow" })).toBe("accept");
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: ["deny"] })).toBe("decline");
  });

  it("keeps the client's decision when the answer names no offered option", () => {
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: "future_value" })).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { other_question: "deny" })).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(questions, { tool_decision: "" })).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(questions, {})).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(questions, null)).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(null, { tool_decision: "deny" })).toBeNull();
    expect(claudeApprovalDecisionFromOptionAnswers(
      [{ id: "tool_decision", question: "Allow?" }],
      { tool_decision: "deny" },
    )).toBeNull();
  });
});
