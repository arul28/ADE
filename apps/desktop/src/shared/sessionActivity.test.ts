import { describe, expect, it } from "vitest";
import {
  nextDetectedActivityReport,
  nextAgentActivityReport,
  normalizeSessionActivityReport,
  isReportFromTurn,
} from "./sessionActivity";

describe("normalizeSessionActivityReport", () => {
  it("normalizes the host-stamped JSON atom", () => {
    const report = normalizeSessionActivityReport(JSON.stringify({
      value: "testing",
      source: "agent",
      updatedAt: "2026-08-01T08:00:00-04:00",
      reportedAt: "2026-08-01T08:30:00-04:00",
      ignored: "field",
    }));

    expect(report?.value).toBe("testing");
    expect(report?.source).toBe("agent");
    expect(report?.updatedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(report?.reportedAt).toBe("2026-08-01T12:30:00.000Z");
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

describe("detected activity precedence", () => {
  const nowIso = "2026-09-24T13:00:00.000Z";
  const agent = (value: "testing" | "debugging", updatedAt: string) => ({
    value,
    source: "agent" as const,
    updatedAt,
  });

  it.each([
    ["keeps a covering report from this turn", agent("debugging", "2026-09-24T12:59:00.000Z"), "testing", "2026-09-24T12:58:00.000Z", undefined],
    ["replaces an uncovered report from this turn", agent("debugging", "2026-09-24T12:59:00.000Z"), "reviewing", "2026-09-24T12:58:00.000Z", { value: "reviewing", source: "detected", updatedAt: nowIso }],
    ["replaces an agent report from an earlier turn", agent("testing", "2026-09-24T12:00:00.000Z"), "testing", "2026-09-24T12:58:00.000Z", { value: "testing", source: "detected", updatedAt: nowIso }],
    ["keeps entry time for an unchanged detected value", { value: "testing", source: "detected", updatedAt: "2026-09-24T12:30:00.000Z" }, "testing", null, undefined],
  ] as const)("%s", (_case, current, detected, turnStartedAt, expected) => {
    expect(nextDetectedActivityReport(current, detected, { turnStartedAt, nowIso })).toEqual(expected);
    if (expected) {
      expect(expected.source).toBe("detected");
      expect(expected.updatedAt).toBe(nowIso);
      expect(nextDetectedActivityReport(null, detected, { turnStartedAt, nowIso })).toMatchObject(expected);
    } else {
      expect(current?.updatedAt).toBeTruthy();
      expect(nextDetectedActivityReport(current, detected, { turnStartedAt, nowIso })).toBeUndefined();
    }
  });

  it("keeps activity entry time while a repeated agent report records current-turn provenance", () => {
    const current = {
      value: "testing" as const,
      source: "detected" as const,
      updatedAt: "2026-09-24T12:00:00.000Z",
    };
    const report = nextAgentActivityReport(current, "testing", nowIso);

    expect(report.updatedAt).toBe(current.updatedAt);
    expect(report.reportedAt).toBe(nowIso);
    expect(isReportFromTurn(report, "2026-09-24T12:30:00.000Z")).toBe(true);
  });
});
