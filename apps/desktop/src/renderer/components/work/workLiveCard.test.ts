import { describe, expect, it } from "vitest";
import {
  WORK_LIVE_CARD_INSET,
  WORK_LIVE_CARD_WIDTH,
  WORK_LIVE_SCRUB_BUFFER_SIZE,
  commitWorkLiveScrubFrame,
  formatWorkLiveActionCaption,
  formatWorkLiveAge,
  isWorkLiveScreenTool,
  clampWorkLiveCardRect,
  commitWorkLiveCardDismissal,
  normalizeWorkLiveCardDismissals,
  normalizeWorkLiveCardPosition,
  selectWorkLiveCardTool,
  updateWorkLiveScrubCaption,
  workLiveCardDragConstraints,
  workLiveCardFits,
  workLiveCardPositionFromRect,
  workLiveCardRect,
  workLiveCardTravel,
  workLivePreviewMaxWidth,
  workLiveScrubIndex,
  type WorkLiveActivity,
  type WorkLiveScrubFrame,
} from "./workLiveCard";

const CARD_HEIGHT = 207;

function activity(overrides: Partial<WorkLiveActivity> & Pick<WorkLiveActivity, "tool">): WorkLiveActivity {
  return {
    lastActivityAt: 1_000,
    available: true,
    live: true,
    ...overrides,
  };
}

describe("selectWorkLiveCardTool", () => {
  it("shows the most recently active screen tool", () => {
    const tool = selectWorkLiveCardTool({
      activeTool: "git",
      activities: [
        activity({ tool: "browser", lastActivityAt: 500 }),
        activity({ tool: "app-control", lastActivityAt: 900 }),
        activity({ tool: "ios", lastActivityAt: 700 }),
      ],
      dismissals: null,
    });
    expect(tool).toBe("app-control");
  });

  it("never shows the tool already filling the pane", () => {
    const tool = selectWorkLiveCardTool({
      activeTool: "app-control",
      activities: [
        activity({ tool: "browser", lastActivityAt: 500 }),
        activity({ tool: "app-control", lastActivityAt: 900 }),
      ],
      dismissals: null,
    });
    expect(tool).toBe("browser");
  });

  it("shows nothing when the only active tool is the one on screen", () => {
    expect(selectWorkLiveCardTool({
      activeTool: "browser",
      activities: [activity({ tool: "browser", lastActivityAt: 900 })],
      dismissals: null,
    })).toBeNull();
  });

  it("skips tools that are unavailable here or not running", () => {
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities: [
        activity({ tool: "ios", lastActivityAt: 900, available: false }),
        activity({ tool: "app-control", lastActivityAt: 800, live: false }),
        activity({ tool: "browser", lastActivityAt: 100 }),
      ],
      dismissals: null,
    })).toBe("browser");
  });

  it("ignores tools that have never done anything", () => {
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities: [activity({ tool: "browser", lastActivityAt: 0 })],
      dismissals: null,
    })).toBeNull();
  });

  it("stays hidden after a dismissal until something newer happens", () => {
    const activities = [activity({ tool: "browser", lastActivityAt: 1_000 })];
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities,
      dismissals: { browser: 1_000 },
    })).toBeNull();
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities,
      dismissals: { browser: 1_500 },
    })).toBeNull();
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities: [activity({ tool: "browser", lastActivityAt: 2_000 })],
      dismissals: { browser: 1_500 },
    })).toBe("browser");
  });

  it("silences only the tool the dismissal was aimed at", () => {
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities: [
        activity({ tool: "browser", lastActivityAt: 1_800 }),
        activity({ tool: "ios", lastActivityAt: 900 }),
      ],
      dismissals: { browser: 2_000 },
    })).toBe("ios");
  });
});

