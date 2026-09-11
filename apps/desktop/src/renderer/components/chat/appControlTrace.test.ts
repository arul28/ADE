import { describe, expect, it } from "vitest";
import type { AppControlActionTraceEntry, AppControlElementSnapshot } from "../../../shared/types";
import {
  countConsoleErrors,
  countNetworkFailures,
  formatLastActionLine,
  formatRelativeTime,
  formatTraceDuration,
  formatTraceRow,
  observeBadgeGlyph,
  observeIndexForHandle,
  traceActionLabel,
  traceCursorPoint,
  traceTargetLabel,
} from "./appControlTrace";

const OBSERVATION_ID = "obs-1717000000000-8b0c1a2d";

function element(overrides: Partial<AppControlElementSnapshot> = {}): AppControlElementSnapshot {
  return {
    index: 1,
    handle: `${OBSERVATION_ID}:e:1`,
    tagName: "button",
    role: "button",
    label: "Sign in",
    text: null,
    value: null,
    placeholder: null,
    selector: "button.sign-in",
    testId: null,
    href: null,
    disabled: false,
    frame: { x: 10, y: 20, width: 80, height: 30 },
    center: { x: 50, y: 35 },
    ...overrides,
  };
}

function entry(overrides: Partial<AppControlActionTraceEntry> = {}): AppControlActionTraceEntry {
  return {
    id: "trace-1",
    sessionId: "session-1",
    cdpTargetId: "target-1",
    action: "click",
    status: "ok",
    startedAt: "2026-05-12T00:00:00.000Z",
    endedAt: "2026-05-12T00:00:01.200Z",
    durationMs: 1_200,
    before: { url: null, title: null },
    after: { url: null, title: null },
    target: { handle: `${OBSERVATION_ID}:e:1` },
    observationId: OBSERVATION_ID,
    error: null,
    ...overrides,
  };
}

describe("observeBadgeGlyph", () => {
  it("uses circled digits up to twenty and plain numbers past it", () => {
    expect(observeBadgeGlyph(1)).toBe("①");
    expect(observeBadgeGlyph(20)).toBe("⑳");
    expect(observeBadgeGlyph(21)).toBe("21");
    expect(observeBadgeGlyph(0)).toBe("?");
  });
});

describe("observeIndexForHandle", () => {
  it("reads the element index out of a well-formed handle", () => {
    expect(observeIndexForHandle(`${OBSERVATION_ID}:e:7`)).toBe(7);
  });

  it("returns null for anything that is not a handle", () => {
    expect(observeIndexForHandle("button.sign-in")).toBeNull();
    expect(observeIndexForHandle(null)).toBeNull();
  });
});

