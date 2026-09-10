/* @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKDROP_FRAME_MS,
  BACKDROP_MAX_DPR,
  BACKDROP_PIXEL_BUDGET,
  WorkToolPickerBackdrop,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./WorkToolPickerBackdrop";

describe("resolveBackdropSize", () => {
  it("never renders above DPR 1, whatever the display claims", () => {
    // The whole point of the cap: on a 2× panel a 400×300 pane would otherwise
    // cost four times the fragments for a gradient with nothing to resolve.
    expect(resolveBackdropSize(400, 300, 2)).toEqual({ width: 400, height: 300 });
    expect(resolveBackdropSize(400, 300, 3)).toEqual({ width: 400, height: 300 });
    expect(BACKDROP_MAX_DPR).toBe(1);
  });

  it("holds the pixel budget on a pane wider than the budget allows", () => {
    // A tools pane pulled out across a 6K display.
    const big = resolveBackdropSize(2400, 1400, 1);
    expect(big.width * big.height).toBeLessThanOrEqual(BACKDROP_PIXEL_BUDGET);
    // Downscaled, not letterboxed: the aspect ratio survives, because the
    // canvas keeps its CSS size and the drawing buffer is stretched to it.
    expect(big.width / big.height).toBeCloseTo(2400 / 1400, 1);
    // And it really is close to the budget rather than far under it.
    expect(big.width * big.height).toBeGreaterThan(BACKDROP_PIXEL_BUDGET * 0.9);
  });

  it("leaves a pane inside the budget at its own size", () => {
    // The pane's default width, in a tall window: well inside 600k.
    expect(resolveBackdropSize(447, 900, 1)).toEqual({ width: 447, height: 900 });
  });

  it("survives a zero-sized or nonsense box instead of asking WebGL for one", () => {
    // A pane mid-collapse, and a `getBoundingClientRect` before first layout.
    expect(resolveBackdropSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
    expect(resolveBackdropSize(Number.NaN, 300, Number.NaN)).toEqual({ width: 1, height: 300 });
  });

  it("caps the frame rate at 30, so a 240Hz panel costs seven skipped frames", () => {
    expect(BACKDROP_FRAME_MS).toBeCloseTo(1000 / 30, 5);
  });
});

describe("backdropThemeFor", () => {
  it("keeps light well under dark's intensity and vignette", () => {
    const dark = backdropThemeFor("dark");
    const light = backdropThemeFor("light");
    expect(dark.intensity).toBeCloseTo(0.4, 2);
    expect(light.intensity).toBeLessThan(dark.intensity);
    expect(light.vignette).toBeLessThan(dark.vignette);
    // Dark sits slightly under the mesh's own brightness so the flat cards
    // still read as the brightest thing on the page.
    expect(dark.brightness).toBeLessThan(0);
    expect(dark.saturation).toBeLessThan(1);
  });

  it("starts each ramp on that theme's own canvas and never exceeds 8 stops", () => {
    const dark = backdropThemeFor("dark");
    const light = backdropThemeFor("light");
    // #0C0B10 — `--color-bg`.
    expect(dark.colors[0]).toEqual([0x0c / 255, 0x0b / 255, 0x10 / 255]);
    // #faf8f5 — `--color-surface` in light.
    expect(light.colors[0]).toEqual([0xfa / 255, 0xf8 / 255, 0xf5 / 255]);
    expect(dark.colors.length).toBeLessThanOrEqual(8);
    expect(light.colors.length).toBeLessThanOrEqual(8);
    expect(dark.colors.length).toBeGreaterThan(1);
  });
});

describe("isSoftwareRenderer", () => {
  it("names the rasterisers that must not be handed a per-pixel mesh", () => {
    expect(isSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareRenderer("Microsoft Basic Render Driver")).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (Apple, Apple M3 Max, OpenGL 4.1)")).toBe(false);
    expect(isSoftwareRenderer("ANGLE (NVIDIA GeForce RTX 4070 Direct3D11)")).toBe(false);
    expect(isSoftwareRenderer("")).toBe(false);
  });
});

describe("WorkToolPickerBackdrop", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("falls back to the static gradient when WebGL is refused", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    const { container } = render(
      <WorkToolPickerBackdrop theme="dark" className="ade-tool-picker-backdrop" />,
    );

    // No canvas left behind: a canvas element with no context is a layer the
    // compositor still has to carry.
    expect(container.querySelector("canvas")).toBeNull();
    const fallback = container.querySelector("[data-backdrop='static']");
    expect(fallback).toBeTruthy();
    // Both classes: the caller's positioning and the gradient itself.
    expect(fallback?.className).toContain("ade-tool-picker-backdrop");
    expect(fallback?.className).toContain("ade-tool-picker-static");
    expect(fallback?.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back the same way when getContext throws", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("no GPU process");
    });

    const { container } = render(<WorkToolPickerBackdrop theme="light" />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-backdrop='static']")).toBeTruthy();
  });

  it("refuses a software rasteriser the same way it refuses no WebGL", () => {
    // Chromium hands back SwiftShader on a blacklisted driver or in a VM: the
    // context is real, and every fragment of the mesh would land on the CPU.
    const fakeGl = {
      getExtension: (name: string) =>
        (name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 37446 } : null),
      getParameter: () => "Google SwiftShader",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeGl as unknown as RenderingContext,
    );

    const { container } = render(<WorkToolPickerBackdrop theme="dark" />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-backdrop='static']")).toBeTruthy();
  });

  it("unmounts without leaving a live context or a pending frame", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");

    const view = render(<WorkToolPickerBackdrop theme="dark" />);
    expect(() => view.unmount()).not.toThrow();
    // Nothing to cancel on the fallback path — the loop was never started.
    expect(cancel).not.toHaveBeenCalled();
  });
});
