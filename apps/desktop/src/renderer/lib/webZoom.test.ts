/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyHostedWebZoom,
  __resetHostedWebZoomForTests,
  cssZoomOf,
  fixedFrameOf,
  fixedPoint,
  fixedRect,
  fixedViewport,
} from "./webZoom";

describe("applyHostedWebZoom", () => {
  afterEach(() => {
    __resetHostedWebZoomForTests();
  });

  it("inverse-sizes body so zoomed used size matches the viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    applyHostedWebZoom(1.4);

    const bodyStyle = document.body.style;
    expect(parseFloat(bodyStyle.width) * 1.4).toBeCloseTo(1400, 5);
    expect(parseFloat(bodyStyle.height) * 1.4).toBeCloseTo(900, 5);
  });

  it("inverse-sizes at the hosted 100% factor so default zoom still fills one viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 880 });
    applyHostedWebZoom(1.1);
    expect(parseFloat(document.body.style.width) * 1.1).toBeCloseTo(1100, 5);
    expect(parseFloat(document.body.style.height) * 1.1).toBeCloseTo(880, 5);
  });

  it("repaints the inverse box on window resize", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    applyHostedWebZoom(1.4);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 2100 });
    window.dispatchEvent(new Event("resize"));

    expect(parseFloat(document.body.style.width) * 1.4).toBeCloseTo(2100, 5);
  });

  it("does not throw when window is a stub without EventTarget (adapter tests)", () => {
    const originalAdd = window.addEventListener;
    Object.defineProperty(window, "addEventListener", { configurable: true, value: undefined });
    try {
      expect(() => applyHostedWebZoom(1.4)).not.toThrow();
    } finally {
      Object.defineProperty(window, "addEventListener", { configurable: true, value: originalAdd });
    }
  });

});

