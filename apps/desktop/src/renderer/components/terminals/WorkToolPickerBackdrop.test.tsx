/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BACKDROP_FRAME_MS,
  BACKDROP_MAX_DPR,
  BACKDROP_PIXEL_BUDGET,
  WorkToolPickerBackdrop,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./WorkToolPickerBackdrop";

/**
 * A WebGL context that answers every call the backdrop makes.
 *
 * Deliberately not `getContext → null`: the paths that matter here are the ones
 * where the context is REAL and the component decides not to use it, and a null
 * context cannot prove a context was released.
 */
function stubGl() {
  const loseContext = vi.fn();
  const lose = { loseContext };
  let renderer = "ANGLE (Apple, Apple M3 Max, OpenGL 4.1)";
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    LINK_STATUS: 3,
    ARRAY_BUFFER: 4,
    STATIC_DRAW: 5,
    FLOAT: 6,
    TRIANGLES: 7,
    getExtension: (name: string) => {
      if (name === "WEBGL_lose_context") return lose;
      if (name === "WEBGL_debug_renderer_info") return { UNMASKED_RENDERER_WEBGL: 37446 };
      return null;
    },
    getParameter: () => renderer,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    useProgram: () => {},
    deleteProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    uniform3fv: () => {},
    uniform4f: () => {},
    viewport: () => {},
    drawArrays: vi.fn(),
  };
  return {
    gl,
    loseContext,
    setRenderer: (name: string) => {
      renderer = name;
    },
  };
}

/** Installs the stub and hands back the canvas the component asked for. */
function useStubGl(gl: object): { canvas: () => HTMLCanvasElement | null } {
  let seen: HTMLCanvasElement | null = null;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function getContext(this: HTMLCanvasElement) {
      seen = this;
      return gl as unknown as RenderingContext;
    } as HTMLCanvasElement["getContext"],
  );
  return { canvas: () => seen };
}

const RECT = {
  width: 400,
  height: 300,
  top: 0,
  left: 0,
  right: 400,
  bottom: 300,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

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

describe("WorkToolPickerBackdrop context lifecycle", () => {
  beforeAll(() => {
    // jsdom ships neither observer; the backdrop uses both.
    class NoopObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;
    }
    if (typeof globalThis.IntersectionObserver === "undefined") {
      globalThis.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver;
    }
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hands the context back when it refuses a software rasteriser", () => {
    // The refuse paths are where this bites: the component remounts on every
    // picker ↔ tool crossfade, so a context that is only abandoned means a new
    // one per crossfade until the driver's cap starts evicting other canvases.
    const { gl, loseContext, setRenderer } = stubGl();
    setRenderer("Google SwiftShader");
    const { canvas } = useStubGl(gl);

    const { container } = render(<WorkToolPickerBackdrop theme="dark" />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-backdrop='static']")).toBeTruthy();
    expect(loseContext).toHaveBeenCalledTimes(1);
    // And the drawing buffer is gone even where the extension is not.
    expect(canvas()?.width).toBe(1);
    expect(canvas()?.height).toBe(1);
  });

  it("hands the context back when the program will not link", () => {
    const { gl, loseContext } = stubGl();
    const linkFailure = { ...gl, getProgramParameter: () => false };
    useStubGl(linkFailure);

    const { container } = render(<WorkToolPickerBackdrop theme="dark" />);

    expect(container.querySelector("[data-backdrop='static']")).toBeTruthy();
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("falls back to the static gradient when the GPU takes the context back", () => {
    const { gl } = stubGl();
    useStubGl(gl);
    // jsdom reports the document as unfocused, and the loop is gated on focus:
    // without this there would be no frame in flight to prove was cancelled.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");

    const { container } = render(<WorkToolPickerBackdrop theme="dark" />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();

    act(() => {
      canvas?.dispatchEvent(new Event("webglcontextlost"));
    });

    // No `preventDefault`, so no restore: a machine that just lost its context
    // gets the cheap gradient rather than a rebuilt shader.
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-backdrop='static']")).toBeTruthy();
    // …and the loop stopped rather than spinning on a dead context.
    expect(cancel).toHaveBeenCalled();
  });

  it("measures the layout once per frame, not once per scroll event", async () => {
    const { gl } = stubGl();
    useStubGl(gl);
    // The pointer effect is what wires the capture-phase scroll listener at
    // all, so this is the only configuration where the cost exists.
    vi.spyOn(window, "matchMedia").mockImplementation(((query: string) => ({
      matches: query.includes("hover") || query.includes("pointer"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia);
    const rect = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockReturnValue(RECT);

    render(<WorkToolPickerBackdrop theme="dark" />);
    const baseline = rect.mock.calls.length;

    for (let i = 0; i < 12; i += 1) window.dispatchEvent(new Event("scroll"));
    // `getBoundingClientRect` forces layout; a wheel gesture must not force a
    // dozen of them in one frame.
    expect(rect.mock.calls.length).toBe(baseline);

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(rect.mock.calls.length - baseline).toBe(1);
  });
});
