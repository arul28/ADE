import { describe, it, expect } from "vitest";
import { terminalReasonLabel, formatTimedOutAfter, formatGrepTotalsPrefix } from "./chatEventDisplay";

describe("terminalReasonLabel", () => {
  it("maps known SDK terminal reasons to terse labels", () => {
    expect(terminalReasonLabel("budget_exhausted")).toBe("budget limit reached");
    expect(terminalReasonLabel("max_turns")).toBe("max turns reached");
    expect(terminalReasonLabel("prompt_too_long")).toBe("context window overflow");
    expect(terminalReasonLabel("api_error")).toBe("API error after retries");
    expect(terminalReasonLabel("malformed_tool_use_exhausted")).toBe("tool-call retries exhausted");
    expect(terminalReasonLabel("structured_output_retry_exhausted")).toBe("output retries exhausted");
    expect(terminalReasonLabel("model_error")).toBe("model error");
    expect(terminalReasonLabel("turn_setup_failed")).toBe("turn setup failed");
    expect(terminalReasonLabel("tool_deferred_unavailable")).toBe("deferred tool unavailable");
  });

  it("shows nothing for unknown, completed, or missing reasons (open set)", () => {
    expect(terminalReasonLabel("completed")).toBeNull();
    expect(terminalReasonLabel("some_future_reason")).toBeNull();
    expect(terminalReasonLabel(undefined)).toBeNull();
    expect(terminalReasonLabel("")).toBeNull();
  });
});

describe("formatTimedOutAfter", () => {
  it("formats sub-minute and minute+second durations", () => {
    expect(formatTimedOutAfter(8_000)).toBe("8s");
    expect(formatTimedOutAfter(0)).toBe("0s");
    expect(formatTimedOutAfter(60_000)).toBe("1m");
    expect(formatTimedOutAfter(125_000)).toBe("2m 5s");
    expect(formatTimedOutAfter(-500)).toBe("0s");
  });
});

describe("formatGrepTotalsPrefix", () => {
  it("builds a pluralized 'N matches in M files · ' prefix", () => {
    expect(formatGrepTotalsPrefix({ lines: 12, files: 3 })).toBe("12 matches in 3 files · ");
    expect(formatGrepTotalsPrefix({ lines: 1, files: 1 })).toBe("1 match in 1 file · ");
    expect(formatGrepTotalsPrefix({ lines: 0, files: 0 })).toBe("0 matches in 0 files · ");
  });

  it("returns an empty prefix when totals are absent", () => {
    expect(formatGrepTotalsPrefix(undefined)).toBe("");
    expect(formatGrepTotalsPrefix({})).toBe("0 matches in 0 files · ");
  });
});