describe("dismissals", () => {
  it("records the stamp a tool was dismissed at, leaving the others alone", () => {
    const first = commitWorkLiveCardDismissal(null, "browser", 1_000);
    expect(first).toEqual({ browser: 1_000 });
    const second = commitWorkLiveCardDismissal(first, "ios", 2_000);
    expect(second).toEqual({ browser: 1_000, ios: 2_000 });
    expect(first).toEqual({ browser: 1_000 });
  });

  it("never moves a stamp backwards", () => {
    const dismissals = commitWorkLiveCardDismissal({ browser: 5_000 }, "browser", 1_000);
    expect(dismissals.browser).toBe(5_000);
  });

  it("drops keys that are not screen tools and stamps that are not stamps", () => {
    expect(normalizeWorkLiveCardDismissals({
      browser: 1_000,
      git: 2_000,
      ios: "soon",
      "app-control": -4,
    })).toEqual({ browser: 1_000 });
    expect(normalizeWorkLiveCardDismissals({ git: 1 })).toBeNull();
    expect(normalizeWorkLiveCardDismissals(null)).toBeNull();
    expect(normalizeWorkLiveCardDismissals([1, 2])).toBeNull();
    expect(normalizeWorkLiveCardDismissals("nope")).toBeNull();
  });

  it("round-trips through the normalizer so a persisted dismissal still hides", () => {
    const persisted = JSON.parse(JSON.stringify(
      commitWorkLiveCardDismissal(null, "browser", 4_000),
    )) as unknown;
    expect(selectWorkLiveCardTool({
      activeTool: null,
      activities: [activity({ tool: "browser", lastActivityAt: 3_900 })],
      dismissals: normalizeWorkLiveCardDismissals(persisted),
    })).toBeNull();
  });
});

describe("isWorkLiveScreenTool", () => {
  it("accepts only the tools that have something to look at", () => {
    expect(isWorkLiveScreenTool("browser")).toBe(true);
    expect(isWorkLiveScreenTool("ios")).toBe(true);
    expect(isWorkLiveScreenTool("app-control")).toBe(true);
    expect(isWorkLiveScreenTool("git")).toBe(false);
    expect(isWorkLiveScreenTool("files")).toBe(false);
    expect(isWorkLiveScreenTool(null)).toBe(false);
  });
});

describe("commitWorkLiveScrubFrame", () => {
  const frame = (at: number): WorkLiveScrubFrame => ({ dataUrl: `d${at}`, caption: `c${at}`, at });

  it("appends in order", () => {
    const buffer = commitWorkLiveScrubFrame(commitWorkLiveScrubFrame([], frame(1)), frame(2));
    expect(buffer.map((entry) => entry.at)).toEqual([1, 2]);
  });

  it("caps at ten entries, dropping the oldest", () => {
    let buffer: WorkLiveScrubFrame[] = [];
    for (let i = 1; i <= 14; i += 1) buffer = commitWorkLiveScrubFrame(buffer, frame(i));
    expect(buffer).toHaveLength(WORK_LIVE_SCRUB_BUFFER_SIZE);
    expect(buffer[0]?.at).toBe(5);
    expect(buffer[buffer.length - 1]?.at).toBe(14);
  });

  it("does not mutate the buffer it was given", () => {
    const original: WorkLiveScrubFrame[] = [frame(1)];
    commitWorkLiveScrubFrame(original, frame(2));
    expect(original).toHaveLength(1);
  });

  it("keeps an entry whose frame never arrived", () => {
    const buffer = commitWorkLiveScrubFrame([], { dataUrl: null, caption: "click", at: 5 });
    expect(buffer[0]).toEqual({ dataUrl: null, caption: "click", at: 5 });
  });
});

describe("workLiveScrubIndex", () => {
  it("maps the left edge to the oldest frame and the right edge to the newest", () => {
    expect(workLiveScrubIndex({ frameCount: 5, offsetX: 0, width: 260 })).toBe(0);
    expect(workLiveScrubIndex({ frameCount: 5, offsetX: 260, width: 260 })).toBe(4);
  });

  it("maps the middle to the middle", () => {
    expect(workLiveScrubIndex({ frameCount: 5, offsetX: 130, width: 260 })).toBe(2);
  });

  it("clamps a pointer that ran past the card", () => {
    expect(workLiveScrubIndex({ frameCount: 3, offsetX: -40, width: 260 })).toBe(0);
    expect(workLiveScrubIndex({ frameCount: 3, offsetX: 900, width: 260 })).toBe(2);
  });

  it("refuses to scrub a buffer with nothing to scrub through", () => {
    expect(workLiveScrubIndex({ frameCount: 1, offsetX: 130, width: 260 })).toBeNull();
    expect(workLiveScrubIndex({ frameCount: 0, offsetX: 130, width: 260 })).toBeNull();
    expect(workLiveScrubIndex({ frameCount: 5, offsetX: 10, width: 0 })).toBeNull();
  });
});

