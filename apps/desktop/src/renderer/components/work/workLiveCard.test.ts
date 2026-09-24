import { describe, expect, it } from "vitest";
import {
  macDesktopFloatState,
  WORK_LIVE_CARD_DEFAULT_WIDTH,
  WORK_LIVE_CARD_INSET,
  WORK_LIVE_CARD_MAX_HEIGHT,
  WORK_LIVE_CARD_MIN_WIDTH,
  WORK_LIVE_SCRUB_BUFFER_SIZE,
  WORK_LIVE_CARD_OBJECT_FIT,
  workLiveCardAspect,
  workLiveCardObjectFit,
  workLiveCardSize,
  workLiveCardWidthBounds,
  commitWorkLiveScrubFrame,
  formatWorkLiveActionCaption,
  workLiveActionVerb,
  formatWorkLiveAge,
  isWorkLivePictureInPictureSupported,
  isWorkLiveScreenTool,
  isWorkLiveCardClosed,
  isWorkLiveCardSeen,
  normalizeWorkLiveCardClosedByTool,
  normalizeWorkLiveCardWidth,
  normalizeWorkLiveCardPosition,
  clampWorkLiveCardRect,
  selectWorkLiveCardTool,
  updateWorkLiveScrubCaption,
  workLiveScrubFrameKey,
  workLiveSource,
  workLiveCardDragConstraints,
  workLiveCardFits,
  workLiveCardPositionFromRect,
  workLiveCardRect,
  workLiveCardTravel,
  workLiveBottomReserve,
  workLiveActivityBelongsToChat,
  workLiveHostLabel,
  workLiveIosCaption,
  workLiveIosStreamRequestUrl,
  workLiveMacDesktopSessionKey,
  workLivePreviewMaxWidth,
  workLiveScrubIndex,
  type WorkLiveActivity,
  type WorkLiveScrubFrame,
} from "./workLiveCard";

const CARD_HEIGHT = 180;
const CARD_WIDTH = WORK_LIVE_CARD_DEFAULT_WIDTH;

function activity(overrides: Partial<WorkLiveActivity> & Pick<WorkLiveActivity, "tool">): WorkLiveActivity {
  return {
    lastActivityAt: 1_000,
    available: true,
    live: true,
    ownerChatSessionId: null,
    sessionKey: `${overrides.tool}-1`,
    showWhenUnowned: true,
    ...overrides,
  };
}

/** The selector as the card calls it, with the chat on screen filled in. */
function select(args: {
  activeTool?: Parameters<typeof selectWorkLiveCardTool>[0]["activeTool"];
  activeChatSessionId?: string | null;
  activities: readonly WorkLiveActivity[];
  floatingTools?: Parameters<typeof selectWorkLiveCardTool>[0]["floatingTools"];
  closed?: Parameters<typeof selectWorkLiveCardTool>[0]["closed"];
}) {
  return selectWorkLiveCardTool({
    activeTool: null,
    activeChatSessionId: "chat-1",
    ...args,
  });
}

describe("selectWorkLiveCardTool", () => {
  it("shows the most recently active screen tool", () => {
    const tool = select({
      activeTool: "git",
      activities: [
        activity({ tool: "browser", lastActivityAt: 500 }),
        activity({ tool: "app-control", lastActivityAt: 900 }),
        activity({ tool: "ios", lastActivityAt: 700 }),
      ],
    });
    expect(tool).toBe("app-control");
  });

  it("never shows the tool already filling the pane", () => {
    const tool = select({
      activeTool: "app-control",
      activities: [
        activity({ tool: "browser", lastActivityAt: 500 }),
        activity({ tool: "app-control", lastActivityAt: 900 }),
      ],
    });
    expect(tool).toBe("browser");
  });

  it("shows nothing when the only active tool is the one on screen", () => {
    expect(select({
      activeTool: "browser",
      activities: [activity({ tool: "browser", lastActivityAt: 900 })],
    })).toBeNull();
  });

  it("skips tools that are unavailable here or not running", () => {
    expect(select({
      activeTool: null,
      activities: [
        activity({ tool: "ios", lastActivityAt: 900, available: false }),
        activity({ tool: "app-control", lastActivityAt: 800, live: false }),
        activity({ tool: "browser", lastActivityAt: 100 }),
      ],
    })).toBe("browser");
  });

  it("ignores tools that have never done anything", () => {
    expect(select({
      activeTool: null,
      activities: [activity({ tool: "browser", lastActivityAt: 0 })],
    })).toBeNull();
  });
});

