import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopUserDataPath, resolveElectronAppDataPath } from "./desktopUserDataPath";

describe("resolveDesktopUserDataPath", () => {
  it("keeps packaged stable builds on Electron's default profile", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataPath: "/Users/ade/Library/Application Support",
        channel: null,
        isPackaged: true,
        env: {},
      }),
    ).toBeNull();
  });

  it("isolates packaged alpha and beta profiles", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataPath: "/Users/ade/Library/Application Support",
        channel: "alpha",
        isPackaged: true,
        env: {},
      }),
    ).toBe("/Users/ade/Library/Application Support/ade-desktop-alpha");

    expect(
      resolveDesktopUserDataPath({
        appDataPath: "/Users/ade/Library/Application Support",
        channel: "beta",
        isPackaged: true,
        env: {},
      }),
    ).toBe("/Users/ade/Library/Application Support/ade-desktop-beta");
  });

  it("isolates dev Electron from installed apps", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataPath: "/Users/ade/Library/Application Support",
        channel: null,
        isPackaged: false,
        env: {},
      }),
    ).toBe("/Users/ade/Library/Application Support/ade-desktop-dev");
  });

  it("honors an explicit override for smoke tests", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataPath: "/Users/ade/Library/Application Support",
        channel: "beta",
        isPackaged: true,
        env: { ADE_DESKTOP_USER_DATA_PATH: "./tmp/profile" },
      }),
    ).toBe(path.resolve("./tmp/profile"));
  });
});

describe("resolveElectronAppDataPath", () => {
  it("matches Electron's platform app data locations", () => {
    expect(resolveElectronAppDataPath({ platform: "darwin", homeDir: "/Users/ade", env: {} })).toBe(
      "/Users/ade/Library/Application Support",
    );
    expect(resolveElectronAppDataPath({ platform: "win32", homeDir: "C:\\Users\\ade", env: {} })).toBe(
      "C:\\Users\\ade\\AppData\\Roaming",
    );
    expect(resolveElectronAppDataPath({ platform: "linux", homeDir: "/home/ade", env: {} })).toBe("/home/ade/.config");
  });
});