describe("captions", () => {
  it("quotes what the action was aimed at", () => {
    expect(formatWorkLiveActionCaption("click", { text: "Sign in" })).toBe("click 'Sign in'");
  });

  it("prefers the visible text over a selector", () => {
    expect(formatWorkLiveActionCaption("click", { selector: "#a > .b", text: "Sign in" }))
      .toBe("click 'Sign in'");
  });

  it("falls back to the bare verb with no usable target", () => {
    expect(formatWorkLiveActionCaption("reload", null)).toBe("reload");
    expect(formatWorkLiveActionCaption("reload", { elementIndex: 3 })).toBe("reload");
    expect(formatWorkLiveActionCaption("reload", { text: "   " })).toBe("reload");
  });

  it("truncates a target too long for the card", () => {
    const caption = formatWorkLiveActionCaption("click", { text: "x".repeat(80) });
    expect(caption.length).toBeLessThan(45);
    expect(caption.endsWith("…'")).toBe(true);
  });

  it("ages in the shortest honest unit", () => {
    expect(formatWorkLiveAge(0)).toBe("0s");
    expect(formatWorkLiveAge(2_400)).toBe("2s");
    expect(formatWorkLiveAge(4 * 60_000)).toBe("4m");
    expect(formatWorkLiveAge(3 * 3_600_000)).toBe("3h");
    expect(formatWorkLiveAge(50 * 3_600_000)).toBe("2d");
    expect(formatWorkLiveAge(-100)).toBe("0s");
  });
});

describe("placement", () => {
  it("refuses to render in a box it would cover", () => {
    expect(workLiveCardFits({ width: 900, height: 600 })).toBe(true);
    expect(workLiveCardFits({ width: 320, height: 600 })).toBe(false);
    expect(workLiveCardFits({ width: 900, height: 200 })).toBe(false);
  });

  it("defaults to the bottom-right corner, above the composer", () => {
    const rect = workLiveCardRect({
      host: { width: 900, height: 600 },
      position: null,
      cardHeight: CARD_HEIGHT,
      bottomReserve: 120,
    });
    expect(rect.left).toBe(900 - WORK_LIVE_CARD_WIDTH - WORK_LIVE_CARD_INSET);
    expect(rect.top).toBe(600 - CARD_HEIGHT - WORK_LIVE_CARD_INSET - 120);
  });

  it("round-trips a dragged position", () => {
    const host = { width: 900, height: 600 };
    const position = workLiveCardPositionFromRect({ host, left: 200, top: 150, cardHeight: CARD_HEIGHT });
    const rect = workLiveCardRect({ host, position, cardHeight: CARD_HEIGHT });
    expect(rect.left).toBeCloseTo(200, 0);
    expect(rect.top).toBeCloseTo(150, 0);
  });

  it("keeps a position saved in a wide column on screen in a narrow one", () => {
    const rect = workLiveCardRect({
      host: { width: 420, height: 320 },
      position: { xPct: 1, yPct: 1 },
      cardHeight: CARD_HEIGHT,
      bottomReserve: 0,
    });
    expect(rect.left).toBeLessThanOrEqual(420 - WORK_LIVE_CARD_WIDTH - WORK_LIVE_CARD_INSET);
    expect(rect.top).toBeLessThanOrEqual(320 - CARD_HEIGHT - WORK_LIVE_CARD_INSET);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
  });

  it("normalizes a persisted position and rejects junk", () => {
    expect(normalizeWorkLiveCardPosition({ xPct: 0.4, yPct: 0.2 })).toEqual({ xPct: 0.4, yPct: 0.2 });
    expect(normalizeWorkLiveCardPosition({ xPct: 4, yPct: -3 })).toEqual({ xPct: 1, yPct: 0 });
    expect(normalizeWorkLiveCardPosition({ xPct: "a", yPct: 1 })).toBeNull();
    expect(normalizeWorkLiveCardPosition(null)).toBeNull();
    expect(normalizeWorkLiveCardPosition("nope")).toBeNull();
  });
});

