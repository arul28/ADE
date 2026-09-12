import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IosScreenSnapshot, IosSimulatorWindowSource } from "../../../shared/types";
import {
  buildDesktopCaptureConstraints,
  calibrateWindowScreenRect,
  heuristicWindowScreenRect,
  pickSimulatorWindowSource,
} from "./iosSimWindowGeometry";

function source(name: string, id = name): IosSimulatorWindowSource {
  return { id, name, thumbnailDataUrl: null };
}

describe("pickSimulatorWindowSource", () => {
  it("returns null when the host listed nothing", () => {
    expect(pickSimulatorWindowSource([], { name: "iPhone 15" })).toBeNull();
  });

  it("prefers the window naming the device over a bare Simulator window", () => {
    const named = source("iPhone 15 Pro — iOS 18.0");
    const bare = source("Simulator");
    expect(pickSimulatorWindowSource([bare, named], { name: "iPhone 15 Pro" })).toBe(named);
  });

  it("drops ADE's own windows and the inspector before ranking", () => {
    const ade = source("ADE — iPhone 15 Pro");
    const devtools = source("Developer Tools — iPhone 15 Pro");
    const real = source("iPhone 15 Pro");
    expect(pickSimulatorWindowSource([ade, devtools, real], { name: "iPhone 15 Pro" })).toBe(real);
  });

  it("returns null when a named device matches no window", () => {
    const other = source("Xcode");
    const safari = source("Safari — Apple");
    expect(pickSimulatorWindowSource([other, safari], { name: "iPhone 15 Pro" })).toBeNull();
  });

  it("keeps a Simulator window even when it does not name the device", () => {
    const bare = source("Simulator");
    expect(pickSimulatorWindowSource([source("Xcode"), bare], { name: "iPad Pro 13-inch" })).toBe(bare);
  });

  it("requires a Simulator-strength score when no device is known", () => {
    // "iPhone 15" alone scores 30, below the 50 the deviceless filter demands.
    expect(pickSimulatorWindowSource([source("iPhone 15")], null)).toBeNull();
    const bare = source("Simulator");
    expect(pickSimulatorWindowSource([source("iPhone 15"), bare], null)).toBe(bare);
  });

  it("penalises Apple TV and Watch windows against an iPhone one", () => {
    const tv = source("Simulator — Apple TV 4K");
    const phone = source("Simulator — iPhone 15");
    expect(pickSimulatorWindowSource([tv, phone], null)).toBe(phone);
  });

  it("breaks an exact score tie by name", () => {
    const second = source("Simulator B");
    const first = source("Simulator A");
    expect(pickSimulatorWindowSource([second, first], null)).toBe(first);
  });
});

describe("buildDesktopCaptureConstraints", () => {
  it("asks Chromium for one desktop source with no audio and no cursor", () => {
    const constraints = buildDesktopCaptureConstraints("window:42:0", 60) as unknown as {
      audio: boolean;
      video: {
        mandatory: Record<string, unknown>;
        optional: Array<Record<string, unknown>>;
      };
    };
    expect(constraints.audio).toBe(false);
    expect(constraints.video.mandatory).toEqual({
      chromeMediaSource: "desktop",
      chromeMediaSourceId: "window:42:0",
      minFrameRate: 30,
      maxFrameRate: 60,
    });
    expect(constraints.video.optional).toEqual([{ cursor: "never" }]);
  });

  it("never asks for a floor above the ceiling it was given", () => {
    const constraints = buildDesktopCaptureConstraints("window:7:0", 15) as unknown as {
      video: { mandatory: { minFrameRate: number; maxFrameRate: number } };
    };
    expect(constraints.video.mandatory.minFrameRate).toBe(15);
    expect(constraints.video.mandatory.maxFrameRate).toBe(15);
  });
});

