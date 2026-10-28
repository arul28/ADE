import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isMachineAdeHome,
  isSyncCapableAdeHome,
  resolveMachineAdeLayout,
  resolveMachineEndpointNames,
} from "./machineLayout";

describe("isMachineAdeHome", () => {
  it("accepts only the default machine state root", () => {
    const machineHome = path.join(os.homedir(), ".ade");
    expect(isMachineAdeHome(machineHome, machineHome)).toBe(true);
    expect(isMachineAdeHome(path.join(os.tmpdir(), "ade-isolated-home"), machineHome)).toBe(false);
  });
});

describe("isSyncCapableAdeHome", () => {
  // Alpha and Beta must keep phone sync: they are how a build is tested end to
  // end. Any other home, and a channel brain in someone else's home, must not.
  it.each([
    ["the default home", ".ade", {}, true],
    ["Alpha in its own home", ".ade-alpha", { ADE_PACKAGE_CHANNEL: "alpha" }, true],
    ["Beta in its own home", ".ade-beta", { ADE_PACKAGE_CHANNEL: "beta" }, true],
    ["Alpha's home without the channel", ".ade-alpha", {}, false],
    ["Alpha pointed at Beta's home", ".ade-beta", { ADE_PACKAGE_CHANNEL: "alpha" }, false],
    ["a scratch home", ".ade-scratch", { ADE_PACKAGE_CHANNEL: "alpha" }, false],
  ])("%s", (_label, home, env, expected) => {
    expect(isSyncCapableAdeHome(path.join(os.homedir(), home), env)).toBe(expected);
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

  // On a Windows host the user is read from the process token, which one
  // process cannot vary; off Windows the env's profile stands for it.
  it.skipIf(process.platform === "win32")("isolates Windows runtime and desktop-bridge pipes for different users", () => {
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

  // One account reaches one brain however it logged in. The env differs per
  // logon (OpenSSH says WORKGROUP where the desktop says the machine name), so
  // none of it may move the name. Each row is one session of the same user.
  it.each([
    ["an OpenSSH session", { USERDOMAIN: "WORKGROUP" }],
    ["a session without a domain", { USERDOMAIN: "" }],
    ["a SID hint in the env", { ADE_WINDOWS_USER_SID: "S-1-5-21-1000" }],
    ["a different account label", { USERDOMAIN: "NEWDOMAIN", USERNAME: "ARUL" }],
  ])("keeps one Windows pipe name for %s", (_label, sessionEnv) => {
    const desktop = resolveMachineAdeLayout({ ...arulEnv, ADE_HOME: "C:\\Users\\arul\\.ade" }, "win32");
    const session = resolveMachineAdeLayout(
      { ...arulEnv, ...sessionEnv, ADE_HOME: "C:\\Users\\arul\\.ade" },
      "win32",
    );
    expect(session.socketPath).toBe(desktop.socketPath);
    expect(session.desktopBridgeSocketPath).toBe(desktop.desktopBridgeSocketPath);
  });

  it("still names the pipes ADE up to v1.2.125 listened on, from any session", () => {
    // Measured on a Windows PC on 2026-10-28: the brain started at the desktop
    // (USERDOMAIN=ARUL) listened on ...23b8c33b935af5fb, and an SSH session
    // (USERDOMAIN=WORKGROUP) computed ...ac69688075680682. A newer ade must
    // find either, and a newer brain must answer on both.
    const sshEnv = {
      ADE_HOME: "C:\\Users\\arul2\\.ade",
      USERDOMAIN: "WORKGROUP",
      USERNAME: "arul2",
      COMPUTERNAME: "ARUL",
      USERPROFILE: "C:\\Users\\arul2",
    };
    const names = resolveMachineEndpointNames(sshEnv, "win32");
    expect(names.runtime[0]).toBe(resolveMachineAdeLayout(sshEnv, "win32").socketPath);
    expect(names.runtime).toEqual(expect.arrayContaining([
      "\\\\.\\pipe\\ade-runtime-stable-23b8c33b935af5fb",
      "\\\\.\\pipe\\ade-runtime-stable-ac69688075680682",
    ]));
    expect(names.desktopBridge).toEqual(expect.arrayContaining([
      "\\\\.\\pipe\\ade-desktop-bridge-stable-23b8c33b935af5fb",
      "\\\\.\\pipe\\ade-desktop-bridge-stable-ac69688075680682",
    ]));
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
