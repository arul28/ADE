import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveMachineAdeLayout } from "./machineLayout";

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
