import { describe, expect, it } from "vitest";
import {
  decodeAccountSettingRecord,
  decodeAccountVaultItem,
} from "./pushRelayClient";

describe("push relay account row decoders", () => {
  it("keeps settings rows with the complete wire shape", () => {
    expect(decodeAccountSettingRecord({
      scope: "all",
      key: "theme",
      value: "dark",
      updatedAt: "2026-09-16T00:00:00.000Z",
      changedAt: null,
      writerDeviceId: "device-a",
    })).toEqual({
      scope: "all",
      key: "theme",
      value: "dark",
      updatedAt: "2026-09-16T00:00:00.000Z",
      changedAt: null,
      writerDeviceId: "device-a",
    });
  });

  it("drops settings rows with invalid identity or timestamp fields", () => {
    expect(decodeAccountSettingRecord({
      scope: "all",
      key: "theme",
      value: "dark",
      updatedAt: "not-a-timestamp",
      changedAt: null,
      writerDeviceId: null,
    })).toBeNull();
  });

  it("drops vault rows with unknown kinds or unreadable values", () => {
    expect(decodeAccountVaultItem({
      scope: "all",
      kind: "unknown",
      key: "token",
      value: "secret",
      updatedAt: "2026-09-16T00:00:00.000Z",
      writerDeviceId: null,
      refreshOwner: null,
    })).toBeNull();
    expect(decodeAccountVaultItem({
      scope: "all",
      kind: "provider_key",
      key: "token",
      value: { leaked: true },
      updatedAt: "2026-09-16T00:00:00.000Z",
      writerDeviceId: null,
      refreshOwner: null,
    })).toBeNull();
  });
});