describe("drag bounds", () => {
  const host = { width: 900, height: 600 };

  it("never lets the card past the inset on any edge", () => {
    const travel = workLiveCardTravel({ host, cardHeight: CARD_HEIGHT, bottomReserve: 120 });
    expect(travel.minLeft).toBe(WORK_LIVE_CARD_INSET);
    expect(travel.minTop).toBe(WORK_LIVE_CARD_INSET);
    expect(travel.maxLeft).toBe(900 - WORK_LIVE_CARD_WIDTH - WORK_LIVE_CARD_INSET);
    expect(travel.maxTop).toBe(600 - CARD_HEIGHT - WORK_LIVE_CARD_INSET - 120);
  });

  it("clamps a drag that ran off the left of the column", () => {
    // The reported bug: dragging left parked the card under the column's
    // `overflow-hidden`, which ate the title and half the caption.
    const clamped = clampWorkLiveCardRect({ host, left: -180, top: 40, cardHeight: CARD_HEIGHT });
    expect(clamped.left).toBe(WORK_LIVE_CARD_INSET);
    expect(clamped.top).toBe(40);
  });

  it("clamps a drag that ran off the bottom-right", () => {
    const clamped = clampWorkLiveCardRect({
      host,
      left: 4_000,
      top: 4_000,
      cardHeight: CARD_HEIGHT,
      bottomReserve: 120,
    });
    expect(clamped.left).toBe(900 - WORK_LIVE_CARD_WIDTH - WORK_LIVE_CARD_INSET);
    expect(clamped.top).toBe(600 - CARD_HEIGHT - WORK_LIVE_CARD_INSET - 120);
  });

  it("expresses the same box as an offset budget around the card's origin", () => {
    const origin = workLiveCardRect({ host, position: null, cardHeight: CARD_HEIGHT, bottomReserve: 120 });
    const constraints = workLiveCardDragConstraints({
      host,
      origin,
      cardHeight: CARD_HEIGHT,
      bottomReserve: 120,
    });
    // Parked in the bottom-right corner: no room right or down, the rest of the
    // column to the left and up.
    expect(constraints.right).toBe(0);
    expect(constraints.bottom).toBe(0);
    expect(origin.left + constraints.left).toBe(WORK_LIVE_CARD_INSET);
    expect(origin.top + constraints.top).toBe(WORK_LIVE_CARD_INSET);
  });

  it("degenerates safely in a box smaller than the card", () => {
    const tiny = { width: 200, height: 120 };
    const constraints = workLiveCardDragConstraints({
      host: tiny,
      origin: { left: 12, top: 12 },
      cardHeight: CARD_HEIGHT,
    });
    expect(constraints.right).toBeGreaterThanOrEqual(constraints.left);
    expect(constraints.bottom).toBeGreaterThanOrEqual(constraints.top);
  });
});

describe("updateWorkLiveScrubCaption", () => {
  it("fills in the caption of the frame with that trace id", () => {
    const buffer = commitWorkLiveScrubFrame(
      commitWorkLiveScrubFrame([], { id: "t1", dataUrl: "d1", caption: null, at: 1 }),
      { id: "t2", dataUrl: "d2", caption: null, at: 2 },
    );
    const next = updateWorkLiveScrubCaption(buffer, "t2", "click 'Save'");
    expect(next[0]?.caption).toBeNull();
    expect(next[1]?.caption).toBe("click 'Save'");
  });

  it("ignores an id the ring buffer has already dropped", () => {
    const buffer = commitWorkLiveScrubFrame([], { id: "t1", dataUrl: "d1", caption: null, at: 1 });
    expect(updateWorkLiveScrubCaption(buffer, "gone", "click")).toEqual(buffer);
  });

  it("does not mutate the buffer it was given", () => {
    const buffer = commitWorkLiveScrubFrame([], { id: "t1", dataUrl: "d1", caption: null, at: 1 });
    updateWorkLiveScrubCaption(buffer, "t1", "click");
    expect(buffer[0]?.caption).toBeNull();
  });
});

describe("workLivePreviewMaxWidth", () => {
  it("asks for the card's width in device pixels", () => {
    expect(workLivePreviewMaxWidth(2)).toBe(Math.max(320, WORK_LIVE_CARD_WIDTH * 2));
  });

  it("stays inside sane bounds for junk and extreme ratios", () => {
    expect(workLivePreviewMaxWidth(1)).toBe(320);
    expect(workLivePreviewMaxWidth(undefined)).toBe(320);
    expect(workLivePreviewMaxWidth(0)).toBe(320);
    expect(workLivePreviewMaxWidth(Number.NaN)).toBe(320);
    expect(workLivePreviewMaxWidth(12)).toBe(960);
  });
});
