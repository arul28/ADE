import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLE_DEVICE_PREFERENCES,
  DEFAULT_APPLE_RECORDINGS_WARN_BYTES,
  DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
  GIB,
  normalizeAppleDevicePreferences,
  serializeAppleDevicePreferences,
  warnBytesFromGib,
  warnGibFromBytes,
} from "./appleDeviceSettings";

describe("appleDeviceSettings", () => {
  it("defaults the five contract keys", () => {
    expect(DEFAULT_APPLE_DEVICE_PREFERENCES).toEqual({
      realisticBody: true,
      recordingTapRings: true,
      recordingKeyBadges: true,
      remoteBitrateKbpsCap: DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
      recordingsWarnBytes: DEFAULT_APPLE_RECORDINGS_WARN_BYTES,
    });
    expect(DEFAULT_APPLE_REMOTE_BITRATE_KBPS).toBe(2500);
    expect(DEFAULT_APPLE_RECORDINGS_WARN_BYTES).toBe(5 * GIB);
  });

  it("round-trips the contract-shaped persistence blob", () => {
    const serialized = serializeAppleDevicePreferences({
      realisticBody: false,
      recordingTapRings: false,
      recordingKeyBadges: true,
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
    });
    expect(serialized).toEqual({
      realisticBody: false,
      recordingOverlays: { tapRings: false, keyBadges: true },
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
    });
    expect(normalizeAppleDevicePreferences(serialized)).toEqual({
      realisticBody: false,
      recordingTapRings: false,
      recordingKeyBadges: true,
      remoteBitrateKbpsCap: 1000,
      recordingsWarnBytes: 2 * GIB,
    });
  });

  it("converts the warning size between GiB and bytes", () => {
    expect(warnGibFromBytes(5 * GIB)).toBe(5);
    expect(warnBytesFromGib(5)).toBe(5 * GIB);
  });
});