describe("chat scoping", () => {
  it("shows an owned session only in its own chat", () => {
    const browser = activity({ tool: "browser", ownerChatSessionId: "chat-1" });
    expect(workLiveActivityBelongsToChat(browser, "chat-1")).toBe(true);
    expect(workLiveActivityBelongsToChat(browser, "chat-2")).toBe(false);
    // No chat selected means no owned session belongs here.
    expect(workLiveActivityBelongsToChat(browser, null)).toBe(false);
  });

  it("shows an unowned session in every chat", () => {
    const browser = activity({ tool: "browser", ownerChatSessionId: null, showWhenUnowned: true });
    expect(workLiveActivityBelongsToChat(browser, "chat-1")).toBe(true);
    expect(workLiveActivityBelongsToChat(browser, null)).toBe(true);
  });

  it("hides a lane-scoped session (mac-desktop) from a chat that does not own it", () => {
    const desktop = activity({
      tool: "mac-desktop",
      ownerChatSessionId: null,
      showWhenUnowned: false,
    });
    expect(workLiveActivityBelongsToChat(desktop, "chat-1")).toBe(false);

    const authorized = activity({
      tool: "mac-desktop",
      ownerChatSessionId: "chat-1",
      showWhenUnowned: false,
    });
    expect(workLiveActivityBelongsToChat(authorized, "chat-1")).toBe(true);
    expect(workLiveActivityBelongsToChat(authorized, "chat-2")).toBe(false);
  });

  it("never lets a session started by chat A float over chat B", () => {
    expect(select({
      activeChatSessionId: "chat-b",
      activities: [activity({ tool: "browser", ownerChatSessionId: "chat-a", lastActivityAt: 900 })],
    })).toBeNull();
  });

  it("picks the newest session owned by the chat on screen", () => {
    expect(select({
      activeChatSessionId: "chat-b",
      activities: [
        activity({ tool: "browser", ownerChatSessionId: "chat-a", lastActivityAt: 5_000 }),
        activity({ tool: "ios", ownerChatSessionId: "chat-b", lastActivityAt: 900 }),
      ],
    })).toBe("ios");
  });
});

describe("seen-key semantics", () => {
  it("matches only the exact session the chat's pane showed", () => {
    expect(isWorkLiveCardSeen({ browser: "tab-1" }, "browser", "tab-1")).toBe(true);
    expect(isWorkLiveCardSeen({ browser: "tab-1" }, "browser", "tab-2")).toBe(false);
    expect(isWorkLiveCardSeen({ browser: "tab-1" }, "ios", "tab-1")).toBe(false);
    expect(isWorkLiveCardSeen({}, "browser", "tab-1")).toBe(false);
    expect(isWorkLiveCardSeen(null, "browser", "tab-1")).toBe(false);
  });

  it("never matches an unknown session key, unlike the closed rule", () => {
    // Closed errs toward hidden; seen errs toward hidden too — an unowned
    // session with no key cannot be the one this chat looked at.
    expect(isWorkLiveCardSeen({ browser: "tab-1" }, "browser", null)).toBe(false);
    expect(isWorkLiveCardClosed({ browser: "tab-1" }, "browser", null)).toBe(true);
  });
});

