import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveMachineAdeDirWithReason, resolveMachineAdeLayout } from "./machineLayout";

/**
 * Where the machine home comes from when nothing set `$ADE_HOME`.
 *
 * A packaged channel build exports it to everything it spawns, but the Cursor
 * SDK worker stripped it, and the Alpha `ade` it injected then read the STABLE
 * `~/.ade`: an agent inside `ADE Alpha.app` whose CLI could not reach the Alpha
 * brain at all. The bundle a binary runs out of is the backstop.
 */
describe("resolveMachineAdeDirWithReason", () => {
  const alphaCli = "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade";

  it("takes $ADE_HOME first, whatever else is set", () => {
    const resolved = resolveMachineAdeDirWithReason(
      { ADE_HOME: "/Volumes/work/.ade-custom", ADE_PACKAGE_CHANNEL: "alpha" },
      alphaCli,
      "darwin",
    );

    expect(resolved).toEqual({
      dir: path.resolve("/Volumes/work/.ade-custom"),
      reason: "env",
      detail: "$ADE_HOME",
    });
  });

  it("takes $ADE_PACKAGE_CHANNEL ahead of the bundle it is running from", () => {
    const resolved = resolveMachineAdeDirWithReason(
      { ADE_PACKAGE_CHANNEL: "beta" },
      alphaCli,
      "darwin",
    );

    expect(resolved.dir).toBe(path.join(os.homedir(), ".ade-beta"));
    expect(resolved.reason).toBe("channel-env");
    expect(resolved.detail).toBe("$ADE_PACKAGE_CHANNEL=beta");
  });

  it("derives the channel home from the app bundle when nothing in the env says", () => {
    const resolved = resolveMachineAdeDirWithReason({}, alphaCli, "darwin");

    expect(resolved.dir).toBe(path.join(os.homedir(), ".ade-alpha"));
    expect(resolved.reason).toBe("bundle");
    expect(resolved.detail).toBe("ADE Alpha.app");
  });

  it("leaves the stable ADE.app on the stable machine home", () => {
    // `ADE.app` carries no channel word. Borrowing a channel home here would
    // move every stable install's brain, projects and plugins.
    const resolved = resolveMachineAdeDirWithReason(
      {},
      "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
      "darwin",
    );

    expect(resolved).toEqual({ dir: path.join(os.homedir(), ".ade"), reason: "default" });
  });

  it("falls back to the stable home outside any app bundle", () => {
    const resolved = resolveMachineAdeDirWithReason({}, "/usr/local/bin/ade", "darwin");

    expect(resolved).toEqual({ dir: path.join(os.homedir(), ".ade"), reason: "default" });
  });

  it("does not sniff app bundles on Windows, where they are not how channels install", () => {
    const resolved = resolveMachineAdeDirWithReason({}, alphaCli, "win32");

    expect(resolved.reason).toBe("default");
  });
});

