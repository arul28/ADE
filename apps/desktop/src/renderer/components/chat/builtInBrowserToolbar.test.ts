import { describe, expect, it } from "vitest";
import type { BuiltInBrowserEmulationState } from "../../../shared/types/builtInBrowser";
import {
  BROWSER_TOOLBAR_URL_MIN_WIDTH,
  activeEmulationPresetId,
  browserLetterboxFrame,
  browserTabLabel,
  browserToolbarLayout,
  clampBrowserViewBounds,
  clipboardUrlCandidate,
  deviceMenuPresets,
  devServerChipLabel,
  emulationButtonLabel,
  emulationCaption,
  emulationDisplayLabel,
  emulationSizeLabel,
  estimateDeviceButtonWidth,
  findErrorMessage,
  findMatchLabel,
  formatRecordingElapsed,
  mergeDevServer,
  normalizeDevServer,
  normalizeDevServers,
  normalizeRecordingFps,
  recordingElapsedMs,
  recordingPillLabel,
  shortHostLabel,
  simulatorEmulationPreset,
  splitUrlForDisplay,
  stepZoomFactor,
  urlLockKind,
  zoomPercentLabel,
} from "./builtInBrowserToolbar";

/** A tab's emulation state, with only the fields a caller actually varies. */
function emulationState(
  overrides: Partial<BuiltInBrowserEmulationState>,
): BuiltInBrowserEmulationState {
  return {
    presetId: null,
    label: "",
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: null,
    ...overrides,
  };
}

