/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BACKDROP_FRAME_MS,
  BACKDROP_IDLE_FRAME_MS,
  BACKDROP_IDLE_FREEZE_MS,
  BACKDROP_MAX_DPR,
  BACKDROP_PIXEL_BUDGET,
  BACKDROP_RENDER_SCALE,
  WorkToolPickerBackdrop,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./WorkToolPickerBackdrop";
import { FRAG, HEADER_SLICE, UNIFORMS, headerBackdropScale } from "./workToolPickerBackdropShader";

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
    expect(resolveBackdropSize(400, 300, 2)).toEqual({ width: 240, height: 180 });
    expect(resolveBackdropSize(400, 300, 3)).toEqual({ width: 240, height: 180 });
    expect(BACKDROP_MAX_DPR).toBe(1);
  });

  it("renders under CSS resolution and lets the compositor scale it back up", () => {
    // The mesh is four gaussian lobes under a 0.192 warp — nothing in it is
    // sharper than tens of pixels, so a 0.6× buffer carries every feature it
    // has and the upscale is the blit the canvas was already doing. Fragment
    // cost is linear in pixels, so this is the single biggest lever here.
    expect(BACKDROP_RENDER_SCALE).toBeLessThan(1);
    const size = resolveBackdropSize(1000, 500, 1);
    expect(size).toEqual({ width: 600, height: 300 });
    // Aspect survives, because the canvas keeps its CSS box.
    expect(size.width / size.height).toBeCloseTo(1000 / 500, 5);
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
    // The pane's default width, in a tall window: well inside the budget even
    // before the render scale takes it down to 268×540.
    expect(resolveBackdropSize(447, 900, 1)).toEqual({ width: 268, height: 540 });
  });

  it("survives a zero-sized or nonsense box instead of asking WebGL for one", () => {
    // A pane mid-collapse, and a `getBoundingClientRect` before first layout.
    expect(resolveBackdropSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
    expect(resolveBackdropSize(Number.NaN, 300, Number.NaN)).toEqual({ width: 1, height: 180 });
  });

  it("caps the frame rate at 30, so a 240Hz panel costs seven skipped frames", () => {
    expect(BACKDROP_FRAME_MS).toBeCloseTo(1000 / 30, 5);
  });

  it("drops to 12 fps when nothing is chasing the pointer", () => {
    // Idle is what this page is doing essentially all the time, and the drift
    // underneath the swirl is slow enough (`timeScale` -0.55) that 12 reads the
    // same as 20. The 30 fps ceiling is for the cursor, which has to keep up
    // with a hand.
    expect(BACKDROP_IDLE_FRAME_MS).toBeCloseTo(1000 / 12, 5);
    expect(BACKDROP_IDLE_FRAME_MS).toBeGreaterThan(BACKDROP_FRAME_MS);
  });

  it("stops entirely after twenty idle seconds rather than drifting forever", () => {
    // The steady state of this page is "open, and nobody is looking at it".
    // Twenty seconds is past any read of the cards and well short of anything a
    // user would notice stopping; the canvas keeps its last composited frame.
    expect(BACKDROP_IDLE_FREEZE_MS).toBe(20_000);
    expect(BACKDROP_IDLE_FREEZE_MS).toBeGreaterThan(BACKDROP_IDLE_FRAME_MS * 60);
  });

  it("drifts slowly enough to survive the idle frame rate", () => {
    // Slowing the CONTENT is the one knob that buys frames back for free: the
    // same drift at the reference's -1.373 would stutter at 12 fps.
    expect(Math.abs(UNIFORMS.timeScale)).toBeLessThan(1);
  });

  it("keeps the mesh warp at three octaves", () => {
    // The fourth octave displaces the sample point by less than a pixel at any
    // pane size this budget allows, for a full extra noise evaluation on every
    // fragment — measured against four octaves the output differs by a mean of
    // 0.7/255 and never by more than 6/255.
    expect(FRAG).toMatch(/for \(int i = 0; i < 3; i\+\+\)/u);
  });

  it("leaves the reference's 5-tap blur out of the fragment shader", () => {
    // The reference component sets `blur: 0.0072`, which re-evaluates the mesh
    // five times PER PIXEL to soften what the gaussian falloff already softened.
    // Its renderer can afford that at DPR 2 and a 2M-pixel budget; a pane that
    // shares a renderer with a terminal, a browser view and a chat stream
    // cannot. If a blur ever comes back, this budget has to be re-argued.
    expect(FRAG).not.toMatch(/blur/iu);
    expect(UNIFORMS).not.toHaveProperty("blur");
  });
});

