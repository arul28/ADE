import { describe, expect, it } from "vitest";

import { resolveMachineAdeLayout } from "./machineLayout";

describe("resolveMachineAdeLayout", () => {
  it("keeps the stable Windows runtime pipe name for the default ADE home", () => {
    const layout = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade" },
      "win32",
    );

    expect(layout.socketPath).toBe("\\\\.\\pipe\\ade-runtime");
  });

  it("uses distinct Windows runtime pipes for channel ADE homes", () => {
    const alpha = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade-alpha" },
      "win32",
    );
    const beta = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade-beta" },
      "win32",
    );

    expect(alpha.socketPath).toBe("\\\\.\\pipe\\ade-runtime-ade-alpha");
    expect(beta.socketPath).toBe("\\\\.\\pipe\\ade-runtime-ade-beta");
  });

  it("derives the desktop-bridge socket from the ADE home", () => {
    const stable = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade" },
      "darwin",
    );
    const beta = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade-beta" },
      "darwin",
    );
    expect(stable.desktopBridgeSocketPath).toBe("/Users/arul/.ade/sock/desktop-bridge.sock");
    expect(beta.desktopBridgeSocketPath).toBe("/Users/arul/.ade-beta/sock/desktop-bridge.sock");
  });

  it("uses distinct Windows desktop-bridge pipes for channel ADE homes", () => {
    const stable = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade" },
      "win32",
    );
    const beta = resolveMachineAdeLayout(
      { ADE_HOME: "/Users/arul/.ade-beta" },
      "win32",
    );
    expect(stable.desktopBridgeSocketPath).toBe("\\\\.\\pipe\\ade-desktop-bridge");
    expect(beta.desktopBridgeSocketPath).toBe("\\\\.\\pipe\\ade-desktop-bridge-ade-beta");
  });
});
