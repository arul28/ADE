/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { applyHostedWebZoom, __resetHostedWebZoomForTests } from "./webZoom";

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