describe("closed-key semantics", () => {
  it("stays closed for the same session key", () => {
    const browser = activity({ tool: "browser", sessionKey: "tab-1", lastActivityAt: 5_000 });
    expect(select({ activities: [browser], closed: { browser: "tab-1" } })).toBeNull();
    // A frame or status refresh only moves the clock; the key is unchanged.
    expect(select({
      activities: [{ ...browser, lastActivityAt: 9_000 }],
      closed: { browser: "tab-1" },
    })).toBeNull();
  });

  it("stays off for a new session key — only the toggle brings it back", () => {
    // The × / toggle marker is a statement about the TOOL in this chat, not
    // about the session it happened to be showing, so a new session does not
    // reopen a preview the user turned off.
    expect(select({
      activities: [activity({ tool: "browser", sessionKey: "tab-2", lastActivityAt: 9_000 })],
      closed: { browser: "tab-1" },
    })).toBeNull();
  });

  it("silences only the tool the close was aimed at", () => {
    expect(select({
      activities: [
        activity({ tool: "browser", sessionKey: "tab-1", lastActivityAt: 1_800 }),
        activity({ tool: "ios", sessionKey: "sim-1", lastActivityAt: 900 }),
      ],
      closed: { browser: "tab-1" },
    })).toBe("ios");
  });

  it("stays closed for a session whose key cannot be computed", () => {
    const browser = activity({ tool: "browser", sessionKey: null, lastActivityAt: 5_000 });
    expect(select({ activities: [browser], closed: { browser: "tab-1" } })).toBeNull();
  });

  it("reads a closed map defensively", () => {
    expect(normalizeWorkLiveCardClosedByTool({
      browser: "tab-1",
      git: "nope",
      ios: "",
      "app-control": 4,
    })).toEqual({ browser: "tab-1" });
    expect(normalizeWorkLiveCardClosedByTool(null)).toEqual({});
    expect(normalizeWorkLiveCardClosedByTool([1, 2])).toEqual({});
    expect(isWorkLiveCardClosed({ browser: "tab-1" }, "browser", "tab-1")).toBe(true);
    expect(isWorkLiveCardClosed({ browser: "tab-1" }, "browser", "tab-2")).toBe(false);
  });
});

describe("floating override", () => {
  it("shows a floated tool even while it fills the pane", () => {
    const browser = activity({ tool: "browser", lastActivityAt: 0, sessionKey: "tab-1" });
    expect(select({ activeTool: "browser", activities: [browser] })).toBeNull();
    expect(select({ activeTool: "browser", activities: [browser], floatingTools: ["browser"] }))
      .toBe("browser");
  });

  it("overrides a closed marker on the same session", () => {
    const browser = activity({ tool: "browser", sessionKey: "tab-1" });
    expect(select({ activities: [browser], closed: { browser: "tab-1" } })).toBeNull();
    expect(select({
      activities: [browser],
      closed: { browser: "tab-1" },
      floatingTools: ["browser"],
    })).toBe("browser");
  });

  it("still requires the floated tool to be available, but not to be live", () => {
    // A floated tool with nothing painted yet is a blank frame with its name
    // on it — the lit Float button has to produce something.
    expect(select({
      activeTool: "browser",
      activities: [activity({ tool: "browser", live: false, lastActivityAt: 0 })],
      floatingTools: ["browser"],
    })).toBe("browser");
    expect(select({
      activeTool: "browser",
      activities: [activity({ tool: "browser", live: false, available: false })],
      floatingTools: ["browser"],
    })).toBeNull();
  });

  it("shows a floated unowned session the chat has not seen, but never another chat's", () => {
    const unseen = activity({ tool: "browser", live: false, sessionKey: null, showWhenUnowned: false });
    expect(select({ activeTool: "browser", activities: [unseen] })).toBeNull();
    expect(select({ activeTool: "browser", activities: [unseen], floatingTools: ["browser"] })).toBe("browser");
    const theirs = activity({ tool: "browser", ownerChatSessionId: "chat-2", showWhenUnowned: false });
    expect(select({ activities: [theirs], floatingTools: ["browser"] })).toBeNull();
  });

  it("lets a floated tool outrank another tool's newer activity", () => {
    expect(select({
      activeTool: "browser",
      activities: [
        activity({ tool: "browser", live: false, lastActivityAt: 0 }),
        activity({ tool: "app-control", lastActivityAt: 9_000 }),
      ],
      floatingTools: ["browser"],
    })).toBe("browser");
  });
});

