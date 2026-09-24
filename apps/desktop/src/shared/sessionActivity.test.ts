import { describe, expect, it } from "vitest";
import { normalizeSessionActivityReport } from "./sessionActivity";

describe("normalizeSessionActivityReport", () => {
  it("normalizes the host-stamped JSON atom", () => {
    const report = normalizeSessionActivityReport(JSON.stringify({
      value: "testing",
      source: "agent",
      updatedAt: "2026-08-01T08:00:00-04:00",
      ignored: "field",
    }));

    expect(report?.value).toBe("testing");
    expect(report?.source).toBe("agent");
    expect(report?.updatedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(report).not.toHaveProperty("ignored");
  });

  it("rejects values outside the fixed activity list and malformed reports", () => {
    for (const report of [
      { value: "coding", source: "agent", updatedAt: "2026-08-01T12:00:00Z" },
      { value: "testing", source: "model", updatedAt: "2026-08-01T12:00:00Z" },
      { value: "testing", source: "agent", updatedAt: "not-a-date" },
      "{broken",
      null,
      [],
    ]) {
      expect(normalizeSessionActivityReport(report)).toBeNull();
    }
  });
});
