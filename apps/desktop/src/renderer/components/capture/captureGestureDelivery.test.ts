/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { encodeUtf8Base64 } from "../../lib/base64";
import type { CaptureGestureShot } from "../../../shared/types/captureGesture";
import { planCaptureAttachments } from "./captureGestureDelivery";

function shot(overrides: Partial<CaptureGestureShot> = {}): CaptureGestureShot {
  return {
    pngBase64: "UE5H",
    filename: "ade-capture-20260913-090503.png",
    capturedAt: "2026-09-13T09:05:03.000Z",
    source: "chord",
    appName: null,
    windowTitle: null,
    bounds: null,
    isAdeWindow: false,
    ...overrides,
  };
}

describe("planCaptureAttachments", () => {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");

  it("attaches the structured note only for ADE's own window", () => {
    const withContext = planCaptureAttachments(shot({ isAdeWindow: true }), "# ctx", encode);
    expect(withContext.context).toEqual({
      data: encode("# ctx"),
      filename: "ade-capture-20260913-090503-context.md",
    });

    const foreign = planCaptureAttachments(shot({ isAdeWindow: false }), "# ctx", encode);
    expect(foreign.context).toBeNull();
  });

  it("omits the note when there was nothing to say about the view", () => {
    expect(planCaptureAttachments(shot({ isAdeWindow: true }), null, encode).context).toBeNull();
  });

  it("passes the image through as raw base64, never a data URL", () => {
    const plan = planCaptureAttachments(shot(), null, encode);
    expect(plan.image.data).toBe("UE5H");
    expect(plan.image.data.startsWith("data:")).toBe(false);
  });
});

describe("encodeUtf8Base64", () => {
  it("survives characters btoa alone would throw on", () => {
    const value = "Lane: cto‑live‑voice — ⌘⌘";
    expect(Buffer.from(encodeUtf8Base64(value), "base64").toString("utf8")).toBe(value);
  });
});
