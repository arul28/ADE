import { describe, expect, it } from "vitest";
import {
  BROWSER_TOOLBAR_URL_MIN_WIDTH,
  browserToolbarLayout,
  estimateDeviceButtonWidth,
} from "./builtInBrowserToolbar";

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