describe("heuristicWindowScreenRect", () => {
  it("refuses a window or a screen it cannot measure", () => {
    expect(heuristicWindowScreenRect(0, 900, 1170, 2532)).toBeNull();
    expect(heuristicWindowScreenRect(400, 0, 1170, 2532)).toBeNull();
    expect(heuristicWindowScreenRect(400, 900, null, 2532)).toBeNull();
    expect(heuristicWindowScreenRect(400, 900, 1170, undefined)).toBeNull();
    expect(heuristicWindowScreenRect(400, 900, 0, 2532)).toBeNull();
  });

  it("insets a tall phone window by its bezel, biased toward the title bar", () => {
    // 400x900 window, 1170x2532 screen: height is the loose constraint, so the
    // 0.91 width limit wins and the residual is split 82% above the screen.
    const rect = heuristicWindowScreenRect(400, 900, 1170, 2532);
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeCloseTo(364, 6);
    expect(rect!.height).toBeCloseTo(364 * (2532 / 1170), 6);
    expect(rect!.x).toBeCloseTo(18, 6);
    expect(rect!.y).toBeCloseTo((900 - (364 * (2532 / 1170))) * 0.82, 6);
    expect(rect!.confidence).toBe(0.45);
    expect(rect!.source).toBe("heuristic");
  });

  it("lets height bind instead when the window is wide for the screen", () => {
    // 1200x900 window, same 1170x2532 screen: 0.91*1200 is far wider than the
    // screen can be at this height, so the 0.9 height limit is what applies.
    const rect = heuristicWindowScreenRect(1200, 900, 1170, 2532);
    expect(rect).not.toBeNull();
    expect(rect!.height).toBeCloseTo(810, 6);
    expect(rect!.width).toBeCloseTo(810 * (1170 / 2532), 6);
    expect(rect!.y).toBeCloseTo((900 - 810) * 0.82, 6);
    expect(rect!.x).toBeCloseTo((1200 - (810 * (1170 / 2532))) / 2, 6);
  });

  it("always puts 82% of the leftover height above the screen", () => {
    // Whichever limit binds, the screen ends up at most 0.9x the window height,
    // so the leftover is always >= 10% and 82% of it always clears the 6.5%
    // floor. Neither that floor nor the residual clamp above it can therefore
    // change an answer today; this pins the inset that actually ships.
    const cases: Array<[number, number, number, number]> = [
      [400, 900, 1170, 2532],
      [1200, 900, 1170, 2532],
      [320, 1400, 1290, 2796],
      [900, 700, 2048, 2732],
      [1000, 500, 2752, 2064],
    ];
    for (const [videoWidth, videoHeight, screenWidth, screenHeight] of cases) {
      const rect = heuristicWindowScreenRect(videoWidth, videoHeight, screenWidth, screenHeight);
      expect(rect).not.toBeNull();
      expect(rect!.y).toBeCloseTo((videoHeight - rect!.height) * 0.82, 6);
      expect(rect!.x).toBeCloseTo((videoWidth - rect!.width) / 2, 6);
    }
  });
});

/**
 * A stand-in for the image/canvas surface the calibration samples.
 *
 * `calibrateWindowScreenRect` is the one piece here that is not pure: it loads
 * the snapshot through `new Image()` and rasterises both the snapshot and the
 * live frame through 2D canvases. The suite runs in the `node` environment, so
 * rather than dragging in a real canvas the stubs below model the only
 * behaviour the algorithm depends on — `drawImage` maps a source rectangle onto
 * a destination rectangle, and `getImageData` reads it back. Every stub surface
 * is a grey field: one `sample(px, py)` function over its own pixel space,
 * written back as r=g=b so the luminance weights (which sum to 1) return it
 * unchanged. No antialiasing is modelled, which is exactly why the expected
 * scores below are exact.
 */
type Sampler = (px: number, py: number) => number;

type StubDrawable = {
  sampleWidthPx: number;
  sampleHeightPx: number;
  sample: Sampler;
};

class StubCanvas {
  width = 0;
  height = 0;
  content: Sampler = () => 0;
  contextFactory: (canvas: StubCanvas) => unknown;

  constructor(contextFactory: (canvas: StubCanvas) => unknown) {
    this.contextFactory = contextFactory;
  }

  getContext(_type: string, _options?: unknown): unknown {
    return this.contextFactory(this);
  }

  get sampleWidthPx(): number {
    return this.width;
  }

  get sampleHeightPx(): number {
    return this.height;
  }

  get sample(): Sampler {
    return (px, py) => this.content(px, py);
  }
}

