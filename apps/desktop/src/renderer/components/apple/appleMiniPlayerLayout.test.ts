import { describe, expect, it } from "vitest";
import {
  APPLE_MINI_PLAYER_EDGE_GAP,
  appleMiniPlayerSourceSize,
  clampAppleMiniPlayerPosition,
  resizeAppleMiniPlayer,
  resolveAppleMiniPlayerFrame,
} from "./appleMiniPlayerLayout";

const CONTAINER = { width: 1_000, height: 800 };
const PHONE = { width: 1_179, height: 2_556 };

describe("appleMiniPlayerSourceSize", () => {
  it("stands a phone shape in until the first frame reports a size", () => {
    const fallback = appleMiniPlayerSourceSize(null);
    expect(fallback.width / fallback.height).toBeCloseTo(9 / 19.5, 5);
    // A zero-sized frame is the same "nothing yet", not a divide by zero.
    expect(appleMiniPlayerSourceSize({ width: 0, height: 0 })).toEqual(fallback);
  });

  it("takes a landscape frame as landscape", () => {
    expect(appleMiniPlayerSourceSize({ width: 2_556, height: 1_179 }))
      .toEqual({ width: 2_556, height: 1_179 });
  });
});

describe("resolveAppleMiniPlayerFrame", () => {
  it("opens in the top-right corner at the default 320px box", () => {
    const frame = resolveAppleMiniPlayerFrame({
      width: null,
      position: null,
      source: PHONE,
      container: CONTAINER,
    });
    expect(frame.y).toBe(APPLE_MINI_PLAYER_EDGE_GAP);
    expect(frame.x + frame.width).toBe(CONTAINER.width - APPLE_MINI_PLAYER_EDGE_GAP);
    // The 320px box would put a 19.5:9 phone at 148px wide, which is below the
    // 240px floor — so the floor wins and the box is taller than 320. A player
    // you can still hit with a pointer beats a player that fits a square.
    expect(frame.width).toBe(240);
    expect(frame.width / frame.height).toBeCloseTo(PHONE.width / PHONE.height, 2);
  });

  it("holds the aspect ratio, so the picture never letterboxes", () => {
    const frame = resolveAppleMiniPlayerFrame({
      width: 500,
      position: { x: 40, y: 40 },
      source: PHONE,
      container: CONTAINER,
    });
    expect(frame.width / frame.height).toBeCloseTo(PHONE.width / PHONE.height, 2);
  });

  it("never goes below the 240×150 minimum", () => {
    const frame = resolveAppleMiniPlayerFrame({
      width: 10,
      position: null,
      source: { width: 1_000, height: 1_000 },
      container: CONTAINER,
    });
    expect(frame.width).toBeGreaterThanOrEqual(240);
    expect(frame.height).toBeGreaterThanOrEqual(150);
  });

  it("clamps to a shrinking container without destroying the stored width", () => {
    const stored = 500;
    const narrow = resolveAppleMiniPlayerFrame({
      width: stored,
      position: null,
      source: PHONE,
      container: { width: 320, height: 800 },
    });
    expect(narrow.width).toBeLessThanOrEqual(320 - APPLE_MINI_PLAYER_EDGE_GAP * 2);
    // The same stored width in a roomy container is untouched, which is the
    // point of clamping on read rather than writing the clamp back.
    const roomy = resolveAppleMiniPlayerFrame({
      width: stored,
      position: null,
      source: PHONE,
      container: { width: 1_600, height: 1_400 },
    });
    expect(roomy.width).toBe(stored);
  });
});

describe("clampAppleMiniPlayerPosition", () => {
  it("keeps the whole player inside the container, gap included", () => {
    const player = { width: 300, height: 600 };
    expect(clampAppleMiniPlayerPosition({ x: -80, y: -80 }, CONTAINER, player))
      .toEqual({ x: APPLE_MINI_PLAYER_EDGE_GAP, y: APPLE_MINI_PLAYER_EDGE_GAP });
    expect(clampAppleMiniPlayerPosition({ x: 9_999, y: 9_999 }, CONTAINER, player)).toEqual({
      x: CONTAINER.width - player.width - APPLE_MINI_PLAYER_EDGE_GAP,
      y: CONTAINER.height - player.height - APPLE_MINI_PLAYER_EDGE_GAP,
    });
  });
});

describe("resizeAppleMiniPlayer", () => {
  const start = { x: 100, y: 100, width: 300, height: 650 };

  it("anchors the opposite edge when dragging west", () => {
    const next = resizeAppleMiniPlayer({
      start,
      direction: "west",
      delta: { x: -100, y: 0 },
      source: PHONE,
      container: { width: 1_600, height: 1_600 },
    });
    expect(next.x + next.width).toBe(start.x + start.width);
    expect(next.width).toBeGreaterThan(start.width);
  });

  it("anchors the opposite edge when dragging north", () => {
    const next = resizeAppleMiniPlayer({
      start,
      direction: "north",
      delta: { x: 0, y: -60 },
      source: PHONE,
      container: { width: 1_600, height: 1_600 },
    });
    expect(next.y + next.height).toBe(start.y + start.height);
  });

  it("holds the ratio on a corner drag and stops at the container", () => {
    const next = resizeAppleMiniPlayer({
      start,
      direction: "south-east",
      delta: { x: 5_000, y: 5_000 },
      source: PHONE,
      container: CONTAINER,
    });
    expect(next.width / next.height).toBeCloseTo(PHONE.width / PHONE.height, 2);
    expect(next.x + next.width).toBeLessThanOrEqual(CONTAINER.width - APPLE_MINI_PLAYER_EDGE_GAP);
    expect(next.y + next.height).toBeLessThanOrEqual(CONTAINER.height - APPLE_MINI_PLAYER_EDGE_GAP);
  });
});