function rectOf(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/** The body at hosted zoom `zoom`: layout width 1000, rendered `zoom` times wider. */
function stubZoomedBody(zoom: number) {
  Object.defineProperty(document.body, "offsetWidth", { configurable: true, value: 1000 });
  document.body.getBoundingClientRect = () => rectOf(0, 0, 1000 * zoom, 800 * zoom);
}

describe("fixed placement frame under the hosted zoom", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  afterEach(() => {
    __resetHostedWebZoomForTests();
    delete (document.body as unknown as { offsetWidth?: number }).offsetWidth;
    delete (document.body as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    document.body.innerHTML = "";
  });

  it("measures the body zoom as rect width over layout width", () => {
    stubZoomedBody(1.1);
    expect(cssZoomOf()).toBeCloseTo(1.1, 6);
  });

  it("converts a screen rect and pointer into the viewport frame by the zoom", () => {
    stubZoomedBody(1.1);
    const frame = fixedFrameOf(null);
    expect(frame).toEqual({ originX: 0, originY: 0, scaleX: expect.any(Number), scaleY: expect.any(Number) });
    expect(frame.scaleX).toBeCloseTo(1.1, 6);
    expect(frame.scaleY).toBeCloseTo(1.1, 6);
    const rect = fixedRect(frame, rectOf(110, 55, 110, 22));
    expect(rect.left).toBeCloseTo(100, 6);
    expect(rect.right).toBeCloseTo(200, 6);
    expect(rect.width).toBeCloseTo(100, 6);
    // A pointer is a viewport point too, so it converts the same way as a rect edge.
    expect(fixedPoint(frame, 150, 60).left).toBeCloseTo(150 / 1.1, 6);
    // The window is 1280 screen px, 1163.6 in style px.
    expect(fixedViewport(frame).width).toBeCloseTo(1280 / 1.1, 6);
  });

  it("is the identity at zoom 1, as in Electron", () => {
    stubZoomedBody(1);
    const frame = fixedFrameOf(null);
    expect(frame.scaleX).toBe(1);
    expect(frame.scaleY).toBe(1);
    expect(fixedRect(frame, rectOf(120, 40, 80, 20))).toMatchObject({ left: 120, top: 40, width: 80, height: 20 });
    expect(fixedViewport(frame).width).toBe(1280);
  });

  it("uses a transformed ancestor as the containing block, with its own scale and origin", () => {
    stubZoomedBody(1.1);
    const panel = document.createElement("div");
    panel.style.transform = "scale(0.5)";
    document.body.appendChild(panel);
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 100 });
    panel.getBoundingClientRect = () => rectOf(300, 100, 200 * 1.1 * 0.5, 100 * 1.1 * 0.5);
    const child = document.createElement("div");
    panel.appendChild(child);
    const frame = fixedFrameOf(child.parentElement);
    expect(frame.originX).toBe(300);
    expect(frame.originY).toBe(100);
    expect(frame.scaleX).toBeCloseTo(1.1 * 0.5, 6);
    expect(frame.scaleY).toBeCloseTo(1.1 * 0.5, 6);
  });

  it("ignores a plain (non-containing-block) ancestor", () => {
    stubZoomedBody(1.1);
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    plain.getBoundingClientRect = () => rectOf(40, 40, 100, 100);
    const frame = fixedFrameOf(plain);
    expect(frame.originX).toBe(0);
    expect(frame.originY).toBe(0);
  });

  it("places each axis by its own scale under a non-uniform transform", () => {
    stubZoomedBody(1.1);
    const panel = document.createElement("div");
    panel.style.transform = "scale(0.5, 0.75)";
    document.body.appendChild(panel);
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 100 });
    panel.getBoundingClientRect = () => rectOf(300, 100, 200 * 1.1 * 0.5, 100 * 1.1 * 0.75);
    const frame = fixedFrameOf(panel);
    expect(frame.originX).toBe(300);
    expect(frame.originY).toBe(100);
    expect(frame.scaleX).toBeCloseTo(1.1 * 0.5, 6);
    expect(frame.scaleY).toBeCloseTo(1.1 * 0.75, 6);
    // Style point (40, 20) inside the panel, drawn at its screen position.
    const rect = fixedRect(frame, rectOf(300 + 40 * 0.55, 100 + 20 * 0.825, 10 * 0.55, 10 * 0.825));
    expect(rect.left).toBeCloseTo(40, 6);
    expect(rect.top).toBeCloseTo(20, 6);
    expect(rect.width).toBeCloseTo(10, 6);
    expect(rect.height).toBeCloseTo(10, 6);
    const point = fixedPoint(frame, 300 + 40 * 0.55, 100 + 20 * 0.825);
    expect(point.left).toBeCloseTo(40, 6);
    expect(point.top).toBeCloseTo(20, 6);
  });

  it("falls back to the viewport frame under a rotated containing block", () => {
    stubZoomedBody(1.1);
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    panel.getBoundingClientRect = () => rectOf(300, 100, 50, 50);
    const realGetComputedStyle = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) =>
      el === panel
        ? ({ transform: "matrix(0.866, 0.5, -0.5, 0.866, 0, 0)" } as CSSStyleDeclaration)
        : realGetComputedStyle(el, pseudo),
    );
    try {
      const frame = fixedFrameOf(panel);
      expect(frame).toEqual({ originX: 0, originY: 0, scaleX: expect.any(Number), scaleY: expect.any(Number) });
      expect(frame.scaleX).toBeCloseTo(1.1, 6);
      expect(frame.scaleY).toBeCloseTo(1.1, 6);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("falls back to the viewport frame under a skewed ancestor of the containing block", () => {
    stubZoomedBody(1.1);
    const skewed = document.createElement("div");
    const panel = document.createElement("div");
    skewed.appendChild(panel);
    document.body.appendChild(skewed);
    panel.getBoundingClientRect = () => rectOf(300, 100, 50, 50);
    const realGetComputedStyle = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) =>
      el === skewed
        ? ({ transform: "matrix(1, 0, 0.4, 1, 0, 0)" } as CSSStyleDeclaration)
        : el === panel
          ? ({ transform: "matrix(0.5, 0, 0, 0.5, 0, 0)" } as CSSStyleDeclaration)
          : realGetComputedStyle(el, pseudo),
    );
    try {
      const frame = fixedFrameOf(panel);
      expect(frame.originX).toBe(0);
      expect(frame.originY).toBe(0);
      expect(frame.scaleX).toBeCloseTo(1.1, 6);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
