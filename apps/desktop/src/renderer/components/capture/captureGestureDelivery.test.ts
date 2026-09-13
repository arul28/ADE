/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { CaptureGestureShot } from "../../../shared/types/captureGesture";
import {
  describeShot,
  encodeUtf8Base64,
  isVoiceCallLive,
  planCaptureAttachments,
  resolveCaptureDeliveryTarget,
} from "./captureGestureDelivery";

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

describe("isVoiceCallLive", () => {
  it("is false for a call that has not started or has finished", () => {
    expect(isVoiceCallLive(null)).toBe(false);
    expect(isVoiceCallLive({ phase: "idle", callId: null })).toBe(false);
    // `callId` survives into ended/failed, which is exactly why the phase has
    // to be consulted: keying off the id alone routes captures into a call the
    // user already hung up.
    expect(isVoiceCallLive({ phase: "ended", callId: "call-1" })).toBe(false);
    expect(isVoiceCallLive({ phase: "failed", callId: "call-1" })).toBe(false);
  });

  it("is true for every on-air phase", () => {
    for (const phase of ["connecting", "listening", "thinking", "speaking", "confirming"]) {
      expect(isVoiceCallLive({ phase, callId: "call-1" })).toBe(true);
    }
  });

  it("treats a phase this build has never heard of as live", () => {
    // Failing open here means a capture reaches a call; failing closed would
    // silently file it in a composer nobody is looking at mid-conversation.
    expect(isVoiceCallLive({ phase: "transferring", callId: "call-1" })).toBe(true);
  });

  it("needs a call id, not just a phase", () => {
    expect(isVoiceCallLive({ phase: "listening", callId: null })).toBe(false);
    expect(isVoiceCallLive({ phase: "listening" })).toBe(false);
  });
});

describe("resolveCaptureDeliveryTarget", () => {
  it("routes to the call only when a bridge exists and a call is live", () => {
    expect(resolveCaptureDeliveryTarget({ voiceBridgePresent: true, voiceCallLive: true }))
      .toEqual({ kind: "voice-call" });
    expect(resolveCaptureDeliveryTarget({ voiceBridgePresent: true, voiceCallLive: false }))
      .toEqual({ kind: "composer" });
    // No bridge at all (web client, browser preview): the composer, never a
    // call that cannot exist.
    expect(resolveCaptureDeliveryTarget({ voiceBridgePresent: false, voiceCallLive: true }))
      .toEqual({ kind: "composer" });
  });
});

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

describe("describeShot", () => {
  it("names the app and window when the OS gave them", () => {
    expect(describeShot(shot({ appName: "Safari", windowTitle: "Docs" })))
      .toBe("Screenshot of Safari — Docs");
    expect(describeShot(shot({ appName: "Safari" }))).toBe("Screenshot of Safari");
    expect(describeShot(shot({ windowTitle: "Docs" }))).toBe("Screenshot of Docs");
    expect(describeShot(shot())).toBe("Screenshot of the window in front");
  });

  it("says ADE for ADE, whatever the window title happened to be", () => {
    expect(describeShot(shot({ isAdeWindow: true, appName: "Electron", windowTitle: "x" })))
      .toBe("Screenshot of ADE");
  });
});

describe("encodeUtf8Base64", () => {
  it("survives characters btoa alone would throw on", () => {
    const value = "Lane: cto‑live‑voice — ⌘⌘";
    expect(Buffer.from(encodeUtf8Base64(value), "base64").toString("utf8")).toBe(value);
  });
});
