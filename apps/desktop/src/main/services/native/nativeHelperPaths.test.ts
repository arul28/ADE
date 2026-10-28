import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveAdeSigningState,
  standaloneNativeHelperCandidates,
  resolveMacDesktopDriverBinary,
  resolveMusicHostExecutable,
  resolveNowPlayingHelperBinary,
} from "./nativeHelperPaths";

/** Where the native helpers are, and nothing else. */
describe("native helper paths", () => {
  it("resolves the Mac Desktop driver in resources/native, and nowhere off macOS", () => {
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


  it("finds the music host on Windows and macOS only, and the Now Playing helper only on Windows once it is on disk", () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-helpers-"));
    try {
      const packaged = { isPackaged: true, resourcesPath: resources, appPath: "/unused" };
      // Not built yet: the widget says the helper is missing instead of failing to spawn.
      expect(resolveNowPlayingHelperBinary({ ...packaged, platform: "win32" })).toBeNull();
      fs.mkdirSync(path.join(resources, "native"));
      fs.writeFileSync(path.join(resources, "native", "ade-now-playing.exe"), "");
      expect(resolveNowPlayingHelperBinary({ ...packaged, platform: "win32" })).toBe(path.join(resources, "native", "ade-now-playing.exe"));
      expect(resolveMusicHostExecutable({ ...packaged, platform: "win32", env: {} }))
        .toBe(path.join(resources, "native", "ade-music-host", "ade-music-host.exe"));

      expect(resolveMusicHostExecutable({ ...packaged, platform: "darwin", env: {} }))
        .toBe(path.join(resources, "native", "ade-music-host", "ade-music-host"));

      for (const platform of ["darwin", "linux"] as const) {
        expect(resolveNowPlayingHelperBinary({ ...packaged, platform })).toBeNull();
      }
      // No host at all on Linux, even when an override names a real file.
      expect(resolveMusicHostExecutable({ ...packaged, platform: "linux", env: { ADE_MUSIC_HOST_PATH: path.join(resources, "native", "ade-now-playing.exe") } })).toBeNull();
    } finally {
      fs.rmSync(resources, { recursive: true, force: true });
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

  // A standalone brain (`~/.ade/bin/ade serve`) has no resources of its own:
  // the brain's runtime archive and the installed app are where its helpers
  // are. The driver prefers the app's signed copy (its TCC grants belong to
  // that binary); the rest prefer the archive (the brain's own protocol).
  it.each([
    ["ade-desktop-driver", "app", ["app", "runtime"]],
    ["ade-sim-helper", "runtime", ["runtime", "app"]],
  ] as const)("orders %s candidates %s first and skips another channel's app", (binaryName, prefer, order) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-home-"));
    const app = (name: string, bundleId: string) => {
      const contents = path.join(home, "Applications", `${name}.app`, "Contents");
      fs.mkdirSync(contents, { recursive: true });
      fs.writeFileSync(path.join(contents, "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`);
      return path.join(contents, "Resources", "native", binaryName);
    };
    const own = app("VLTest", "com.ade.desktop.beta");
    // Named like this channel's app, but its bundle says it is the stable one.
    app("ADE Beta", "com.ade.desktop");
    const env = {
      ADE_HOME: path.join(home, ".ade-beta"),
      ADE_PACKAGE_CHANNEL: "beta",
      ADE_DESKTOP_APP_NAME: "VLTest",
      ADE_RUNTIME_ROOT: path.join(home, "runtime"),
    };
    const runtime = path.join(home, "runtime", "native", binaryName);
    const candidates = standaloneNativeHelperCandidates({ binaryName, prefer, platform: "darwin", env, homeDir: home });
    const positions = { app: candidates.indexOf(own), runtime: candidates.indexOf(runtime) };
    expect(positions.app).toBeGreaterThanOrEqual(0);
    expect(positions.runtime).toBeGreaterThanOrEqual(0);
    expect(positions[order[0]]).toBeLessThan(positions[order[1]]);
    expect(candidates).not.toContain(path.join(home, "Applications", "ADE Beta.app", "Contents", "Resources", "native", binaryName));
  });

  describe("ade signing marker", () => {
    function packagedResources(marker: string | null): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-signing-"));
      if (marker !== null) {
        fs.mkdirSync(path.join(dir, "ade-cli"), { recursive: true });
        fs.writeFileSync(path.join(dir, "ade-cli", "signing"), marker);
      }
      return dir;
    }

    it("reads the identity and ad-hoc markers from a packaged app", () => {
      const identity = packagedResources("identity");
      expect(resolveAdeSigningState({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: identity,
      })).toBe("identity");

      const adhoc = packagedResources("adhoc");
      expect(resolveAdeSigningState({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: adhoc,
      })).toBe("adhoc");
    });

    it("treats a packaged app with no marker as ad-hoc", () => {
      // Packaged and no marker is the case where macOS drops the grant; saying
      // so is the whole point of the note.
      expect(resolveAdeSigningState({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: packagedResources(null),
      })).toBe("adhoc");
    });

    it("never calls a development build ad-hoc", () => {
      // A dev rebuild losing a grant is noise, not a warning worth showing.
      const dir = packagedResources("adhoc");
      expect(resolveAdeSigningState({
        platform: "darwin",
        isPackaged: false,
        resourcesPath: dir,
      })).toBe("identity");
    });

    it("answers unknown off macOS", () => {
      expect(resolveAdeSigningState({ platform: "win32" })).toBe("unknown");
      expect(resolveAdeSigningState({ platform: "linux" })).toBe("unknown");
    });
  });
});