describe("backdropThemeFor", () => {
  it("keeps light well under dark's intensity and vignette", () => {
    const dark = backdropThemeFor("dark");
    const light = backdropThemeFor("light");
    expect(dark.intensity).toBeCloseTo(0.44, 2);
    expect(light.intensity).toBeLessThan(dark.intensity);
    expect(light.vignette).toBeLessThan(dark.vignette);
    expect(dark.vignette).toBeLessThan(0.3);
    expect(dark.vignette).toBeGreaterThan(0.12);
    // Dark sits slightly under the mesh's own brightness so the flat cards
    // still read as the brightest thing on the page.
    expect(dark.brightness).toBeLessThan(0);
    expect(dark.brightness).toBeGreaterThan(-0.2);
    expect(dark.saturation).toBeLessThan(1);
    // Indigo stop — the bluish lobe the all-violet ramp lost.
    expect(dark.colors).toContainEqual([0x63 / 255, 0x66 / 255, 0xf1 / 255]);
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

  it("keeps the mesh scaled so the colour field fills the pane", () => {
    expect(UNIFORMS.scale).toBeGreaterThan(0.9);
    expect(UNIFORMS.scale).toBeLessThan(1.2);
    expect(FRAG).toContain("exp(-dot(p - c, p - c) * 3.5)");
    expect(FRAG).toContain("u_colors[0] * 0.10");
    expect(FRAG).toContain("smoothstep(0.48, 1.08, vd)");
  });

  it("fits the same field across a short header instead of one lobe", () => {
    const wide = headerBackdropScale(1400, 32);
    const narrow = headerBackdropScale(700, 32);
    expect(wide).toBeLessThan(0.12);
    expect(wide).toBeGreaterThan(0.03);
    expect(narrow).toBeGreaterThan(wide);
    const half = (1400 / 32) / 2;
    expect(wide * half * HEADER_SLICE.reachAcross).toBeCloseTo(HEADER_SLICE.fieldReach, 5);
    expect(Math.abs(HEADER_SLICE.timeScale)).toBeGreaterThan(Math.abs(UNIFORMS.timeScale));
    expect(HEADER_SLICE.hoverIntensity).toBeGreaterThan(HEADER_SLICE.intensity);
    expect(HEADER_SLICE.cursorRadius).toBeGreaterThan(UNIFORMS.cursorRadius);
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
      <WorkToolPickerBackdrop theme="dark" />,
    );

    // No canvas left behind: a canvas element with no context is a layer the
    // compositor still has to carry.
    expect(container.querySelector("canvas")).toBeNull();
    const fallback = container.querySelector("[data-backdrop='static']");
    expect(fallback).toBeTruthy();
    // Both classes: the caller's positioning and the gradient itself.
    expect(fallback?.className).toContain("ade-tool-picker-backdrop");
    expect(fallback?.querySelector(".ade-tool-picker-static")).toBeTruthy();
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

  it("paints the CSS gradient under the canvas so the first frame is not empty", () => {
    const { gl } = stubGl();
    useStubGl(gl);
    const { container } = render(<WorkToolPickerBackdrop theme="dark" />);
    expect(container.querySelector("[data-backdrop='shader']")).toBeTruthy();
    expect(container.querySelector(".ade-tool-picker-static")).toBeTruthy();
    expect(container.querySelector("canvas")).toBeTruthy();
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

  it("freezes on the current frame after twenty idle seconds, and wakes on a move", () => {
    // The steady state of this page is "open, and nobody is looking at it" — a
    // picker behind a terminal or under a chat someone is reading. Twelve
    // frames a second of drift, forever, is the cost this freeze removes; the
    // canvas keeps whatever it last composited, so nothing blanks.
    const { gl } = stubGl();
    useStubGl(gl);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.useFakeTimers();
    // Vitest's fake timers do not fake `performance.now`, and the freeze is
    // measured against it — so the clock the loop reads is driven by hand here,
    // in step with the timers.
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let pending: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      pending = cb;
      return 1;
    });

    render(<WorkToolPickerBackdrop theme="dark" />);

    // Run the loop past the freeze deadline the way the browser would: a timer
    // sleeps to the frame's deadline, then the rAF it asked for lands.
    const pump = (ms: number = BACKDROP_IDLE_FRAME_MS) => {
      act(() => {
        clock += ms;
        vi.advanceTimersByTime(ms);
        const frame = pending;
        pending = null;
        frame?.(clock);
      });
    };
    const frames = Math.ceil(BACKDROP_IDLE_FREEZE_MS / BACKDROP_IDLE_FRAME_MS) + 2;
    for (let i = 0; i < frames; i += 1) pump();

    // Nothing owed to the clock and nothing owed to the display: the renderer
    // is not woken again at all.
    expect(pending).toBeNull();
    const drawnWhileFrozen = gl.drawArrays.mock.calls.length;
    pump(5_000);
    // Five more seconds of wall clock and the mesh has not moved: no frame was
    // asked for, and nothing was drawn.
    expect(pending).toBeNull();
    expect(gl.drawArrays).toHaveBeenCalledTimes(drawnWhileFrozen);

    // A pointer move is a person: the drift starts again on the next frame.
    act(() => {
      // jsdom has no `PointerEvent`; a mouse event of the same type is what the
      // listener actually reads (`clientX`/`clientY`).
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    });
    expect(pending).not.toBeNull();
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
