import { describe, expect, it } from "vitest";
import { MspError, ProtocolError } from "@muse-code/sdk";
import {
  describeMuseError,
  isMuseKnownNotification,
  isMuseErrorKind,
  museNotificationFromWire,
  museViewCursorOf,
} from "./museSdkHost";

describe("isMuseKnownNotification", () => {
  it("routes SDK methods to the typed mapper and leaves anything newer to the fallback", () => {
    expect(isMuseKnownNotification({ method: "item/delta", params: {} })).toBe(true);
    expect(isMuseKnownNotification({ method: "future/unknownMethod", params: {} })).toBe(false);
  });
});

describe("museNotificationFromWire", () => {
  it("reads a record's params through and falls back to an empty record for anything else", () => {
    expect(museNotificationFromWire({ method: "item/delta", params: { itemId: "i1", viewCursor: "c1" } }))
      .toEqual({ method: "item/delta", params: { itemId: "i1", viewCursor: "c1" } });
    expect(museNotificationFromWire({ method: "item/delta", params: "not-a-record" }))
      .toEqual({ method: "item/delta", params: {} });
    expect(museViewCursorOf({ method: "item/delta", params: { viewCursor: "c9" } })).toBe("c9");
    expect(museViewCursorOf({ method: "item/delta", params: {} })).toBeNull();
  });
});

describe("describeMuseError", () => {
  it("surfaces an MSP error's reason and routes a protocol failure to ADE's wording", () => {
    const msp = new MspError({ code: -32052, message: "refused", data: { kind: "computerUseUnavailable", reason: "gate off" } });
    expect(describeMuseError(msp)).toContain("gate off");
    expect(isMuseErrorKind(msp, "computerUseUnavailable")).toBe(true);
    expect(isMuseErrorKind(msp, "capabilityRequired")).toBe(false);
    expect(describeMuseError(new ProtocolError("bad frame"))).not.toBe("bad frame");
    expect(describeMuseError(new Error("plain"))).toBe("plain");
    expect(isMuseErrorKind(new Error("plain"), "capabilityRequired")).toBe(false);
  });
});