describe("formatRecordingElapsed", () => {
  it("reads as a stopwatch under an hour", () => {
    expect(formatRecordingElapsed(0)).toBe("0:00");
    expect(formatRecordingElapsed(42_000)).toBe("0:42");
    expect(formatRecordingElapsed(65_400)).toBe("1:05");
    expect(formatRecordingElapsed(12 * 60_000 + 5_000)).toBe("12:05");
  });

  it("grows an hours field rather than counting to 90 minutes", () => {
    expect(formatRecordingElapsed(3_723_000)).toBe("1:02:03");
  });

  it("never runs backwards on a clock skew", () => {
    expect(formatRecordingElapsed(-5_000)).toBe("0:00");
    expect(formatRecordingElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("recordingElapsedMs", () => {
  it("measures from the recording's start", () => {
    const now = Date.parse("2026-09-07T00:01:00.000Z");
    expect(recordingElapsedMs({ startedAt: "2026-09-07T00:00:18.000Z" }, now)).toBe(42_000);
  });

  it("treats an unparseable or missing start as zero rather than NaN", () => {
    expect(recordingElapsedMs({ startedAt: "not a date" }, Date.now())).toBe(0);
    expect(recordingElapsedMs(null)).toBe(0);
  });
});

describe("recordingPillLabel", () => {
  it("pairs the clock with the negotiated frame rate", () => {
    const now = Date.parse("2026-09-07T00:01:00.000Z");
    expect(recordingPillLabel({ startedAt: "2026-09-07T00:00:18.000Z", fps: 60 }, now))
      .toBe("0:42 · 60 fps");
  });

  it("is null when nothing is recording", () => {
    expect(recordingPillLabel(null)).toBeNull();
  });
});

describe("normalizeRecordingFps", () => {
  it("accepts only the two rates the recorder supports", () => {
    expect(normalizeRecordingFps(60)).toBe(60);
    expect(normalizeRecordingFps(30)).toBe(30);
    expect(normalizeRecordingFps(120)).toBe(30);
    expect(normalizeRecordingFps("60")).toBe(30);
  });
});

describe("emulationButtonLabel", () => {
  it("says Desktop when there is no override", () => {
    expect(emulationButtonLabel(null)).toBe("Desktop");
  });

  it("shows the metrics that were actually applied", () => {
    expect(emulationButtonLabel({
      presetId: "responsive",
      label: "900×600",
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
      hasTouch: false,
      userAgent: null,
    })).toBe("900×600");
  });
});

describe("emulationSizeLabel", () => {
  it("formats the preset metrics", () => {
    expect(emulationSizeLabel({ width: 402, height: 874 })).toBe("402 × 874");
  });

  it("is null for the metric-less Desktop preset", () => {
    expect(emulationSizeLabel({ width: 0, height: 0 })).toBeNull();
    expect(emulationSizeLabel(null)).toBeNull();
  });
});

describe("deviceMenuPresets", () => {
  it("leaves Desktop and Responsive to their own rows", () => {
    const ids = deviceMenuPresets().map((preset) => preset.id);
    expect(ids).not.toContain("desktop");
    expect(ids).not.toContain("responsive");
    expect(ids).toContain("iphone-17-pro");
  });
});

describe("simulatorEmulationPreset", () => {
  it("maps a booted device name onto the matching preset", () => {
    expect(simulatorEmulationPreset("iPhone 17 Pro")?.id).toBe("iphone-17-pro");
    expect(simulatorEmulationPreset("iPad")?.id).toBe("ipad");
  });

  it("hides the entry rather than emulating the wrong screen", () => {
    expect(simulatorEmulationPreset("iPhone 16e")).toBeNull();
    expect(simulatorEmulationPreset("")).toBeNull();
    expect(simulatorEmulationPreset(null)).toBeNull();
    // "Desktop"/"Responsive" are not devices a simulator can boot.
    expect(simulatorEmulationPreset("Desktop")).toBeNull();
  });
});

describe("zoom", () => {
  it("labels the factor as a percentage", () => {
    expect(zoomPercentLabel(1)).toBe("100%");
    expect(zoomPercentLabel(1.25)).toBe("125%");
    expect(zoomPercentLabel(null)).toBe("100%");
  });

  it("steps along Chromium's ladder and stops at the ends", () => {
    expect(stepZoomFactor(1, 1)).toBe(1.1);
    expect(stepZoomFactor(1, -1)).toBe(0.9);
    expect(stepZoomFactor(3, 1)).toBe(3);
    expect(stepZoomFactor(0.5, -1)).toBe(0.5);
  });

  it("snaps an off-ladder factor an agent set onto the next rung", () => {
    expect(stepZoomFactor(1.13, 1)).toBe(1.25);
    expect(stepZoomFactor(1.13, -1)).toBe(1.1);
  });
});

describe("urlLockKind", () => {
  it("marks https secure and every other http origin insecure", () => {
    expect(urlLockKind("https://example.test/")).toBe("secure");
    expect(urlLockKind("http://example.test/")).toBe("insecure");
    // Loopback is still plain http; calling it secure teaches the wrong reflex.
    expect(urlLockKind("http://localhost:3000")).toBe("insecure");
    expect(urlLockKind("")).toBe("none");
    expect(urlLockKind(null)).toBe("none");
  });
});

describe("findMatchLabel", () => {
  it("counts the active match against the total", () => {
    expect(findMatchLabel({ activeMatchOrdinal: 3, matches: 12 })).toBe("3 of 12");
  });

  it("says so when there is nothing to find", () => {
    expect(findMatchLabel({ activeMatchOrdinal: 0, matches: 0 })).toBe("No results");
  });

  it("reports a bare count until an ordinal arrives, and nothing before that", () => {
    expect(findMatchLabel({ activeMatchOrdinal: null, matches: 4 })).toBe("4 matches");
    expect(findMatchLabel({ activeMatchOrdinal: null, matches: 1 })).toBe("1 match");
    expect(findMatchLabel({ activeMatchOrdinal: null, matches: null })).toBeNull();
    expect(findMatchLabel(null)).toBeNull();
  });
});

describe("tab labels", () => {
  it("prefers the title, then the host", () => {
    expect(browserTabLabel({ title: "Example" }, "https://example.test/a")).toBe("Example");
    expect(browserTabLabel({ title: null }, "https://www.example.test/a")).toBe("example.test");
    expect(browserTabLabel({ title: "   " }, null)).toBe("New tab");
  });

  it("drops the www prefix from a host", () => {
    expect(shortHostLabel("https://www.google.com/")).toBe("google.com");
    expect(shortHostLabel("not a url")).toBeNull();
  });
});

describe("browserToolbarLayout", () => {
  it("keeps every control and its label in a pane with room", () => {
    const layout = browserToolbarLayout(720);
    expect(layout.density).toBe("full");
    expect(layout).toMatchObject({
      showLabels: true,
      showForward: true,
      showDevice: true,
      showCamera: true,
      showInspect: true,
      openAffordance: "label",
    });
    expect(layout.urlWidth).toBeGreaterThanOrEqual(BROWSER_TOOLBAR_URL_MIN_WIDTH);
  });

  it("never leaves the URL field below its minimum, at any width", () => {
    for (let width = 280; width <= 1_200; width += 1) {
      const layout = browserToolbarLayout(width);
      expect({ width, urlWidth: layout.urlWidth })
        .toEqual({ width, urlWidth: layout.urlWidth });
      expect(layout.urlWidth).toBeGreaterThanOrEqual(BROWSER_TOOLBAR_URL_MIN_WIDTH);
    }
  });

  it("collapses at 420px, where the old thresholds left a zero-width omnibox", () => {
    // The reviewer's measurement of the row at 420: nav 86 + device 90 +
    // camera 28 + inspect 72 + ⋮ 28 + padding and gaps = 336, leaving 84px for
    // an omnibox that also had to hold a padlock and the word "Open".
    const bare = browserToolbarLayout(420, {
      urlMinWidth: 0,
      widths: { urlLock: 0, urlPadding: 0, openIcon: 0, openLabel: 0 },
    });
    expect(bare.urlWidth).toBe(84);
    // Priced honestly — the lock and the ▶ come out of the field, not out of
    // thin air — a full-density row leaves the field 25px, which is nothing.
    expect(browserToolbarLayout(420, { urlMinWidth: 0 }).urlWidth).toBe(25);

    const layout = browserToolbarLayout(420);
    expect(layout.density).toBe("compact");
    expect(layout.showLabels).toBe(false);
    expect(layout.showDevice).toBe(true);
    expect(layout.showCamera).toBe(true);
    expect(layout.showInspect).toBe(false);
    expect(layout.urlWidth).toBe(163);
  });

  it("sheds inspect, then the camera, then the device before it touches forward", () => {
    expect(browserToolbarLayout(470)).toMatchObject({ showInspect: true, showCamera: true, showDevice: true });
    expect(browserToolbarLayout(420)).toMatchObject({ showInspect: false, showCamera: true, showDevice: true });
    expect(browserToolbarLayout(380)).toMatchObject({ showInspect: false, showCamera: false, showDevice: true });
    expect(browserToolbarLayout(360)).toMatchObject({ showForward: true, showDevice: false, showCamera: false });
    expect(browserToolbarLayout(300).showForward).toBe(false);
  });

  it("leaves back, reload, the URL and the overflow menu at its narrowest", () => {
    const layout = browserToolbarLayout(280);
    expect(layout.density).toBe("minimal");
    expect(layout.showForward).toBe(false);
    expect(layout.showDevice).toBe(false);
    expect(layout.showCamera).toBe(false);
    expect(layout.showInspect).toBe(false);
    // Everything has already moved to ⋮, so the last thing left to give is the
    // ▶ — which was only ever a hint that Enter works.
    expect(layout.openAffordance).toBe("none");
    expect(layout.urlWidth).toBeGreaterThanOrEqual(BROWSER_TOOLBAR_URL_MIN_WIDTH);
  });

  it("shrinks the Open affordance to a glyph, then out of the way while typing", () => {
    expect(browserToolbarLayout(560).openAffordance).toBe("label");
    expect(browserToolbarLayout(520).openAffordance).toBe("label");
    expect(browserToolbarLayout(519).openAffordance).toBe("icon");
    expect(browserToolbarLayout(900, { urlFocused: true }).openAffordance).toBe("none");
  });

  it("prices the device button by the label it is about to render", () => {
    expect(estimateDeviceButtonWidth("Desktop")).toBe(90);
    expect(estimateDeviceButtonWidth("iPhone 17 · landscape"))
      .toBeGreaterThan(estimateDeviceButtonWidth("Desktop"));
    // A long device name is the first thing to cost the row its labels.
    const long = browserToolbarLayout(600, { deviceLabel: "iPhone 17 Pro Max · landscape" });
    const short = browserToolbarLayout(600, { deviceLabel: "Desktop" });
    expect(short.showLabels).toBe(true);
    expect(long.showLabels).toBe(false);
  });

  it("only offers Attach when there is a selection and room for it", () => {
    expect(browserToolbarLayout(900, { hasSelection: true }).showAttach).toBe(true);
    expect(browserToolbarLayout(900).showAttach).toBe(false);
    expect(browserToolbarLayout(470, { hasSelection: true }).showAttach).toBe(false);
  });

  it("keeps the recording pill on the row and pays for it elsewhere", () => {
    const recording = browserToolbarLayout(578, { recording: true });
    const idle = browserToolbarLayout(578);
    expect(idle.showLabels).toBe(true);
    expect(recording.showLabels).toBe(false);
    expect(recording.urlWidth).toBeGreaterThanOrEqual(BROWSER_TOOLBAR_URL_MIN_WIDTH);
  });

  it("assumes room when the row has not been measured yet", () => {
    expect(browserToolbarLayout(null).density).toBe("full");
    expect(browserToolbarLayout(0).density).toBe("full");
    expect(browserToolbarLayout(null).openAffordance).toBe("label");
  });
});

describe("browserLetterboxFrame", () => {
  it("fills the stage inside the hairline when nothing is emulated", () => {
    expect(browserLetterboxFrame({ width: 600, height: 400 }, null)).toEqual({
      left: 1,
      top: 1,
      width: 598,
      height: 398,
      scale: 1,
    });
  });

  it("centres the exact CSS size of the emulated device", () => {
    expect(browserLetterboxFrame({ width: 800, height: 1000 }, { width: 393, height: 852 })).toEqual({
      left: 1 + Math.floor((798 - 393) / 2),
      top: 1 + Math.floor((998 - 852) / 2),
      width: 393,
      height: 852,
      scale: 1,
    });
  });

  it("scales a device that does not fit instead of cropping one edge of it", () => {
    const frame = browserLetterboxFrame({ width: 300, height: 400 }, { width: 393, height: 852 });
    // 398/852 is the binding constraint, so both axes shrink by it and the
    // whole phone stays on screen rather than losing its right-hand side.
    expect(frame.scale).toBeCloseTo(398 / 852, 5);
    expect(frame.width).toBe(Math.round(393 * (398 / 852)));
    expect(frame.height).toBe(398);
    expect(frame.width).toBeLessThanOrEqual(298);
    expect(frame.left).toBeGreaterThan(1);
  });

  it("keeps a landscape phone inside a narrow pane", () => {
    const frame = browserLetterboxFrame({ width: 578, height: 700 }, { width: 852, height: 393 });
    expect(frame.width).toBeLessThanOrEqual(576);
    expect(frame.height / frame.width).toBeCloseTo(393 / 852, 2);
    expect(frame.scale).toBeLessThan(1);
  });

  it("treats a zero-sized emulation as no emulation", () => {
    expect(browserLetterboxFrame({ width: 500, height: 300 }, { width: 0, height: 0 })).toEqual({
      left: 1,
      top: 1,
      width: 498,
      height: 298,
      scale: 1,
    });
  });
});

describe("clampBrowserViewBounds", () => {
  it("trims a stale measurement back into the pane", () => {
    expect(clampBrowserViewBounds(
      { x: 1_160, y: 60, width: 640, height: 800 },
      { left: 1_160, top: 60, right: 1_460, bottom: 860 },
    )).toEqual({ x: 1_160, y: 60, width: 300, height: 800 });
  });

  it("collapses to nothing rather than reporting a negative size", () => {
    // A frame entirely outside the box reads as zero-width, which is what the
    // panel treats as "not visible" — never as a negative rectangle.
    expect(clampBrowserViewBounds(
      { x: 900, y: 10, width: 200, height: 200 },
      { left: 0, top: 0, right: 400, bottom: 400 },
    )).toEqual({ x: 900, y: 10, width: 0, height: 200 });
  });
});

describe("emulationCaption", () => {
  it("reads as the device's CSS size", () => {
    expect(emulationCaption({ width: 393, height: 852 })).toBe("393 × 852");
    expect(emulationCaption(null)).toBeNull();
    expect(emulationCaption({ width: 0, height: 0 })).toBeNull();
  });

  it("admits when the pane was too small to show the device at 1:1", () => {
    expect(emulationCaption({ width: 393, height: 852 }, 0.82)).toBe("393 × 852 · fit 82%");
    // A rounding-error scale is not a fit, and saying "fit 100%" would read as
    // a warning about nothing.
    expect(emulationCaption({ width: 393, height: 852 }, 0.999)).toBe("393 × 852");
    expect(emulationCaption({ width: 393, height: 852 }, 1)).toBe("393 × 852");
  });
});

describe("activeEmulationPresetId", () => {
  it("is the preset the service named", () => {
    expect(activeEmulationPresetId(emulationState({ presetId: "iphone-17", width: 393, height: 852 })))
      .toBe("iphone-17");
  });

  it("is desktop when nothing is emulated", () => {
    expect(activeEmulationPresetId(null)).toBe("desktop");
  });

  it("still names the device after a rotation the service calls responsive", () => {
    expect(activeEmulationPresetId(emulationState({
      presetId: "responsive",
      label: "852×393",
      width: 852,
      height: 393,
    }))).toBe("iphone-17");
  });

  it("falls back to responsive for a size no device has", () => {
    expect(activeEmulationPresetId(emulationState({
      presetId: "responsive",
      label: "1024×768",
      width: 1_024,
      height: 768,
    }))).toBe("responsive");
  });
});

describe("emulationDisplayLabel", () => {
  it("names the device rather than its rotated metrics", () => {
    expect(emulationDisplayLabel(emulationState({
      presetId: "responsive",
      label: "852×393",
      width: 852,
      height: 393,
    }))).toBe("iPhone 17 · landscape");
  });

  it("leaves an upright preset alone", () => {
    expect(emulationDisplayLabel(emulationState({ presetId: "iphone-17", width: 393, height: 852 })))
      .toBe("iPhone 17");
    expect(emulationDisplayLabel(null)).toBe("Desktop");
  });

  it("keeps a genuinely custom size as its own label", () => {
    expect(emulationDisplayLabel(emulationState({
      presetId: "responsive",
      label: "1440×900",
      width: 1_440,
      height: 900,
    }))).toBe("1440×900");
  });
});

describe("findErrorMessage", () => {
  it("never surfaces the service's own words", () => {
    expect(findErrorMessage(new Error(
      "Error invoking remote method 'built-in-browser:find-in-page': TypeError: x is not a function",
    ))).toBe("Find is not available on this page.");
  });

  it("says what to do when there is no page to search", () => {
    expect(findErrorMessage(new Error("No active tab for this collection")))
      .toBe("Open a page before searching it.");
  });

  it("has an answer for anything at all", () => {
    expect(findErrorMessage(undefined)).toBe("Find is not available on this page.");
    expect(findErrorMessage("boom")).toBe("Find is not available on this page.");
  });
});

describe("dev servers", () => {
  it("reads a full record, a bare port and a bare host alike", () => {
    expect(normalizeDevServer({ url: "http://localhost:5173", command: "npm run dev" }))
      .toEqual({ url: "http://localhost:5173", port: 5_173, source: "npm run dev" });
    expect(normalizeDevServer(3_000)).toEqual({
      url: "http://localhost:3000",
      port: 3_000,
      source: null,
    });
    expect(normalizeDevServer("localhost:8080")).toEqual({
      url: "http://localhost:8080",
      port: 8_080,
      source: null,
    });
    expect(normalizeDevServer({})).toBeNull();
  });

  it("de-duplicates a list and survives a shape it has never seen", () => {
    expect(normalizeDevServers([
      { port: 5_173 },
      { url: "http://localhost:5173" },
      null,
    ])).toEqual([{ url: "http://localhost:5173", port: 5_173, source: null }]);
    expect(normalizeDevServers(undefined)).toEqual([]);
  });

  it("adds a newly detected server and enriches one it already knew", () => {
    const known = [{ url: "http://localhost:5173", port: 5_173, source: null }];
    expect(mergeDevServer(known, { url: "http://localhost:3000", port: 3_000, source: null }))
      .toHaveLength(2);
    expect(mergeDevServer(known, { url: "http://localhost:5173", port: 5_173, source: "npm run dev" }))
      .toEqual([{ url: "http://localhost:5173", port: 5_173, source: "npm run dev" }]);
  });

  it("names the command when it knows it, and the port when it does not", () => {
    expect(devServerChipLabel({ url: "http://localhost:5173", port: 5_173, source: "npm run dev" }))
      .toBe("npm run dev · :5173");
    expect(devServerChipLabel({ url: "http://localhost:5173", port: 5_173, source: null }))
      .toBe("localhost:5173");
  });
});

describe("splitUrlForDisplay", () => {
  it("emphasises the host and dims the rest", () => {
    expect(splitUrlForDisplay("https://www.example.com/docs/page?q=1#top"))
      .toEqual({ host: "example.com", rest: "/docs/page?q=1#top" });
    expect(splitUrlForDisplay("https://example.com/")).toEqual({ host: "example.com", rest: "" });
  });

  it("declines anything that is not an http(s) address", () => {
    expect(splitUrlForDisplay("about:blank")).toBeNull();
    expect(splitUrlForDisplay("")).toBeNull();
    expect(splitUrlForDisplay("not a url")).toBeNull();
  });
});

describe("clipboardUrlCandidate", () => {
  it("offers a link the clipboard actually holds", () => {
    expect(clipboardUrlCandidate("https://example.com/x")).toBe("https://example.com/x");
    expect(clipboardUrlCandidate(" localhost:5173 ")).toBe("http://localhost:5173");
    expect(clipboardUrlCandidate("example.com")).toBe("https://example.com");
  });

  it("stays quiet when the clipboard holds prose", () => {
    expect(clipboardUrlCandidate("fix the login page")).toBeNull();
    expect(clipboardUrlCandidate("")).toBeNull();
    expect(clipboardUrlCandidate(null)).toBeNull();
  });
});