function drawableOf(source: unknown): StubDrawable {
  const candidate = source as Partial<StubDrawable> & {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  const width = candidate.sampleWidthPx ?? candidate.naturalWidth ?? candidate.videoWidth ?? 0;
  const height = candidate.sampleHeightPx ?? candidate.naturalHeight ?? candidate.videoHeight ?? 0;
  return { sampleWidthPx: width, sampleHeightPx: height, sample: candidate.sample! };
}

function makeContext(canvas: StubCanvas) {
  return {
    clearRect(): void {
      canvas.content = () => 0;
    },
    drawImage(source: unknown, ...args: number[]): void {
      const drawable = drawableOf(source);
      let sx = 0;
      let sy = 0;
      let sw = drawable.sampleWidthPx;
      let sh = drawable.sampleHeightPx;
      let dx: number;
      let dy: number;
      let dw: number;
      let dh: number;
      if (args.length === 8) {
        [sx, sy, sw, sh, dx, dy, dw, dh] = args;
      } else if (args.length === 4) {
        [dx, dy, dw, dh] = args;
      } else {
        throw new Error(`Unexpected drawImage arity: ${args.length + 1}`);
      }
      const previous = canvas.content;
      // A 1:1 blit lands on source pixel centres exactly; anything scaled maps
      // the destination pixel centre into source space, as a box filter would.
      const oneToOne = dw === sw && dh === sh;
      canvas.content = (px, py) => {
        if (px < dx || px >= dx + dw || py < dy || py >= dy + dh) return previous(px, py);
        if (oneToOne) return drawable.sample(sx + (px - dx), sy + (py - dy));
        const u = (px - dx + 0.5) / dw;
        const v = (py - dy + 0.5) / dh;
        return drawable.sample(sx + (u * sw), sy + (v * sh));
      };
    },
    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const value = canvas.content(x + column, y + row);
          const index = ((row * width) + column) * 4;
          data[index] = value;
          data[index + 1] = value;
          data[index + 2] = value;
          data[index + 3] = 255;
        }
      }
      return { data };
    },
  };
}

const SCREEN_WIDTH = 1170;
const SCREEN_HEIGHT = 2532;

/** The snapshot's own pixels: a diagonal ramp across the full device screen. */
function screenRamp(px: number, py: number): number {
  const u = px / SCREEN_WIDTH;
  const v = py / SCREEN_HEIGHT;
  return Math.max(0, Math.min(255, 255 * ((0.5 * u) + (0.5 * v))));
}

function makeSnapshot(dataUrl: string | null): IosScreenSnapshot {
  return {
    deviceUdid: "UDID-1",
    capturedAt: "2026-09-12T00:00:00.000Z",
    screenshot: {
      deviceUdid: "UDID-1",
      dataUrl: dataUrl ?? "",
      filePath: "/tmp/shot.png",
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      capturedAt: "2026-09-12T00:00:00.000Z",
    },
    screen: { width: 390, height: 844, scale: 3 },
    elements: [],
    hitElement: null,
    providers: [],
    inspectorSnapshot: null,
  };
}

function makeVideo(options: {
  width?: number;
  height?: number;
  readyState?: number;
  sample?: Sampler;
}): HTMLVideoElement {
  return {
    videoWidth: options.width ?? 400,
    videoHeight: options.height ?? 900,
    readyState: options.readyState ?? 2,
    HAVE_CURRENT_DATA: 2,
    sample: options.sample ?? (() => 0),
  } as unknown as HTMLVideoElement;
}

type ImageStubOptions = {
  fail?: boolean;
  sample?: Sampler;
};

let imageStubOptions: ImageStubOptions = {};
let contextFactory: (canvas: StubCanvas) => unknown = (canvas) => makeContext(canvas);

const globals = globalThis as unknown as Record<string, unknown>;
let hadDocument = false;
let hadImage = false;
let previousDocument: unknown;
let previousImage: unknown;

beforeEach(() => {
  imageStubOptions = {};
  contextFactory = (canvas) => makeContext(canvas);

  hadDocument = "document" in globals;
  hadImage = "Image" in globals;
  previousDocument = globals.document;
  previousImage = globals.Image;

  globals.document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`Unexpected createElement(${tag})`);
      return new StubCanvas((canvas) => contextFactory(canvas));
    },
  };

  globals.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = SCREEN_WIDTH;
    naturalHeight = SCREEN_HEIGHT;
    sample: Sampler = (px, py) => (imageStubOptions.sample ?? screenRamp)(px, py);
    #src = "";

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      queueMicrotask(() => {
        if (imageStubOptions.fail) this.onerror?.();
        else this.onload?.();
      });
    }
  };
});

