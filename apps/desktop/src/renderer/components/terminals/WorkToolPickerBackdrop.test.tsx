/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BACKDROP_FRAME_MS,
  BACKDROP_IDLE_FRAME_MS,
  BACKDROP_MAX_DPR,
  BACKDROP_PIXEL_BUDGET,
  WorkToolPickerBackdrop,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./WorkToolPickerBackdrop";
import { FRAG, UNIFORMS } from "./workToolPickerBackdropShader";

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

  it("drops to 20 fps when nothing is chasing the pointer", () => {
    // Idle is what this page is doing essentially all the time, and the drift
    // underneath the swirl moves a few pixels a second. The 30 fps ceiling is
    // for the cursor, which has to keep up with a hand.
    expect(BACKDROP_IDLE_FRAME_MS).toBeCloseTo(1000 / 20, 5);
    expect(BACKDROP_IDLE_FRAME_MS).toBeGreaterThan(BACKDROP_FRAME_MS);
  });

  it("leaves the reference's 5-tap blur out of the fragment shader", () => {
    // The reference component sets `blur: 0.0072`, which re-evaluates the mesh
    // five times PER PIXEL to soften what the gaussian falloff already softened.
    // Its renderer can afford that at DPR 2 and a 2M-pixel budget; a pane that
    // shares a renderer with a terminal, a browser view and a chat stream
    // cannot. If a blur ever comes back, this budget has to be re-argued.
    expect(FRAG).not.toMatch(/blur/iu);
    expect(UNIFORMS).not.toHaveProperty("blur");
    // The one pointer mode we did adopt — the reference's "rotate" swirl.
    expect(UNIFORMS.cursorStrength).toBeCloseTo(0.73, 3);
    expect(UNIFORMS.cursorRadius).toBeCloseTo(0.365, 3);
  });
});

describe("backdropThemeFor", () => {
  const luma = (c: readonly [number, number, number]) =>
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  it("does not darken either ramp back into the page behind it", () => {
    // The regression this file exists to prevent: the dark ramp used to end at
    // `--color-accent-bright` and then subtract 0.24 of brightness off, which
    // put its median luminance within nine levels of `--color-bg` and made the
    // whole backdrop invisible. The reference recipe runs brightness at 0 and
    // buys card legibility with `.ade-tool-picker-scrim` instead.
    for (const theme of ["dark", "light"] as const) {
      const { brightness, saturation } = backdropThemeFor(theme);
      expect(brightness).toBe(0);
      // Desaturating was the other half of the old disappearing act.
      expect(saturation).toBe(1);
    }
  });

  it("bottoms out on a tinted deep tone, never on the page's own black", () => {
    // The reference's base stop is `#031C26`, not `#000`. A ramp that bottoms
    // out on `--color-bg` has no bottom — it dissolves into the pane.
    const base = backdropThemeFor("dark").colors[0]!;
    expect(luma(base)).toBeGreaterThan(0.04);
    expect(luma(base)).toBeLessThan(0.16);
    // Tinted, not grey: violet means blue leads red leads green.
    expect(base[2]).toBeGreaterThan(base[0]);
    expect(base[0]).toBeGreaterThan(base[1]);
    // Light starts on its own canvas, `--color-surface`.
    expect(backdropThemeFor("light").colors[0]).toEqual([0xfa / 255, 0xf8 / 255, 0xf5 / 255]);
  });

  it("carries the reference's four-stop structure up to a near-white highlight", () => {
    const spreadOf = (theme: "dark" | "light") => {
      const { colors } = backdropThemeFor(theme);
      // Four stops, like the reference. Never more than the shader's 8.
      expect(colors.length).toBe(4);
      expect(colors.length).toBeLessThanOrEqual(8);
      return Math.max(...colors.map(luma)) - Math.min(...colors.map(luma));
    };
    // Dark matches the reference's envelope: the top stop is what makes it a
    // gradient rather than a tint, and dropping its near-white for
    // `--color-accent-bright` costs ~45 points of peak luminance.
    expect(spreadOf("dark")).toBeGreaterThan(0.75);
    expect(luma(backdropThemeFor("dark").colors.at(-1)!)).toBeGreaterThan(0.9);
    // Light deliberately runs a shorter ramp — inverting the reference's p5 of
    // ~13 onto a light canvas reads as a stain, not as light. The floor here is
    // still a real guard: the old flat light ramp spread only 0.34.
    expect(spreadOf("light")).toBeGreaterThan(0.4);
  });

  it("paints light in ADE's green and dark in ADE's violet", () => {
    // Light's accent is `#049068`, not a violet — the violets this ramp used to
    // hardcode were the dark theme's `--color-accent-*` leaking through a light
    // block that never redefines them.
    const lightAccent = backdropThemeFor("light").colors.at(-1)!;
    expect(lightAccent[1]).toBeGreaterThan(lightAccent[0]);
    expect(lightAccent[1]).toBeGreaterThan(lightAccent[2]);
    const darkAccent = backdropThemeFor("dark").colors[1]!;
    expect(darkAccent[2]).toBeGreaterThan(darkAccent[1]);
    expect(darkAccent[2]).toBeGreaterThan(darkAccent[0]);
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

describe("WorkToolPickerBackdrop frame scheduling", () => {
  beforeAll(() => {
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
    vi.useRealTimers();
  });

  it("waits on a timer between frames instead of a rAF per display refresh", () => {
    // Measured in the real pane before this: 240 rAF callbacks a second to draw
    // 30 frames, because the loop asked for a frame and skipped seven of every
    // eight. A page with a pending rAF is a page the compositor schedules a
    // BeginFrame for on every vsync — on the 240Hz panel this repo is developed
    // on that is eight wake-ups per drawn frame, for one drawn frame.
    const { gl } = stubGl();
    useStubGl(gl);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.useFakeTimers();
    let pending: FrameRequestCallback | null = null;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      pending = cb;
      return 1;
    });

    render(<WorkToolPickerBackdrop theme="dark" />);

    // The FIRST animated frame is still asked for straight away — mount paints
    // one frame outright, and the loop should not sleep before it starts.
    expect(raf).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // After that frame lands, the next one is owed to the clock, not to the
    // display: no rAF is left pending, so no BeginFrame is scheduled for it.
    act(() => {
      pending?.(performance.now());
    });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("paints one frame and stops under reduced motion", () => {
    const { gl } = stubGl();
    useStubGl(gl);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(window, "matchMedia").mockImplementation(((query: string) => ({
      matches: query.includes("reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia);
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    render(<WorkToolPickerBackdrop theme="dark" />);

    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on a battery that is low and not charging, and resumes when it charges", async () => {
    const { gl } = stubGl();
    useStubGl(gl);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const listeners = new Map<string, () => void>();
    const status = {
      charging: false,
      level: 0.12,
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    (navigator as unknown as { getBattery?: () => Promise<typeof status> }).getBattery = () =>
      Promise.resolve(status);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");

    render(<WorkToolPickerBackdrop theme="dark" />);
    const mountDraws = gl.drawArrays.mock.calls.length;
    // The battery answer is a promise, so the loop starts and then stands down.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalled();
    const frames = gl.drawArrays.mock.calls.length;
    // The last composited frame stays on screen; nothing new is drawn.
    expect(frames).toBe(mountDraws);

    // Plugged in: the drift comes back.
    status.charging = true;
    act(() => {
      listeners.get("chargingchange")?.();
    });
    expect(listeners.size).toBe(2);

    delete (navigator as unknown as { getBattery?: unknown }).getBattery;
  });
});