describe("resolveMachineAdeLayout", () => {
  const arulEnv = {
    USERDOMAIN: "ADEBOX",
    USERNAME: "arul",
    USERPROFILE: "C:\\Users\\arul",
  };

  it("derives stable Windows pipe names from the canonical ADE home and user identity", () => {
    const first = resolveMachineAdeLayout(
      { ...arulEnv, ADE_HOME: "C:\\Users\\arul\\.ade" },
      "win32",
    );
    const equivalent = resolveMachineAdeLayout(
      { ...arulEnv, ADE_HOME: "C:/Users/arul/.ade" },
      "win32",
    );

    expect(first.socketPath).toMatch(/^\\\\\.\\pipe\\ade-runtime-stable-[a-f0-9]{16}$/);
    expect(equivalent.socketPath).toBe(first.socketPath);
    expect(first.desktopBridgeSocketPath).toMatch(
      /^\\\\\.\\pipe\\ade-desktop-bridge-stable-[a-f0-9]{16}$/,
    );
    expect(equivalent.desktopBridgeSocketPath).toBe(first.desktopBridgeSocketPath);
  });

  it("uses distinct Windows runtime pipes for release channels", () => {
    const alpha = resolveMachineAdeLayout(
      {
        ...arulEnv,
        ADE_HOME: "C:\\Users\\arul\\.ade-alpha",
        ADE_PACKAGE_CHANNEL: "alpha",
      },
      "win32",
    );
    const beta = resolveMachineAdeLayout(
      {
        ...arulEnv,
        ADE_HOME: "C:\\Users\\arul\\.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
      },
      "win32",
    );

    expect(alpha.socketPath).not.toBe(beta.socketPath);
    expect(alpha.socketPath).toContain("ade-runtime-alpha-");
    expect(beta.socketPath).toContain("ade-runtime-beta-");
  });

  it("isolates Windows runtime and desktop-bridge pipes for different users", () => {
    const arul = resolveMachineAdeLayout(
      { ...arulEnv, ADE_HOME: "D:\\Shared\\ADE" },
      "win32",
    );
    const other = resolveMachineAdeLayout(
      {
        USERDOMAIN: "ADEBOX",
        USERNAME: "other",
        USERPROFILE: "C:\\Users\\other",
        ADE_HOME: "D:\\Shared\\ADE",
      },
      "win32",
    );

    expect(arul.socketPath).not.toBe(other.socketPath);
    expect(arul.desktopBridgeSocketPath).not.toBe(other.desktopBridgeSocketPath);
  });

  it("prefers a provided Windows SID over mutable account labels", () => {
    const first = resolveMachineAdeLayout(
      {
        ...arulEnv,
        ADE_WINDOWS_USER_SID: "S-1-5-21-1000",
        ADE_HOME: "D:\\Shared\\ADE",
      },
      "win32",
    );
    const renamed = resolveMachineAdeLayout(
      {
        USERDOMAIN: "NEWDOMAIN",
        USERNAME: "renamed",
        USERPROFILE: "C:\\Users\\renamed",
        ADE_WINDOWS_USER_SID: "S-1-5-21-1000",
        ADE_HOME: "D:\\Shared\\ADE",
      },
      "win32",
    );

    expect(renamed.socketPath).toBe(first.socketPath);
    expect(renamed.desktopBridgeSocketPath).toBe(first.desktopBridgeSocketPath);
  });

  (process.platform === "win32" ? it : it.skip)(
    "canonicalizes existing Windows ancestor casing before ADE_HOME is created",
    () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-layout-case-"));
      const mixedCaseParent = path.join(tempRoot, "MiXeD-Parent");
      fs.mkdirSync(mixedCaseParent);
      const canonicalHome = path.join(mixedCaseParent, "Missing-ADE-Home");
      const alternateHome = path.join(
        tempRoot,
        "mixed-parent",
        "Missing-ADE-Home",
      );
      try {
        const canonical = resolveMachineAdeLayout(
          { ...arulEnv, ADE_HOME: canonicalHome },
          "win32",
        );
        const alternate = resolveMachineAdeLayout(
          { ...arulEnv, ADE_HOME: alternateHome },
          "win32",
        );

        expect(alternate.socketPath).toBe(canonical.socketPath);
        expect(alternate.desktopBridgeSocketPath).toBe(canonical.desktopBridgeSocketPath);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("derives the desktop-bridge socket from the ADE home", () => {
    const stable = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade" },
      "darwin",
    );
    const beta = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade-beta" },
      "darwin",
    );
    expect(stable.desktopBridgeSocketPath).toBe(
      path.join(path.resolve("/Users/arul/.ade"), "sock", "desktop-bridge.sock"),
    );
    expect(beta.desktopBridgeSocketPath).toBe(
      path.join(path.resolve("/Users/arul/.ade-beta"), "sock", "desktop-bridge.sock"),
    );
  });

  it.runIf(process.platform === "win32")(
    "keeps the Windows pipe identity stable across the creation of ADE_HOME",
    () => {
      // `canonicalWindowsPath` re-joins the components that do not exist yet.
      // Joining them verbatim meant `.ADE` hashed one way before the directory
      // existed and as the on-disk `.ade` after, so a brain started in that
      // window listened on a pipe every later CLI computed differently: an
      // orphaned, unreachable runtime.
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pipe-casing-"));
      const adeHome = path.join(tempRoot, ".ADE");
      try {
        const beforeCreation = resolveMachineAdeLayout(
          { ...arulEnv, ADE_HOME: adeHome },
          "win32",
        ).socketPath;
        fs.mkdirSync(adeHome, { recursive: true });
        const afterCreation = resolveMachineAdeLayout(
          { ...arulEnv, ADE_HOME: adeHome },
          "win32",
        ).socketPath;
        expect(afterCreation).toBe(beforeCreation);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("uses distinct Windows desktop-bridge pipes for channel ADE homes", () => {
    const stable = resolveMachineAdeLayout(
      { ...arulEnv, ADE_HOME: "C:\\Users\\arul\\.ade" },
      "win32",
    );
    const beta = resolveMachineAdeLayout(
      {
        ...arulEnv,
        ADE_HOME: "C:\\Users\\arul\\.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
      },
      "win32",
    );
    expect(stable.desktopBridgeSocketPath).not.toBe(beta.desktopBridgeSocketPath);
    expect(stable.desktopBridgeSocketPath).toContain("ade-desktop-bridge-stable-");
    expect(beta.desktopBridgeSocketPath).toContain("ade-desktop-bridge-beta-");
  });
});