describe("formatTraceDuration", () => {
  it("switches units at a second and a minute", () => {
    expect(formatTraceDuration(0)).toBe("0ms");
    expect(formatTraceDuration(840)).toBe("840ms");
    expect(formatTraceDuration(1_200)).toBe("1.2s");
    expect(formatTraceDuration(64_000)).toBe("1m 04s");
  });

  it("refuses to render a nonsense duration", () => {
    expect(formatTraceDuration(Number.NaN)).toBe("—");
    expect(formatTraceDuration(-5)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-05-12T12:00:00.000Z");

  it("reads coarsely, in the largest unit that fits", () => {
    expect(formatRelativeTime("2026-05-12T11:59:58.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-05-12T11:59:30.000Z", now)).toBe("30s ago");
    expect(formatRelativeTime("2026-05-12T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatRelativeTime("2026-05-12T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-05-09T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("never renders a negative age or an unparseable timestamp", () => {
    expect(formatRelativeTime("2026-05-12T12:00:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("not a date", now)).toBe("");
    expect(formatRelativeTime(null, now)).toBe("");
  });
});

describe("traceActionLabel", () => {
  it("keeps agent verbs sentence-case", () => {
    expect(traceActionLabel("click")).toBe("click");
    expect(traceActionLabel("FILL")).toBe("fill");
    expect(traceActionLabel("")).toBe("action");
  });
});

describe("traceTargetLabel", () => {
  it("prefers the badge and element name for a handle target", () => {
    expect(traceTargetLabel(entry(), [element()])).toBe("① Sign in");
  });

  it("falls back to the badge alone when the element is not in the map", () => {
    expect(traceTargetLabel(entry(), [])).toBe("①");
  });

  it("uses testId, text and selector before coordinates", () => {
    expect(traceTargetLabel(entry({ target: { testId: "submit" } }))).toBe("submit");
    expect(traceTargetLabel(entry({ target: { text: "Save changes" } }))).toBe('"Save changes"');
    expect(traceTargetLabel(entry({ target: { selector: "form > button" } }))).toBe("form > button");
    expect(traceTargetLabel(entry({ target: { x: 40.4, y: 91.6 } }))).toBe("40, 92");
  });

  it("says nothing rather than guessing when the trace carries no target", () => {
    expect(traceTargetLabel(entry({ target: null }))).toBe("—");
  });
});

describe("formatTraceRow", () => {
  const now = Date.parse("2026-05-12T00:00:05.000Z");

  it("formats a successful row", () => {
    expect(formatTraceRow(entry(), now, [element()])).toEqual({
      id: "trace-1",
      action: "click",
      target: "① Sign in",
      duration: "1.2s",
      relative: "just now",
      failed: false,
      error: null,
    });
  });

  it("marks a failed row and keeps its reason", () => {
    const row = formatTraceRow(
      entry({ status: "error", error: "No matching App Control element was found." }),
      now,
      [],
    );
    expect(row.failed).toBe(true);
    expect(row.error).toBe("No matching App Control element was found.");
  });
});

describe("formatLastActionLine", () => {
  const now = Date.parse("2026-05-12T00:00:05.000Z");

  it("reads as the wireframe's status line", () => {
    expect(formatLastActionLine(entry(), now, [element()])).toBe("last: click ① Sign in · 1.2s");
  });

  it("calls out a failure", () => {
    expect(formatLastActionLine(entry({ status: "error" }), now, [element()]))
      .toBe("last: click ① Sign in · 1.2s · failed");
  });

  it("omits an empty target instead of printing a dash", () => {
    expect(formatLastActionLine(entry({ target: null }), now)).toBe("last: click · 1.2s");
  });

  it("returns null with no trace", () => {
    expect(formatLastActionLine(null, now)).toBeNull();
  });
});

describe("diagnostics counts", () => {
  const diagnostics = {
    capturedAt: "2026-05-12T00:00:00.000Z",
    pendingRequestCount: 1,
    console: [
      { level: "error" as const, message: "boom", sourceId: null, line: null, column: null, timestamp: "2026-05-12T00:00:00.000Z" },
      { level: "warning" as const, message: "meh", sourceId: null, line: null, column: null, timestamp: "2026-05-12T00:00:00.000Z" },
    ],
    network: [
      { url: "/a", method: "GET", resourceType: "fetch", statusCode: 200, error: null, startedAt: null, endedAt: "2026-05-12T00:00:00.000Z", durationMs: 10 },
      { url: "/b", method: "GET", resourceType: "fetch", statusCode: 500, error: null, startedAt: null, endedAt: "2026-05-12T00:00:00.000Z", durationMs: 10 },
      { url: "/c", method: "GET", resourceType: "fetch", statusCode: null, error: "net::ERR_FAILED", startedAt: null, endedAt: "2026-05-12T00:00:00.000Z", durationMs: null },
    ],
  };

  it("counts errors but not warnings", () => {
    expect(countConsoleErrors(diagnostics)).toBe(1);
    expect(countConsoleErrors(null)).toBe(0);
  });

  it("counts both 4xx/5xx and hard failures", () => {
    expect(countNetworkFailures(diagnostics)).toBe(2);
    expect(countNetworkFailures(null)).toBe(0);
  });
});

describe("traceCursorPoint", () => {
  it("prefers the observed element centre over raw coordinates", () => {
    const point = traceCursorPoint(
      entry({ target: { handle: `${OBSERVATION_ID}:e:1`, x: 900, y: 900 } }),
      [element()],
    );
    expect(point).toEqual({ x: 50, y: 35 });
  });

  it("falls back to coordinates when nothing matches", () => {
    expect(traceCursorPoint(entry({ target: { x: 12, y: 34 } }), [])).toEqual({ x: 12, y: 34 });
  });

  it("returns null when the trace says nothing about where it aimed", () => {
    expect(traceCursorPoint(entry({ target: { key: "Enter" } }), [])).toBeNull();
  });
});
