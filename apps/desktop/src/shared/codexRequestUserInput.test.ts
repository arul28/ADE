import { describe, expect, it } from "vitest";
import { parseCodexIsBlocking, readCodexIsBlocking } from "./codexRequestUserInput";
import { isSteeringPendingRequest } from "./pendingInputAnswers";

describe("parseCodexIsBlocking", () => {
  it("treats missing and true as blocking", () => {
    expect(parseCodexIsBlocking(undefined)).toBe(true);
    expect(parseCodexIsBlocking(null)).toBe(true);
    expect(parseCodexIsBlocking(true)).toBe(true);
    expect(parseCodexIsBlocking("false")).toBe(true);
  });

  it("treats only JSON false as non-blocking", () => {
    expect(parseCodexIsBlocking(false)).toBe(false);
  });
});

describe("readCodexIsBlocking", () => {
  it("defaults missing fields to blocking", () => {
    expect(readCodexIsBlocking(undefined)).toBe(true);
    expect(readCodexIsBlocking({})).toBe(true);
  });

  it("reads camelCase and snake_case", () => {
    expect(readCodexIsBlocking({ isBlocking: false })).toBe(false);
    expect(readCodexIsBlocking({ is_blocking: false })).toBe(false);
    expect(readCodexIsBlocking({ isBlocking: true })).toBe(true);
  });
});

describe("isSteeringPendingRequest", () => {
  it("requires an ask-question kind and blocking === false", () => {
    expect(isSteeringPendingRequest({ kind: "structured_question", blocking: false })).toBe(true);
    expect(isSteeringPendingRequest({ kind: "question", blocking: false })).toBe(true);
    expect(isSteeringPendingRequest({ kind: "structured_question", blocking: true })).toBe(false);
    expect(isSteeringPendingRequest({ kind: "structured_question" })).toBe(false);
    expect(isSteeringPendingRequest({ kind: "plan_approval", blocking: false })).toBe(false);
  });
});
