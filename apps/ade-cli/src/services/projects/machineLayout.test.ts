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
});
