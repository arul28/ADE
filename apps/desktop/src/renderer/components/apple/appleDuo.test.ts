import { describe, expect, it } from "vitest";

import {
  APPLE_DUO_MAX_ANGLE,
  APPLE_DUO_MIN_ANGLE,
  APPLE_DUO_NUDGE_DEGREES,
  APPLE_DUO_PANEL_V_RANGES,
  APPLE_DUO_STANCES,
  appleDeviceSupportsDuo,
  appleDuoHingeAfterPinch,
  appleDuoPanelForInnerPoint,
  appleDuoPanelRotationsDeg,
  appleDuoPoseForAngle,
  appleDuoPoseForStance,
  clampAppleDuoAngle,
  createAppleDuoState,
  nearestAppleDuoStance,
  reduceAppleDuoState,
} from "./appleDuo";

describe("clampAppleDuoAngle", () => {
  it("holds the hinge inside 0..180 and treats a non-number as flat", () => {
    expect(clampAppleDuoAngle(-40)).toBe(APPLE_DUO_MIN_ANGLE);
    expect(clampAppleDuoAngle(400)).toBe(APPLE_DUO_MAX_ANGLE);
    expect(clampAppleDuoAngle(105)).toBe(105);
    expect(clampAppleDuoAngle(Number.NaN)).toBe(APPLE_DUO_MAX_ANGLE);
  });
});

describe("appleDuoPanelRotationsDeg", () => {
  it("lies flat at 180°", () => {
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForAngle(180))).toEqual({ upper: 0, lower: 0 });
  });

  it("folds both halves to meet at 0°", () => {
    // Positive upper and negative lower both bring the faces toward the viewer,
    // so at 90° each they meet and the device is shut.
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForAngle(0))).toEqual({ upper: 90, lower: -90 });
  });

  it("folds symmetrically for a tent", () => {
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForStance("tent"))).toEqual({ upper: 55, lower: -55 });
  });

  it("leaves the lower half flat for a laptop", () => {
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForStance("laptop"))).toEqual({ upper: 75, lower: 0 });
  });

  it("treats the laptop base as flat only when the pose says so", () => {
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForAngle(105, true))).toEqual({ upper: 75, lower: 0 });
    expect(appleDuoPanelRotationsDeg(appleDuoPoseForAngle(105, false))).toEqual({ upper: 37.5, lower: -37.5 });
  });
});

describe("appleDuoPanelForInnerPoint", () => {
  it("splits the continuous canvas at the middle", () => {
    expect(appleDuoPanelForInnerPoint(1)).toBe("upper");
    expect(appleDuoPanelForInnerPoint(0.5)).toBe("upper");
    expect(appleDuoPanelForInnerPoint(0.49)).toBe("lower");
    expect(appleDuoPanelForInnerPoint(0)).toBe("lower");
    expect(APPLE_DUO_PANEL_V_RANGES.upper).toEqual({ min: 0.5, max: 1 });
    expect(APPLE_DUO_PANEL_V_RANGES.lower).toEqual({ min: 0, max: 0.5 });
  });
});

describe("nearestAppleDuoStance", () => {
  it.each([
    [180, "open"],
    [170, "open"],
    [105, "laptop"],
    [95, "laptop"],
    [70, "tent"],
    [20, "closed"],
    [0, "closed"],
  ] as const)("maps %d° to %s", (angle, stance) => {
    expect(nearestAppleDuoStance(angle)).toBe(stance);
  });
});

describe("appleDuoHingeAfterPinch", () => {
  it("opens the hinge when the pinch spreads and closes it when it pinches in", () => {
    expect(appleDuoHingeAfterPinch({ angle: 90, fromScale: 1, toScale: 1.5 })).toBe(150);
    expect(appleDuoHingeAfterPinch({ angle: 90, fromScale: 1, toScale: 0.5 })).toBe(30);
  });

  it("clamps at both ends and ignores a degenerate scale", () => {
    expect(appleDuoHingeAfterPinch({ angle: 170, fromScale: 1, toScale: 2 })).toBe(180);
    expect(appleDuoHingeAfterPinch({ angle: 10, fromScale: 1, toScale: 0.1 })).toBe(0);
    expect(appleDuoHingeAfterPinch({ angle: 90, fromScale: 0, toScale: 2 })).toBe(90);
  });
});

describe("appleDeviceSupportsDuo", () => {
  it("recognises a Duo from the CoreSimulator type identifier or the name", () => {
    expect(appleDeviceSupportsDuo({
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    })).toBe(true);
    expect(appleDeviceSupportsDuo({ deviceTypeName: "iPhone Duo" })).toBe(true);
  });

  it("does not claim a normal iPhone or iPad folds", () => {
    for (const identifier of [
      "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
    ]) {
      expect(appleDeviceSupportsDuo({ deviceTypeIdentifier: identifier })).toBe(false);
    }
    expect(appleDeviceSupportsDuo({ deviceTypeName: "iPhone 17 Pro" })).toBe(false);
    expect(appleDeviceSupportsDuo({})).toBe(false);
    expect(appleDeviceSupportsDuo({ deviceTypeIdentifier: null, deviceTypeName: null })).toBe(false);
  });

  it("accepts a name that merely contains the word without a false positive on 'Duos'", () => {
    expect(appleDeviceSupportsDuo({ deviceTypeName: "Duos test rig" })).toBe(false);
  });
});

describe("reduceAppleDuoState", () => {
  it("starts flat open", () => {
    expect(createAppleDuoState().pose).toEqual({ angle: 180, lowerFlat: false });
  });

  it("jumps to a stance, including its flat base", () => {
    const next = reduceAppleDuoState(createAppleDuoState(), { type: "stance", stance: "laptop" });
    expect(next.pose).toEqual({ angle: 105, lowerFlat: true });
  });

  it("clears the flat base when a custom angle is set", () => {
    const laptop = reduceAppleDuoState(createAppleDuoState(), { type: "stance", stance: "laptop" });
    const custom = reduceAppleDuoState(laptop, { type: "angle", angle: 90 });
    expect(custom.pose).toEqual({ angle: 90, lowerFlat: false });
  });

  it("nudges the angle and keeps the flat base", () => {
    const laptop = reduceAppleDuoState(createAppleDuoState(), { type: "stance", stance: "laptop" });
    const opened = reduceAppleDuoState(laptop, { type: "nudge", delta: APPLE_DUO_NUDGE_DEGREES });
    expect(opened.pose).toEqual({ angle: 120, lowerFlat: true });
    const clamped = reduceAppleDuoState(opened, { type: "nudge", delta: 200 });
    expect(clamped.pose).toEqual({ angle: 180, lowerFlat: true });
  });

  it("never leaves the hinge angle outside 0..180", () => {
    const closed = reduceAppleDuoState(createAppleDuoState(), { type: "angle", angle: -50 });
    expect(closed.pose.angle).toBe(0);
    const flat = reduceAppleDuoState(closed, { type: "angle", angle: 999 });
    expect(flat.pose.angle).toBe(180);
  });
});

describe("APPLE_DUO_STANCES", () => {
  it("lists the four postures in open-to-closed order", () => {
    expect(APPLE_DUO_STANCES.map((stance) => stance.id)).toEqual(["open", "laptop", "tent", "closed"]);
    expect(APPLE_DUO_STANCES.every((stance) => stance.angle >= 0 && stance.angle <= 180)).toBe(true);
  });
});
