/**
 * Which of the host's words are a request, and which merely describe the frame.
 *
 * `surfaceId` is on every envelope, so reading it as an instruction made the
 * stored surface unreachable: a reader who left History on Activity came back
 * to the commit graph every time, and the saved event id was discarded on the
 * way. The rule is that `surfaceId` counts only beside a pointer or a subject.
 */

import { describe, expect, it } from "vitest";

import type { PluginWebviewContext } from "../src/bridge";
import { historyFocusFromContext } from "../src/lib/historyFocus";
import { pickLane } from "../src/history/HistoryPage";
import type { HistoryLane } from "../src/lib/types";

function context(overrides: Partial<PluginWebviewContext> = {}): PluginWebviewContext {
  return { subject: null, surfaceId: "commits", placement: "tab", ...overrides };
}

describe("the focus the host asked for", () => {
  it("names no surface when the envelope only describes the placement", () => {
    expect(historyFocusFromContext(context()).surface).toBeNull();
    expect(historyFocusFromContext(context({ surfaceId: "activity" })).surface).toBeNull();
    expect(historyFocusFromContext(context({ pointer: {} })).surface).toBeNull();
  });

  it("trusts surfaceId once the host also named a pointer or a subject", () => {
    expect(
      historyFocusFromContext(context({ surfaceId: "activity", pointer: { eventId: "op-1" } }))
        .surface,
    ).toBe("activity");
    expect(
      historyFocusFromContext(
        context({ surfaceId: "commits", subject: { kind: "lane", id: "lane-9" } }),
      ).surface,
    ).toBe("commits");
  });

  it("takes an explicit pointer surface whatever the placement says", () => {
    expect(
      historyFocusFromContext(context({ surfaceId: "commits", pointer: { surface: "activity" } }))
        .surface,
    ).toBe("activity");
  });

  it("still reads the lane, commit and event the host pointed at", () => {
    const focus = historyFocusFromContext(
      context({ pointer: { laneId: "lane-2", commitSha: "abc", eventId: "op-7" } }),
    );
    expect(focus).toMatchObject({ laneId: "lane-2", commitSha: "abc", eventId: "op-7" });
  });
});

describe("which lane History draws", () => {
  const lanes: HistoryLane[] = [
    { id: "lane-1", name: "first" },
    { id: "lane-2", name: "second" },
  ];

  it("prefers the lane the app is on over the first one listed", () => {
    expect(pickLane(lanes, "lane-2", null)).toBe("lane-2");
    expect(pickLane(lanes, "lane-2", "lane-1")).toBe("lane-2");
  });

  it("falls to the reader's stored lane, then to the first", () => {
    expect(pickLane(lanes, null, "lane-2")).toBe("lane-2");
    expect(pickLane(lanes, null, null)).toBe("lane-1");
    expect(pickLane(lanes, null, "gone")).toBe("lane-1");
  });

  it("keeps a lane the host named even when the list has not caught up", () => {
    expect(pickLane(lanes, "lane-brand-new", "lane-1")).toBe("lane-brand-new");
    expect(pickLane([], null, null)).toBeNull();
  });
});
