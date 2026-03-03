import { describe, expect, it } from "vitest";
import { parseChatTarget, sanitizeChatTarget, teammateThreadIdentity, deriveThreadTitle } from "./orchestratorContext";

describe("orchestratorContext teammate chat target handling", () => {
  it("parses teammate targets from persisted JSON payloads", () => {
    const parsed = parseChatTarget({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });

    expect(parsed).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("sanitizes teammate targets without dropping routing fields", () => {
    const sanitized = sanitizeChatTarget({
      kind: "teammate",
      runId: " run-1 ",
      teamMemberId: " tm-1 ",
      sessionId: " session-1 ",
    });

    expect(sanitized).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("builds teammate thread identity and title", () => {
    const target = {
      kind: "teammate" as const,
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    };

    expect(teammateThreadIdentity(target)).toBe("tm-1");
    expect(deriveThreadTitle({ target, step: null, lane: null })).toBe("Teammate: tm-1");
  });
});
