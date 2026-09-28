import { describe, expect, it } from "vitest";
import { deriveSessionRowIndicators } from "./sessionDraftIndicators";

describe("deriveSessionRowIndicators", () => {
  it("shows nothing for a session with neither a draft nor a queue", () => {
    expect(deriveSessionRowIndicators({ hasDraft: false, queuedCount: 0 })).toEqual([]);
  });

  it("shows a draft mark alone for an unsent draft", () => {
    expect(deriveSessionRowIndicators({ hasDraft: true, queuedCount: 0 })).toEqual([
      { kind: "draft", label: "Draft", title: "Unsent draft" },
    ]);
  });

  it("shows both marks when a draft and a queue coexist, draft first", () => {
    const indicators = deriveSessionRowIndicators({ hasDraft: true, queuedCount: 2 });
    expect(indicators.map((indicator) => indicator.kind)).toEqual(["draft", "outbox"]);
    expect(indicators[1]).toEqual({
      kind: "outbox",
      label: "2 queued",
      title: "2 messages waiting to send",
    });
  });

  it("uses the singular for one queued message", () => {
    expect(deriveSessionRowIndicators({ hasDraft: false, queuedCount: 1 })).toEqual([
      { kind: "outbox", label: "Queued", title: "1 message waiting to send" },
    ]);
  });

  it("says a delivery is in flight, and a failure outranks it", () => {
    expect(deriveSessionRowIndicators({ hasDraft: false, queuedCount: 2, queuedSending: true })[0]?.title)
      .toBe("Sending 2 queued messages");
    expect(deriveSessionRowIndicators({ hasDraft: false, queuedCount: 2, queuedSending: true, queuedFailed: true })[0]?.title)
      .toBe("2 queued messages — delivery failed");
  });
});
