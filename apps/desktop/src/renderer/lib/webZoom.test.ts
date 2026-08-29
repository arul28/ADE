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

    const bodyStyle = document.body.style as CSSStyleDeclaration & { zoom?: string };
    expect(document.documentElement.style.getPropertyValue("--ade-web-zoom-factor")).toBe("1.4");
    expect(bodyStyle.zoom).toBe("1.4");
    expect(parseFloat(bodyStyle.width) * 1.4).toBeCloseTo(1400, 5);
    expect(parseFloat(bodyStyle.height) * 1.4).toBeCloseTo(900, 5);
    expect(bodyStyle.minHeight).toBe(bodyStyle.height);
  });

  it("inverse-sizes at the hosted 100% factor so default zoom still fills one viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 880 });
    applyHostedWebZoom(1.1);
    expect(parseFloat(document.body.style.width) * 1.1).toBeCloseTo(1100, 5);
    expect(parseFloat(document.body.style.height) * 1.1).toBeCloseTo(880, 5);
  });

  it("keeps a definite body box at factor 1 so h-full still fills the viewport", () => {
    applyHostedWebZoom(1.4);
    applyHostedWebZoom(1);

    const bodyStyle = document.body.style as CSSStyleDeclaration & { zoom?: string };
    expect(bodyStyle.zoom).toBe("");
    expect(bodyStyle.width).toBe("100%");
    expect(bodyStyle.height).toBe("100%");
    expect(bodyStyle.minHeight).toBe("100%");
    expect(document.documentElement.style.getPropertyValue("--ade-web-zoom-factor")).toBe("1");
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
      expect(document.documentElement.style.getPropertyValue("--ade-web-zoom-factor")).toBe("1.4");
    } finally {
      Object.defineProperty(window, "addEventListener", { configurable: true, value: originalAdd });
    }
  });

  it("pins html and #root to a percentage box so h-full can fill the inverse size", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    try {
      applyHostedWebZoom(1.4);
      expect(document.documentElement.style.height).toBe("100%");
      expect(document.documentElement.style.overflow).toBe("hidden");
      expect(root.style.height).toBe("100%");
      expect(root.style.overflow).toBe("hidden");
    } finally {
      root.remove();
    }
  });
});
