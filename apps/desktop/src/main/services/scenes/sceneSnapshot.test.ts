import { describe, expect, it } from "vitest";

import { clampSceneCaptureRect, decodeScenePngDataUrl } from "./sceneSnapshot";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("clampSceneCaptureRect", () => {
  const content = { width: 1200, height: 800 };

  it("keeps a rect that already fits", () => {
    expect(clampSceneCaptureRect({ x: 10, y: 20, width: 300, height: 200 }, content))
      .toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });

  it("clamps an overhanging or negative rect into the content box", () => {
    expect(clampSceneCaptureRect({ x: -40, y: -10, width: 5000, height: 5000 }, content))
      .toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(clampSceneCaptureRect({ x: 1100, y: 700, width: 400, height: 400 }, content))
      .toEqual({ x: 1100, y: 700, width: 100, height: 100 });
  });

  /**
   * The regression this exists for: shifting a negative origin while keeping
   * the size captured a rect the same size as the scene, in a place the scene
   * was not — a scrolled-off scene froze as a picture of the top of the window.
   */
  it("intersects a scrolled-off rect instead of sliding it into view", () => {
    expect(clampSceneCaptureRect({ x: 0, y: -300, width: 400, height: 400 }, content))
      .toEqual({ x: 0, y: 0, width: 400, height: 100 });
    expect(clampSceneCaptureRect({ x: -50, y: 10, width: 200, height: 50 }, content))
      .toEqual({ x: 0, y: 10, width: 150, height: 50 });
  });

  it("returns null for a rect entirely off the content box", () => {
    expect(clampSceneCaptureRect({ x: 0, y: -300, width: 400, height: 200 }, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 1300, y: 0, width: 400, height: 200 }, content)).toBeNull();
  });

  it("returns null when nothing capturable is left", () => {
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: 0, height: 10 }, content)).toBeNull();
    expect(clampSceneCaptureRect(null, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("decodeScenePngDataUrl", () => {
  it("decodes a PNG data URL", () => {
    const dataUrl = `data:image/png;base64,${PNG_HEADER.toString("base64")}`;
    expect(decodeScenePngDataUrl(dataUrl)?.equals(PNG_HEADER)).toBe(true);
  });

  it("rejects a non-PNG, a foreign mime type, and an empty payload", () => {
    expect(decodeScenePngDataUrl(`data:image/png;base64,${Buffer.from("not a png").toString("base64")}`)).toBeNull();
    expect(decodeScenePngDataUrl(`data:image/jpeg;base64,${PNG_HEADER.toString("base64")}`)).toBeNull();
    expect(decodeScenePngDataUrl("data:image/png;base64,")).toBeNull();
    expect(decodeScenePngDataUrl(null)).toBeNull();
    expect(decodeScenePngDataUrl(undefined)).toBeNull();
  });
});
