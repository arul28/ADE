import { describe, expect, it } from "vitest";
import {
  GIB,
  normalizeAppleDevicePreferences,
  serializeAppleDevicePreferences,
  warnBytesFromGib,
  warnGibFromBytes,
} from "./appleDeviceSettings";

describe("appleDeviceSettings", () => {

  it("round-trips the contract-shaped persistence blob", () => {
    const serialized = serializeAppleDevicePreferences({
      realisticBody: false,
      recordingTapRings: false,
      recordingKeyBadges: true,
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
      autoRecordAgentInput: false,
    });
    expect(serialized).toEqual({
      realisticBody: false,
      recordingOverlays: { tapRings: false, keyBadges: true },
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
      autoRecordAgentInput: false,
    });
    expect(normalizeAppleDevicePreferences(serialized)).toEqual({
      realisticBody: false,
      recordingTapRings: false,
      recordingKeyBadges: true,
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
      autoRecordAgentInput: false,
    });
  });

  it("converts the warning size between GiB and bytes", () => {
    expect(warnGibFromBytes(5 * GIB)).toBe(5);
    expect(warnBytesFromGib(5)).toBe(5 * GIB);
  });
});
