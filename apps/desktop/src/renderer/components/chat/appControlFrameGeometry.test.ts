import { describe, expect, it } from "vitest";
import type { AppControlSnapshot } from "../../../shared/types";
import {
  appControlDisplayedMetrics,
  appControlOverlayBox,
  mapClientPointToFrame,
} from "./appControlFrameGeometry";

const LIVE = {
  width: 2560,
  height: 1600,
  viewportWidth: 1280,
  viewportHeight: 800,
  scale: 2,
  scaleX: 2,
  scaleY: 2,
};

function snapshot(screen: Partial<AppControlSnapshot["screen"]>, screenshot: { width: number; height: number } | null) {
  return { screen, screenshot } as unknown as AppControlSnapshot;
}

describe("appControlDisplayedMetrics", () => {
  it("prefers the live frame while the screencast is running", () => {
    expect(appControlDisplayedMetrics({
      liveFrameActive: true,
      liveFrameDims: LIVE,
      snapshot: snapshot({ scale: 1 }, { width: 100, height: 100 }),
    })).toBe(LIVE);
  });

  it("falls back to the snapshot when the live dims are incomplete", () => {
    const metrics = appControlDisplayedMetrics({
      liveFrameActive: true,
      liveFrameDims: { ...LIVE, viewportWidth: 0 },
      snapshot: snapshot({ scale: 2 }, { width: 800, height: 600 }),
    });
    expect(metrics).toMatchObject({ width: 800, height: 600, viewportWidth: 400, viewportHeight: 300 });
  });

  it("derives a missing viewport from the device size and the scale", () => {
    expect(appControlDisplayedMetrics({
      liveFrameActive: false,
      liveFrameDims: null,
      snapshot: snapshot({ scaleX: 2, scaleY: 4 }, { width: 800, height: 800 }),
    })).toMatchObject({ viewportWidth: 400, viewportHeight: 200, scaleX: 2, scaleY: 4 });
  });

  it("has nothing to report without a screenshot", () => {
    expect(appControlDisplayedMetrics({
      liveFrameActive: false,
      liveFrameDims: null,
      snapshot: snapshot({ scale: 1 }, null),
    })).toBeNull();
  });
});

describe("mapClientPointToFrame", () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };

  it("maps the centre of the image to the centre of the app viewport", () => {
    expect(mapClientPointToFrame({ clientX: 420, clientY: 250, rect, metrics: LIVE }))
      .toMatchObject({ viewportX: 640, viewportY: 400, imageX: 1280, imageY: 800, leftPct: 50, topPct: 50 });
  });

  it("clamps a pointer that left the image, so a drag cannot send negative coordinates", () => {
    expect(mapClientPointToFrame({ clientX: -500, clientY: -500, rect, metrics: LIVE }))
      .toMatchObject({ viewportX: 0, viewportY: 0, leftPct: 0, topPct: 0 });
    expect(mapClientPointToFrame({ clientX: 9999, clientY: 9999, rect, metrics: LIVE }))
      .toMatchObject({ viewportX: 1280, viewportY: 800, leftPct: 100, topPct: 100 });
  });

  /*
    The stage frame is inset 8px inside the pane, and the overlays that sit on
    top of the frame — observe badges, the agent cursor — are positioned from
    this mapping. It stays honest through the inset for one reason: the rect
    handed in is the IMAGE's, never the container's, so moving the container
    moves the rect with it.
  */
  it("follows the image rather than the pane, so insetting the stage shifts nothing", () => {
    const inset = { ...rect, left: rect.left + 8, top: rect.top + 8 };
    expect(mapClientPointToFrame({ clientX: 428, clientY: 258, rect: inset, metrics: LIVE }))
      .toMatchObject({ viewportX: 640, viewportY: 400, leftPct: 50, topPct: 50 });
  });

  it("maps nothing without metrics or a laid-out image", () => {
    expect(mapClientPointToFrame({ clientX: 0, clientY: 0, rect, metrics: null })).toBeNull();
    expect(mapClientPointToFrame({
      clientX: 0,
      clientY: 0,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      metrics: LIVE,
    })).toBeNull();
  });
});

describe("appControlOverlayBox", () => {
  it("expresses an element's viewport frame as percentages of the image", () => {
    expect(appControlOverlayBox({ x: 640, y: 400, width: 320, height: 200 }, LIVE))
      .toEqual({ left: "50%", top: "50%", width: "25%", height: "25%" });
  });

  it("draws nothing when the viewport has no size", () => {
    expect(appControlOverlayBox({ x: 0, y: 0, width: 1, height: 1 }, null)).toBeNull();
    expect(appControlOverlayBox({ x: 0, y: 0, width: 1, height: 1 }, { ...LIVE, viewportWidth: 0 })).toBeNull();
  });
});
