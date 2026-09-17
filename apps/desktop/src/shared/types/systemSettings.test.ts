import { describe, expect, it, vi } from "vitest";

import {
  isSystemSettingsPaneId,
  SYSTEM_SETTINGS_PANE_URLS,
  type SystemSettingsPaneId,
} from "./systemSettings";

/**
 * The pane table is the whole security boundary.
 *
 * `x-apple.systempreferences:` and `ms-settings:` are deliberately outside
 * `ALLOWED_EXTERNAL_URL_SCHEMES`, so the renderer cannot hand either one to
 * `openExternal`. It names a pane instead, and main resolves the name here —
 * which only holds if an unknown name resolves to nothing at all.
 */
describe("system settings panes", () => {
  it("knows the microphone pane on both platforms", () => {
    expect(SYSTEM_SETTINGS_PANE_URLS["macos-microphone"])
      .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    expect(SYSTEM_SETTINGS_PANE_URLS["windows-microphone"]).toBe("ms-settings:privacy-microphone");
  });

  it("refuses anything the table does not name", () => {
    expect(isSystemSettingsPaneId("macos-microphone")).toBe(true);
    expect(isSystemSettingsPaneId("windows-microphone")).toBe(true);
    // The shapes a renderer bug or an attacker would try.
    for (const value of [
      "x-apple.systempreferences:com.apple.preference.security",
      "ms-settings:privacy-webcam",
      "file:///etc/passwd",
      "constructor",
      "__proto__",
      "toString",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isSystemSettingsPaneId(value), String(value)).toBe(false);
    }
  });

  it("opens the named pane and nothing else", async () => {
    // The main-process resolution, in the shape `registerIpc` uses it.
    const openExternal = vi.fn(async (_url: string) => {});
    const openPane = async (paneId: unknown): Promise<{ opened: boolean }> => {
      if (!isSystemSettingsPaneId(paneId)) return { opened: false };
      await openExternal(SYSTEM_SETTINGS_PANE_URLS[paneId]);
      return { opened: true };
    };

    await expect(openPane("macos-microphone" satisfies SystemSettingsPaneId))
      .resolves.toEqual({ opened: true });
    expect(openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );

    await expect(openPane("windows-microphone")).resolves.toEqual({ opened: true });
    expect(openExternal).toHaveBeenLastCalledWith("ms-settings:privacy-microphone");

    openExternal.mockClear();
    await expect(openPane("ms-settings:privacy-webcam")).resolves.toEqual({ opened: false });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