describe("isWorkLiveScreenTool", () => {
  it("accepts only the tools that have something to look at", () => {
    expect(isWorkLiveScreenTool("browser")).toBe(true);
    expect(isWorkLiveScreenTool("ios")).toBe(true);
    expect(isWorkLiveScreenTool("app-control")).toBe(true);
    expect(isWorkLiveScreenTool("mac-desktop")).toBe(true);
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
    expect(formatWorkLiveActionCaption("click", { text: "Sign in" })).toBe("Clicked 'Sign in'");
  });

  it("prefers the visible text over a selector", () => {
    expect(formatWorkLiveActionCaption("click", { selector: "#a > .b", text: "Sign in" }))
      .toBe("Clicked 'Sign in'");
  });

  it("falls back to the bare verb with no usable target", () => {
    expect(formatWorkLiveActionCaption("reload", null)).toBe("Reload");
    expect(formatWorkLiveActionCaption("reload", { elementIndex: 3 })).toBe("Reload");
    expect(formatWorkLiveActionCaption("reload", { text: "   " })).toBe("Reload");
  });

  it("says what an action did rather than naming the method that did it", () => {
    expect(workLiveActionVerb("stopFindInPage")).toBe("Closed find");
    expect(workLiveActionVerb("navigate")).toBe("Opened");
    expect(workLiveActionVerb("fill")).toBe("Typed");
    expect(workLiveActionVerb("handoff-end")).toBe("Handed back");
    expect(workLiveActionVerb("someNewAction")).toBe("Some new action");
    expect(workLiveActionVerb("  ")).toBe("Action");
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
    expect(rect.left).toBe(900 - CARD_WIDTH - WORK_LIVE_CARD_INSET);
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
    expect(rect.left).toBeLessThanOrEqual(420 - CARD_WIDTH - WORK_LIVE_CARD_INSET);
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

  it("normalizes a persisted width into the allowed range", () => {
    expect(normalizeWorkLiveCardWidth(360)).toBe(360);
    expect(normalizeWorkLiveCardWidth(10)).toBe(WORK_LIVE_CARD_MIN_WIDTH);
    expect(normalizeWorkLiveCardWidth(10_000)).toBe(560);
    expect(normalizeWorkLiveCardWidth("nope")).toBeNull();
  });
});

describe("drag bounds", () => {
  const host = { width: 900, height: 600 };

  it("never lets the card past the inset on any edge", () => {
    const travel = workLiveCardTravel({ host, cardHeight: CARD_HEIGHT, bottomReserve: 120 });
    expect(travel.minLeft).toBe(WORK_LIVE_CARD_INSET);
    expect(travel.minTop).toBe(WORK_LIVE_CARD_INSET);
    expect(travel.maxLeft).toBe(900 - CARD_WIDTH - WORK_LIVE_CARD_INSET);
    expect(travel.maxTop).toBe(600 - CARD_HEIGHT - WORK_LIVE_CARD_INSET - 120);
  });

  it("clamps a drag that ran off the left of the column", () => {
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
    expect(clamped.left).toBe(900 - CARD_WIDTH - WORK_LIVE_CARD_INSET);
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
    expect(workLivePreviewMaxWidth(2, 300)).toBe(600);
  });

  it("stays inside sane bounds for junk and extreme ratios", () => {
    expect(workLivePreviewMaxWidth(1)).toBe(WORK_LIVE_CARD_DEFAULT_WIDTH);
    expect(workLivePreviewMaxWidth(undefined)).toBe(WORK_LIVE_CARD_DEFAULT_WIDTH);
    expect(workLivePreviewMaxWidth(0)).toBe(WORK_LIVE_CARD_DEFAULT_WIDTH);
    expect(workLivePreviewMaxWidth(Number.NaN)).toBe(WORK_LIVE_CARD_DEFAULT_WIDTH);
    expect(workLivePreviewMaxWidth(12, 300)).toBe(960);
  });
});

describe("workLiveCardFits", () => {
  const wide = { width: 400, height: 400 };
  const landscape = { width: WORK_LIVE_CARD_DEFAULT_WIDTH, height: 180 };
  const portrait = { width: 255, height: 340 };

  it("refuses a host too small for the card at all", () => {
    expect(workLiveCardFits({ width: 300, height: 400 })).toBe(false);
    expect(workLiveCardFits({ width: 400, height: 200 })).toBe(false);
    expect(workLiveCardFits(wide)).toBe(true);
  });

  it("counts the composer's height, which the card sits above", () => {
    expect(workLiveCardFits({ width: 400, height: 300 }, 150)).toBe(false);
    expect(workLiveCardFits({ width: 400, height: 520 }, 150)).toBe(true);
    expect(workLiveCardFits({ width: 400, height: 344 }, -100)).toBe(true);
  });

  it("measures the box actually being placed, not the tallest one", () => {
    const shortColumn = { width: 400, height: 280 };
    expect(workLiveCardFits(shortColumn, 0, landscape)).toBe(true);
    expect(workLiveCardFits(shortColumn, 0, portrait)).toBe(false);
    expect(workLiveCardFits(shortColumn))
      .toBe(workLiveCardFits(shortColumn, 0, landscape));
  });

  it("shrinks into a column narrower than the full-size floor (M6)", () => {
    // 360px is under the 380px full-size floor, but the card's own bounds
    // already clamp it to the 200px minimum: hide it and the column has no
    // preview at all, show it and the picture survives at its floor.
    const host = { width: 360, height: 600 };
    const size = workLiveCardSize({ tool: "browser", width: WORK_LIVE_CARD_DEFAULT_WIDTH, host });
    expect(size.width).toBe(WORK_LIVE_CARD_MIN_WIDTH);
    expect(workLiveCardFits(host, 0, size)).toBe(true);

    // ...but a host that cannot hold the minimum card still has no room.
    const tooNarrow = { width: WORK_LIVE_CARD_MIN_WIDTH + WORK_LIVE_CARD_INSET * 2 - 1, height: 600 };
    expect(workLiveCardFits(tooNarrow, 0, workLiveCardSize({ tool: "browser", host: tooNarrow }))).toBe(false);
  });
});

describe("workLiveCardSize", () => {
  it("uses the chosen width and the landscape default aspect before a frame", () => {
    expect(workLiveCardSize({ tool: "browser" })).toEqual({ width: 288, height: 180 });
    expect(workLiveCardSize({ tool: "app-control" })).toEqual({ width: 288, height: 180 });
    // 3:4 portrait: 288 -> 384, capped at the max height and shrunk to keep it.
    expect(workLiveCardSize({ tool: "ios" })).toEqual({
      width: Math.round(WORK_LIVE_CARD_MAX_HEIGHT * 0.75),
      height: WORK_LIVE_CARD_MAX_HEIGHT,
    });
    expect(workLiveCardSize({ tool: null })).toEqual({ width: 288, height: 180 });
  });

  it("derives the box from the source picture's own aspect ratio", () => {
    // A 390x844 phone capture: no crop, the card is tall and narrow. The
    // minimum width wins over the soft height cap, so it is 200px wide.
    const portrait = workLiveCardSize({ tool: "browser", aspect: 390 / 844, width: 250 });
    expect(portrait.width).toBe(WORK_LIVE_CARD_MIN_WIDTH);
    expect(portrait.width / portrait.height).toBeCloseTo(390 / 844, 2);

    // A wide window: the height follows, well under the cap.
    const wide = workLiveCardSize({ tool: "mac-desktop", aspect: 3440 / 1440, width: 288 });
    expect(wide).toEqual({ width: 288, height: Math.round(288 / (3440 / 1440)) });
  });

  it("caps the height and shrinks the width to keep the aspect", () => {
    const size = workLiveCardSize({ tool: "browser", aspect: 0.7, width: 500 });
    expect(size.height).toBe(WORK_LIVE_CARD_MAX_HEIGHT);
    expect(size.width).toBe(Math.round(WORK_LIVE_CARD_MAX_HEIGHT * 0.7));
    expect(size.width / size.height).toBeCloseTo(0.7, 1);
  });

  it("never exceeds half the column's width", () => {
    const size = workLiveCardSize({ tool: "browser", width: 540, host: { width: 600, height: 800 } });
    expect(size.width).toBeLessThanOrEqual(300);
  });

  it("ignores a junk aspect and falls back to the tool default", () => {
    expect(workLiveCardSize({ tool: "browser", aspect: 0 })).toEqual({ width: 288, height: 180 });
    expect(workLiveCardSize({ tool: "browser", aspect: Number.NaN })).toEqual({ width: 288, height: 180 });
    expect(workLiveCardSize({ tool: "browser", aspect: -3 })).toEqual({ width: 288, height: 180 });
  });

  it("bounds the width range by the column", () => {
    expect(workLiveCardWidthBounds(0)).toEqual({ min: WORK_LIVE_CARD_MIN_WIDTH, max: 560 });
    expect(workLiveCardWidthBounds(600)).toEqual({ min: WORK_LIVE_CARD_MIN_WIDTH, max: 300 });
    expect(workLiveCardWidthBounds(2_000)).toEqual({ min: WORK_LIVE_CARD_MIN_WIDTH, max: 560 });
  });
});

describe("workLiveCardAspect / objectFit", () => {
  it("prefers the source aspect and falls back per tool", () => {
    expect(workLiveCardAspect("browser", 2)).toBe(2);
    expect(workLiveCardAspect("browser")).toBeCloseTo(1.6, 5);
    expect(workLiveCardAspect("ios")).toBeCloseTo(0.75, 5);
    expect(workLiveCardAspect(null)).toBeCloseTo(1.6, 5);
  });

  it("contains every tool's picture — nothing is cropped", () => {
    for (const tool of ["browser", "app-control", "ios", "mac-desktop"] as const) {
      expect(workLiveCardObjectFit(tool)).toBe("contain");
    }
    expect(WORK_LIVE_CARD_OBJECT_FIT).toBe("contain");
    expect(workLiveCardObjectFit(null)).toBe("contain");
  });
});

describe("workLiveMacDesktopSessionKey", () => {
  it("is stable for one display and changes when it is recreated (M2)", () => {
    const display = { displayId: 31, createdAt: "2026-09-18T19:00:00.000Z" };
    const key = workLiveMacDesktopSessionKey(display);
    expect(key).toBe("display:31:2026-09-18T19:00:00.000Z");
    // A status refresh hands back an equal display: the key must not move.
    expect(workLiveMacDesktopSessionKey({ ...display })).toBe(key);
    // A new display has a new id and a new creation time.
    expect(workLiveMacDesktopSessionKey({ displayId: 57, createdAt: "2026-09-18T19:10:00.000Z" }))
      .not.toBe(key);
  });

  it("falls back to the creation time for an off-screen-region display", () => {
    expect(workLiveMacDesktopSessionKey({ displayId: null, createdAt: "2026-09-18T19:00:00.000Z" }))
      .toBe("display:offscreen:2026-09-18T19:00:00.000Z");
    expect(workLiveMacDesktopSessionKey(null)).toBeNull();
    expect(workLiveMacDesktopSessionKey({ displayId: null, createdAt: "  " })).toBeNull();
  });
});

describe("workLiveScrubFrameKey", () => {
  it("identifies a frame by trace id, so an eviction cannot move it", () => {
    const buffer = [
      { id: "t1", dataUrl: null, caption: "click", at: 1 },
      { id: "t2", dataUrl: null, caption: "type", at: 2 },
    ];
    const held = workLiveScrubFrameKey(buffer[1]!);
    const shifted = buffer.slice(1);
    expect(shifted.findIndex((frame) => workLiveScrubFrameKey(frame) === held)).toBe(0);
  });

  it("falls back to the timestamp for a frame committed without an id", () => {
    expect(workLiveScrubFrameKey({ id: null, dataUrl: null, caption: null, at: 7 })).toBe(":7");
  });
});

describe("workLiveHostLabel", () => {
  it("reduces a URL to the host a person recognises", () => {
    expect(workLiveHostLabel("https://example.com/a/b?c=1#d")).toBe("example.com");
    expect(workLiveHostLabel("http://localhost:5173/work")).toBe("localhost:5173");
    expect(workLiveHostLabel("https://www.example.com/")).toBe("example.com");
  });

  it("hands back anything it cannot parse rather than losing the only label", () => {
    expect(workLiveHostLabel("about:blank")).toBe("about:blank");
    expect(workLiveHostLabel("localhost:5173")).toBe("localhost:5173");
    expect(workLiveHostLabel("not a url")).toBe("not a url");
    expect(workLiveHostLabel("   ")).toBeNull();
    expect(workLiveHostLabel(null)).toBeNull();
    expect(workLiveHostLabel(undefined)).toBeNull();
  });
});

describe("workLiveBottomReserve", () => {
  const host = { top: 0, bottom: 600, height: 600 };

  it("reserves from the host's bottom edge up to the obstruction's top", () => {
    expect(workLiveBottomReserve({
      host,
      obstructions: [{ top: 480, bottom: 600, height: 120 }],
    })).toBe(120);
  });

  it("covers everything below a card floating above the composer, in one number", () => {
    expect(workLiveBottomReserve({
      host,
      obstructions: [
        { top: 480, bottom: 600, height: 120 },
        { top: 400, bottom: 470, height: 70 },
      ],
    })).toBe(200);
  });

  it("ignores boxes that are hidden, at the top, or outside the host", () => {
    expect(workLiveBottomReserve({
      host,
      obstructions: [
        { top: 0, bottom: 0, height: 0 },
        { top: 0, bottom: 40, height: 40 },
        { top: 640, bottom: 700, height: 60 },
      ],
    })).toBe(0);
  });

  it("never gives up more than half the column", () => {
    expect(workLiveBottomReserve({
      host,
      obstructions: [{ top: 40, bottom: 600, height: 560 }],
    })).toBe(300);
  });

  it("answers zero for a host that has not been laid out", () => {
    expect(workLiveBottomReserve({
      host: { top: 0, bottom: 0, height: 0 },
      obstructions: [{ top: 0, bottom: 100, height: 100 }],
    })).toBe(0);
  });
});

describe("workLiveSource", () => {
  const empty = { browserTab: null, appControlSession: null, iosSession: null, macDesktopFrame: null };

  it("answers every per-tool question from one adapter", () => {
    const browser = workLiveSource("browser", {
      ...empty,
      browserTab: {
        id: "tab-1",
        ownerChatSessionId: "chat-1",
        title: "Sign in",
        url: "https://example.test/login",
        recording: { startedAt: "now" },
        handoff: { reason: "Sign in to continue" },
      },
    });
    expect(browser).toEqual({
      live: true,
      ownerLabel: "agent",
      caption: "Sign in",
      handoff: { label: "Needs you", detail: "Sign in to continue" },
      recording: { startedAt: "now" },
      sessionKey: "tab-1",
    });
  });

  it("treats a terminal App Control session as not live, and `failed` as live", () => {
    expect(workLiveSource("app-control", { ...empty, appControlSession: { status: "stopped" } }).live).toBe(false);
    expect(workLiveSource("app-control", { ...empty, appControlSession: { status: "exited" } }).live).toBe(false);
    expect(workLiveSource("app-control", { ...empty, appControlSession: { status: "failed" } }).live).toBe(true);
  });

  it("identifies each tool's session key", () => {
    expect(workLiveSource("app-control", { ...empty, appControlSession: { id: "s1", status: "connected" } }).sessionKey)
      .toBe("s1");
    expect(workLiveSource("ios", { ...empty, iosSession: { id: "i1", appName: "ADE" } }).sessionKey).toBe("i1");
    expect(workLiveSource("mac-desktop", { ...empty, macDesktopFrame: { laneId: "lane-1" } }).sessionKey)
      .toBe("lane-1");
  });

  it("prefers the display identity over the lane id for mac-desktop (M2)", () => {
    expect(workLiveSource("mac-desktop", {
      ...empty,
      macDesktopFrame: { laneId: "lane-1", displayKey: "display:31:2026-09-18T19:00:00.000Z" },
    }).sessionKey).toBe("display:31:2026-09-18T19:00:00.000Z");
  });

  it("names the Mac Desktop lease holder and its recording", () => {
    const frame = { laneId: "lane-1" };
    expect(workLiveSource("mac-desktop", {
      ...empty,
      macDesktopFrame: frame,
      macDesktopControl: { leaseHolder: "agent", recording: true },
    })).toMatchObject({ ownerLabel: "agent", recording: true });
    expect(workLiveSource("mac-desktop", {
      ...empty,
      macDesktopFrame: frame,
      macDesktopControl: { leaseHolder: "user", recording: false },
    })).toMatchObject({ ownerLabel: "you", recording: null });
    expect(workLiveSource("mac-desktop", { ...empty, macDesktopFrame: frame }))
      .toMatchObject({ ownerLabel: null, recording: null });
  });

  it("reads a simulator recording from status, and captions app over device", () => {
    expect(workLiveSource("ios", {
      ...empty,
      iosSession: {
        appName: "ADE",
        deviceName: "iPhone 17",
        chatSessionId: "chat-9",
        recording: { id: "rec-1" },
      },
    })).toMatchObject({
      live: true,
      caption: "ADE",
      recording: { id: "rec-1" },
      ownerLabel: "agent",
    });
    expect(workLiveSource("ios", {
      ...empty,
      iosSession: { deviceName: "iPhone 17" },
    }).caption).toBe("iPhone 17");
  });

  it("reports nothing for a tool with no state", () => {
    for (const tool of ["browser", "app-control", "ios"] as const) {
      expect(workLiveSource(tool, empty)).toEqual({
        live: false,
        ownerLabel: null,
        caption: null,
        handoff: null,
        recording: null,
        sessionKey: null,
      });
    }
  });
});

describe("workLiveIosCaption", () => {
  it("prefers the foreground app, then the device name", () => {
    expect(workLiveIosCaption({ appName: "MyApp", name: "iPhone 17" })).toBe("MyApp");
    expect(workLiveIosCaption({ appName: null, name: "iPhone 17" })).toBe("iPhone 17");
    expect(workLiveIosCaption({ appName: "  ", name: "  " })).toBeNull();
  });
});

describe("picture-in-picture gating", () => {
  it("is off in jsdom, where the document has no PiP API", () => {
    expect(isWorkLivePictureInPictureSupported()).toBe(false);
    expect(isWorkLivePictureInPictureSupported({ pictureInPictureEnabled: false })).toBe(false);
  });

  it("strips the query string the helper never reads", () => {
    expect(workLiveIosStreamRequestUrl("http://127.0.0.1:9/stream?token=secret"))
      .toBe("http://127.0.0.1:9/stream");
  });
});

describe("macDesktopFloatState", () => {
  const BASE = {
    active: true,
    laneId: "lane-1",
    chatSessionId: "chat-1",
    supported: true,
    authorized: true,
    dismissed: false,
    hasPicture: true,
    off: false,
    floated: false,
    decoding: false,
    paneTool: null,
  } as const;

  it("floats a picture the chat may see while the pane shows something else", () => {
    expect(macDesktopFloatState(BASE)).toEqual({ present: true, visible: true });
    expect(macDesktopFloatState({ ...BASE, paneTool: "git" })).toEqual({ present: true, visible: true });
  });

  it("is never in view while the pane shows the Mac Desktop, floated or not", () => {
    expect(macDesktopFloatState({ ...BASE, paneTool: "mac-desktop" })).toEqual({ present: true, visible: false });
    expect(macDesktopFloatState({ ...BASE, paneTool: "mac-desktop", floated: true }).visible).toBe(false);
  });

  it("wants a picture, the Off state, or an explicit float", () => {
    expect(macDesktopFloatState({ ...BASE, hasPicture: false }).present).toBe(false);
    expect(macDesktopFloatState({ ...BASE, hasPicture: false, off: true }).visible).toBe(true);
    expect(macDesktopFloatState({ ...BASE, hasPicture: false, floated: true }).visible).toBe(true);
  });

  it("is in view while it decodes the first frame, not hidden behind it", () => {
    expect(macDesktopFloatState({ ...BASE, hasPicture: false, decoding: true }))
      .toEqual({ present: true, visible: true });
    expect(macDesktopFloatState({ ...BASE, hasPicture: false, decoding: true, paneMounted: true }).visible)
      .toBe(false);
  });

  it("shows nothing to a chat that may not see it, or that turned it off", () => {
    expect(macDesktopFloatState({ ...BASE, authorized: false }).present).toBe(false);
    expect(macDesktopFloatState({ ...BASE, dismissed: true }).present).toBe(false);
    expect(macDesktopFloatState({ ...BASE, chatSessionId: null }).present).toBe(false);
    expect(macDesktopFloatState({ ...BASE, supported: false }).present).toBe(false);
    expect(macDesktopFloatState({ ...BASE, active: false }).present).toBe(false);
  });
});
