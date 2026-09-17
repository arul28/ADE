import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveAttentionNotchExecutablePath,
  resolveMacDesktopDriverBinary,
} from "./nativeHelperPaths";

/**
 * Where the two native helpers are, and nothing else.
 *
 * Both binaries land in the same `resources/native` directory, so both
 * resolvers are asserted together: a packaging change that moves one and not
 * the other is exactly the bug this file exists to catch.
 */
describe("native helper paths", () => {
  it("resolves packaged and development helper paths", () => {
    expect(resolveAttentionNotchExecutablePath({
      isPackaged: true,
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      appPath: "/repo/apps/desktop",
    })).toBe(path.join(
      "/Applications/ADE.app/Contents/Resources",
      "native",
      "ade-attention-notch",
    ));
    expect(resolveAttentionNotchExecutablePath({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
    })).toBe(path.join(
      "/repo/apps/desktop",
      "resources",
      "native",
      "ade-attention-notch",
    ));
  });

  it("resolves the Mac Desktop driver beside the notch helper, and nowhere off macOS", () => {
    expect(resolveMacDesktopDriverBinary({
      isPackaged: true,
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      appPath: "/repo/apps/desktop",
      platform: "darwin",
    })).toBe(path.join(
      "/Applications/ADE.app/Contents/Resources",
      "native",
      "ade-desktop-driver",
    ));
    expect(resolveMacDesktopDriverBinary({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
      platform: "darwin",
    })).toBe(path.join(
      "/repo/apps/desktop",
      "resources",
      "native",
      "ade-desktop-driver",
    ));
    // Windows and Linux hosts cannot host a display, and must learn that by
    // reading rather than by catching.
    // The runtime service asks with nothing but a platform; that must resolve
    // rather than throw.
    expect(resolveMacDesktopDriverBinary({ platform: "darwin" })).toContain(
      path.join("native", "ade-desktop-driver"),
    );
    expect(resolveMacDesktopDriverBinary({ platform: "win32" })).toBeNull();
    for (const platform of ["win32", "linux"] as const) {
      expect(resolveMacDesktopDriverBinary({
        isPackaged: true,
        resourcesPath: "C:\\Program Files\\ADE\\resources",
        appPath: "C:\\repo\\apps\\desktop",
        platform,
      })).toBeNull();
    }
  });


  it("ignores a driver path override that is not an executable file", () => {
    const debug = vi.fn();
    // A stale or misspelled override used to be returned verbatim, and the
    // health card then said the installation was missing its driver.
    const resolved = resolveMacDesktopDriverBinary({
      platform: "darwin",
      env: { ADE_MAC_DESKTOP_DRIVER_PATH: path.join("/nonexistent", "ade-desktop-driver") },
      logger: { debug },
    });
    expect(resolved).not.toBe(path.join("/nonexistent", "ade-desktop-driver"));
    expect(debug).toHaveBeenCalledWith(
      "mac_desktop.driver_path_override_ignored",
      { path: path.join("/nonexistent", "ade-desktop-driver") },
    );
  });

  it("honours an override that names a real executable", () => {
    // `process.execPath` is the one file every host is guaranteed to have and
    // to be allowed to execute.
    expect(resolveMacDesktopDriverBinary({
      platform: "darwin",
      env: { ADE_MAC_DESKTOP_DRIVER_PATH: process.execPath },
    })).toBe(process.execPath);
  });
});
