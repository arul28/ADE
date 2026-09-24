import { describe, expect, it } from "vitest";
import {
  adeCliShimDirName,
  publishServedRuntimeSocket,
  renderAdeCliShim,
  resolveAdeCliShimBrain,
} from "./adeCliShim";

describe("publishServedRuntimeSocket", () => {
  it("gives a launchd brain, which has only ADE_HOME, the socket it serves", () => {
    const env: NodeJS.ProcessEnv = { ADE_HOME: "/Users/a/.ade-alpha" };
    publishServedRuntimeSocket("/Users/a/.ade-alpha/sock/ade.sock", env);
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBe("/Users/a/.ade-alpha/sock/ade.sock");
    expect(resolveAdeCliShimBrain(env)).toEqual({
      socketPath: "/Users/a/.ade-alpha/sock/ade.sock",
      adeHome: "/Users/a/.ade-alpha",
    });
  });

  it("replaces an inherited socket with the one this brain answers on", () => {
    const env: NodeJS.ProcessEnv = { ADE_RUNTIME_SOCKET_PATH: "/Users/a/.ade/sock/ade.sock" };
    publishServedRuntimeSocket("/tmp/ade-runtime-lane.sock", env);
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBe("/tmp/ade-runtime-lane.sock");
    expect(env.ADE_RPC_SOCKET_PATH).toBeUndefined();
  });
});

describe("resolveAdeCliShimBrain", () => {
  it("keeps named pipes and tcp endpoints, drops relative values it cannot place", () => {
    expect(resolveAdeCliShimBrain({
      ADE_RUNTIME_SOCKET_PATH: "\\\\.\\pipe\\ade-runtime-x",
    }).socketPath).toBe("\\\\.\\pipe\\ade-runtime-x");
    expect(resolveAdeCliShimBrain({ ADE_RUNTIME_SOCKET_PATH: "tcp://127.0.0.1:9" }).socketPath)
      .toBe("tcp://127.0.0.1:9");
    expect(resolveAdeCliShimBrain({ ADE_RUNTIME_SOCKET_PATH: "rel/ade.sock", ADE_HOME: ".ade" }))
      .toEqual({ socketPath: null, adeHome: null });
    expect(resolveAdeCliShimBrain({})).toEqual({ socketPath: null, adeHome: null });
  });
});

describe("renderAdeCliShim", () => {
  const alpha = { socketPath: "/Users/a/.ade-alpha/sock/ade.sock", adeHome: "/Users/a/.ade-alpha" };

  it("defaults ADE_HOME and the socket only when the caller named no brain", () => {
    const body = renderAdeCliShim({
      entryPath: "/Apps/ADE Alpha.app/Contents/Resources/ade-cli/cli.cjs",
      execPath: "/Apps/ADE Alpha.app/Contents/MacOS/ADE Alpha",
      brain: { socketPath: "/tmp/it's here/ade.sock", adeHome: "/Users/a/.ade-alpha" },
      platform: "darwin",
    });
    expect(body).toBe([
      "#!/bin/sh",
      'if [ -z "${ADE_HOME:-}" ] && [ -z "${ADE_RUNTIME_SOCKET_PATH:-}" ]; then',
      "  ADE_HOME='/Users/a/.ade-alpha'; export ADE_HOME",
      "  ADE_RUNTIME_SOCKET_PATH='/tmp/it'\\''s here/ade.sock'; export ADE_RUNTIME_SOCKET_PATH",
      "fi",
      "ELECTRON_RUN_AS_NODE=1 exec '/Apps/ADE Alpha.app/Contents/MacOS/ADE Alpha' '/Apps/ADE Alpha.app/Contents/Resources/ade-cli/cli.cjs' \"$@\"",
      "",
    ].join("\n"));
    expect(renderAdeCliShim({
      entryPath: "/x/cli.cjs",
      execPath: "/x/node",
      brain: { socketPath: null, adeHome: null },
      platform: "linux",
    })).toBe("#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/x/node' '/x/cli.cjs' \"$@\"\n");
  });

  it("writes a Windows shim that doubles % and keeps the caller's choice", () => {
    const body = renderAdeCliShim({
      entryPath: "C:\\Program Files (x86)\\ADE 100%\\resources\\ade-cli\\cli.cjs",
      execPath: "C:\\Program Files (x86)\\ADE 100%\\ADE.exe",
      brain: { socketPath: "\\\\.\\pipe\\ade-runtime-alpha-1234", adeHome: "C:\\Users\\a\\%TEMP%\\.ade-alpha" },
      platform: "win32",
    });
    expect(body).toBe([
      "@echo off",
      "setlocal",
      "if defined ADE_HOME goto ade_run",
      "if defined ADE_RUNTIME_SOCKET_PATH goto ade_run",
      'set "ADE_HOME=C:\\Users\\a\\%%TEMP%%\\.ade-alpha"',
      'set "ADE_RUNTIME_SOCKET_PATH=\\\\.\\pipe\\ade-runtime-alpha-1234"',
      ":ade_run",
      "set ELECTRON_RUN_AS_NODE=1",
      '"C:\\Program Files (x86)\\ADE 100%%\\ADE.exe" "C:\\Program Files (x86)\\ADE 100%%\\resources\\ade-cli\\cli.cjs" %*',
      "",
    ].join("\r\n"));
    // cmd has no escape for a quote inside set "...", so such a value is not embedded.
    expect(renderAdeCliShim({
      entryPath: "C:\\ade\\ade.exe",
      execPath: "C:\\ade\\ade.exe",
      brain: { socketPath: "C:\\bad\"path", adeHome: null },
      platform: "win32",
    })).toBe("@echo off\r\nsetlocal\r\n\"C:\\ade\\ade.exe\" %*\r\n");
  });

  it("gives two brains that share one CLI entry separate shim directories", () => {
    const entry = "/repo/apps/ade-cli/dist/cli.cjs";
    const dev = adeCliShimDirName(entry, "/node", { socketPath: "/tmp/ade-runtime-lane.sock", adeHome: null });
    const stable = adeCliShimDirName(entry, "/node", { socketPath: "/Users/a/.ade/sock/ade.sock", adeHome: null });
    expect(dev).not.toBe(stable);
    expect(adeCliShimDirName(entry, "/node", alpha)).not.toBe(
      adeCliShimDirName(entry, "/node", { ...alpha, adeHome: null }),
    );
    expect(adeCliShimDirName(entry, "/node", alpha)).toBe(adeCliShimDirName(entry, "/node", { ...alpha }));
  });
});