afterEach(() => {
  if (hadDocument) globals.document = previousDocument;
  else delete globals.document;
  if (hadImage) globals.Image = previousImage;
  else delete globals.Image;
});

describe("calibrateWindowScreenRect", () => {
  const heuristic = heuristicWindowScreenRect(400, 900, SCREEN_WIDTH, SCREEN_HEIGHT)!;

  /** The live frame: the snapshot's ramp, offset by `delta`, inside `rect`. */
  function windowSampler(
    rect: { x: number; y: number; width: number; height: number },
    delta = 0,
    bezel = 250,
  ): Sampler {
    return (px, py) => {
      if (px < rect.x || px >= rect.x + rect.width || py < rect.y || py >= rect.y + rect.height) {
        return bezel;
      }
      const u = (px - rect.x) / rect.width;
      const v = (py - rect.y) / rect.height;
      return Math.max(0, Math.min(255, screenRamp(u * SCREEN_WIDTH, v * SCREEN_HEIGHT) + delta));
    };
  }

  it("returns null when the window cannot be measured at all", async () => {
    const rect = await calibrateWindowScreenRect(
      makeVideo({ width: 0 }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).toBeNull();
  });

  it("falls back to the heuristic when there is no snapshot image to match", async () => {
    const rect = await calibrateWindowScreenRect(makeVideo({}), makeSnapshot(null));
    expect(rect).toEqual(heuristic);
  });

  it("falls back to the heuristic when the video has no decoded frame yet", async () => {
    const rect = await calibrateWindowScreenRect(
      makeVideo({ readyState: 1 }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).toEqual(heuristic);
  });

  it("falls back to the heuristic when a 2D context is refused", async () => {
    contextFactory = () => null;
    const rect = await calibrateWindowScreenRect(
      makeVideo({ sample: windowSampler(heuristic) }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).toEqual(heuristic);
  });

  it("falls back to the heuristic when the snapshot image will not load", async () => {
    imageStubOptions = { fail: true };
    const rect = await calibrateWindowScreenRect(
      makeVideo({ sample: windowSampler(heuristic) }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).toEqual(heuristic);
  });

  it("locks onto a screen that sits exactly where the heuristic guessed", async () => {
    const rect = await calibrateWindowScreenRect(
      makeVideo({ sample: windowSampler(heuristic) }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).not.toBeNull();
    expect(rect!.source).toBe("matched");
    // A perfect overlay scores 0, and only the identity candidate can: every
    // other offset in the table drags bezel or a rescaled ramp into the sample.
    expect(rect!.confidence).toBe(1);
    expect(rect!.x).toBeCloseTo(heuristic.x, 6);
    expect(rect!.y).toBeCloseTo(heuristic.y, 6);
    expect(rect!.width).toBeCloseTo(heuristic.width, 6);
    expect(rect!.height).toBeCloseTo(heuristic.height, 6);
  });

  it("accepts a match whose confidence clears the cutoff", async () => {
    // A flat field 100 grey levels off the snapshot scores 100 for every
    // candidate, i.e. confidence 1 - 100/255 = 0.608, just above the 0.55 bar.
    imageStubOptions = { sample: () => 40 };
    const rect = await calibrateWindowScreenRect(
      makeVideo({ sample: () => 140 }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).not.toBeNull();
    expect(rect!.source).toBe("matched");
    expect(rect!.confidence).toBeCloseTo(1 - (100 / 255), 6);
  });

  it("rejects a match whose confidence falls under the cutoff", async () => {
    // The same field 120 levels off scores 120: confidence 0.529, under the bar,
    // so the calibration is thrown away and the heuristic stands.
    imageStubOptions = { sample: () => 40 };
    const rect = await calibrateWindowScreenRect(
      makeVideo({ sample: () => 160 }),
      makeSnapshot("data:image/png;base64,AAAA"),
    );
    expect(rect).toEqual(heuristic);
    expect(rect!.source).toBe("heuristic");
    expect(rect!.confidence).toBe(0.45);
  });
});
