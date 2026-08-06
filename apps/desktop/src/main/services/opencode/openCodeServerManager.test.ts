import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  created: [] as Array<{ close: ReturnType<typeof vi.fn>; url: string }>,
  resolveOpenCodeBinaryPath: vi.fn(() => "/Users/admin/.opencode/bin/opencode"),
  probeOpenCodeBinaryQuarantine: vi.fn(() => "unknown" as "quarantined" | "clean" | "unknown"),
}));

vi.mock("./openCodeBinaryManager", () => ({
  resolveOpenCodeBinaryPath: mockState.resolveOpenCodeBinaryPath,
  probeOpenCodeBinaryQuarantine: mockState.probeOpenCodeBinaryQuarantine,
}));

import {
  __buildOpenCodeServeLaunchSpecForTests,
  __isManagedOpenCodeServeCommandForTests,
  __parseOpenCodeServerListenUrlForTests,
  __resetOpenCodeServerManagerForTests,
  __resolveOpenCodeListenerPidForTests,
  __setOpenCodeProcessControllerForTests,
  __setOpenCodeServerLauncherForTests,
  __terminateOpenCodeServerProcessesForTests,
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
  classifyOpenCodeLaunchFailure,
  getOpenCodeRuntimeDiagnostics,
  OpenCodeLaunchError,
  parseWindowsWmicProcessCsv,
  recoverManagedOpenCodeOrphans,
  renderOpenCodeDiagnostic,
} from "./openCodeServerManager";

const originalProcessPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("parseWindowsWmicProcessCsv", () => {
  it("parses WMIC CSV rows into pid, ppid, and command", () => {
    const csv = [
      "Node,CommandLine,ParentProcessId,ProcessId",
      ",C:\\\\Windows\\\\System32\\\\notepad.exe,100,200",
    ].join("\r\n");
    const rows = parseWindowsWmicProcessCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 200,
      ppid: 100,
      command: "C:\\\\Windows\\\\System32\\\\notepad.exe",
    });
  });

  it("parses PowerShell ConvertTo-Csv rows", () => {
    const csv = [
      '"ProcessId","ParentProcessId","CommandLine"',
      '"300","200","C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c opencode.cmd serve"',
    ].join("\r\n");
    const rows = parseWindowsWmicProcessCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(300);
    expect(rows[0]?.ppid).toBe(200);
    expect(rows[0]?.command).toContain("opencode.cmd");
  });
});

describe("Windows managed OpenCode command detection", () => {
  it("detects cmd-wrapped serve with inline managed markers", () => {
    const cmdLine =
      'C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c set "ADE_OPENCODE_MANAGED=1"&&set "OPENCODE_DISABLE_PROJECT_CONFIG=1"&&set "ADE_OPENCODE_OWNER_PID=999"&&C:\\\\opencode\\\\opencode.cmd serve --hostname=127.0.0.1 --port=4310';
    expect(__isManagedOpenCodeServeCommandForTests(cmdLine)).toBe(true);
  });

  it("detects cmd-wrapped .bat OpenCode serve shims", () => {
    const cmdLine =
      'C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c set "ADE_OPENCODE_MANAGED=1"&&set "OPENCODE_DISABLE_PROJECT_CONFIG=1"&&set "ADE_OPENCODE_OWNER_PID=999"&&"C:\\\\tools\\\\opencode.bat" serve --hostname=127.0.0.1 --port=4310';
    expect(__isManagedOpenCodeServeCommandForTests(cmdLine)).toBe(true);
  });
});

describe("classifyOpenCodeLaunchFailure", () => {
  afterEach(() => {
    setProcessPlatform(originalProcessPlatform);
    mockState.probeOpenCodeBinaryQuarantine.mockReturnValue("unknown");
  });

  it("classifies a missing resolved binary as not-installed", () => {
    expect(
      classifyOpenCodeLaunchFailure(new Error("boom"), { port: 4096, binaryPath: null }),
    ).toEqual({ kind: "not-installed" });
  });

  it("classifies ENOENT spawn errors as not-installed", () => {
    const error = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "not-installed" });
  });

  it("classifies EADDRINUSE as port-conflict with the attempted port", () => {
    const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4310, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "port-conflict", port: 4310 });
  });

  it("classifies a startup deadline as launch-timeout", () => {
    const error = new Error("Timeout waiting for server to start after 15000ms");
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "launch-timeout" });
  });

  it("classifies explicit darwin developer-verification evidence with the quarantine xattr as quarantined", () => {
    setProcessPlatform("darwin");
    mockState.probeOpenCodeBinaryQuarantine.mockReturnValue("quarantined");
    const error = new Error("OpenCode developer cannot be verified");
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({
      kind: "quarantined",
      binaryPath: "/bin/opencode",
      fixCommand: 'xattr -d com.apple.quarantine "/bin/opencode"',
    });
  });

  it("classifies a darwin code-signature failure without quarantine as bad-signature", () => {
    setProcessPlatform("darwin");
    mockState.probeOpenCodeBinaryQuarantine.mockReturnValue("clean");
    const error = new Error("dyld: code signature invalid for opencode");
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "bad-signature", binaryPath: "/bin/opencode" });
  });

  it("keeps generic darwin kills unknown even when a quarantine attribute exists", () => {
    setProcessPlatform("darwin");
    mockState.probeOpenCodeBinaryQuarantine.mockReturnValue("quarantined");
    const error = new Error("Server exited with code null\nServer output: killed");
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "unknown", message: error.message });
  });

  it("keeps explicit signature failures unknown when the quarantine probe is inconclusive", () => {
    setProcessPlatform("darwin");
    mockState.probeOpenCodeBinaryQuarantine.mockReturnValue("unknown");
    const error = new Error("dyld: code signature invalid for opencode");
    expect(
      classifyOpenCodeLaunchFailure(error, { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "unknown", message: error.message });
  });

  it("classifies unrecognized failures as unknown, preserving the message", () => {
    setProcessPlatform("linux");
    expect(
      classifyOpenCodeLaunchFailure(new Error("weird failure"), { port: 4096, binaryPath: "/bin/opencode" }),
    ).toEqual({ kind: "unknown", message: "weird failure" });
  });

  it("renders stable prefix-keyed messages and wraps them in OpenCodeLaunchError", () => {
    expect(
      renderOpenCodeDiagnostic({
        kind: "quarantined",
        binaryPath: "/bin/opencode",
        fixCommand: 'xattr -d com.apple.quarantine "/bin/opencode"',
      }),
    ).toBe(
      'OpenCode: quarantined: OpenCode binary is quarantined by macOS Gatekeeper. Fix: xattr -d com.apple.quarantine "/bin/opencode"',
    );
    expect(renderOpenCodeDiagnostic({ kind: "port-conflict", port: 4310 })).toBe(
      "OpenCode: port-conflict: Port 4310 is already in use. Free the port or retry.",
    );

    const err = new OpenCodeLaunchError({ kind: "not-installed" });
    expect(err).toBeInstanceOf(Error);
    expect(err.diagnostic).toEqual({ kind: "not-installed" });
    expect(err.message.startsWith("OpenCode: not-installed:")).toBe(true);
  });
});

describe("openCodeServerManager", () => {
  const originalEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    ADE_OPENCODE_XDG_ROOT: process.env.ADE_OPENCODE_XDG_ROOT,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENCODE_BIN_PATH: process.env.OPENCODE_BIN_PATH,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
  };

  it("parses OpenCode listen URLs with noisy stdout prefixes", () => {
    expect(__parseOpenCodeServerListenUrlForTests(
      "[info] opencode server listening on http://127.0.0.1:4096",
    )).toBe("http://127.0.0.1:4096");
    expect(__parseOpenCodeServerListenUrlForTests(
      "Warning first; opencode server listening on http://127.0.0.1:62301",
    )).toBe("http://127.0.0.1:62301");
    expect(__parseOpenCodeServerListenUrlForTests("Warning: server is unsecured")).toBeNull();
  });

  const restoreEnv = (key: keyof typeof originalEnv): void => {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.created.length = 0;
    mockState.resolveOpenCodeBinaryPath.mockReturnValue("/Users/admin/.opencode/bin/opencode");
    __resetOpenCodeServerManagerForTests();
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => [],
      isProcessAlive: () => false,
      killProcess: () => {},
      killProcessTree: () => false,
      waitForMs: async () => {},
    });
    __setOpenCodeServerLauncherForTests(async ({ port }) => {
      const close = vi.fn();
      const entry = {
        close,
        url: `http://127.0.0.1:${port}`,
      };
      mockState.created.push(entry);
      return entry;
    });
  });

  afterEach(() => {
    __resetOpenCodeServerManagerForTests();
    setProcessPlatform(originalProcessPlatform as NodeJS.Platform);
    vi.useRealTimers();
    restoreEnv("PATH");
    restoreEnv("HOME");
    restoreEnv("XDG_CONFIG_HOME");
    restoreEnv("ADE_OPENCODE_XDG_ROOT");
    restoreEnv("OPENCODE_API_KEY");
    restoreEnv("OPENCODE_BIN_PATH");
    restoreEnv("OPENCODE_CONFIG_CONTENT");
    restoreEnv("OPENCODE_CONFIG_DIR");
  });

  it("reuses shared servers until the idle TTL expires", async () => {
    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const leaseA = await acquireSharedOpenCodeServer({
      config,
      key: "shared:test",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });
    const leaseB = await acquireSharedOpenCodeServer({
      config,
      key: "shared:test",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(1);
    expect(leaseA.url).toBe(leaseB.url);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    leaseA.release("handle_close");
    leaseB.release("handle_close");
    expect(mockState.created[0]?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(0);
  });

  it("coalesces parallel shared acquires into a single launched server", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    __setOpenCodeServerLauncherForTests(async ({ port }) => {
      await createGate;
      const close = vi.fn();
      const entry = {
        close,
        url: `http://127.0.0.1:${port}`,
      };
      mockState.created.push(entry);
      return entry;
    });

    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const leasePromiseA = acquireSharedOpenCodeServer({
      config,
      key: "shared:parallel",
      ownerKind: "chat",
    });
    const leasePromiseB = acquireSharedOpenCodeServer({
      config,
      key: "shared:parallel",
      ownerKind: "chat",
    });

    releaseCreate();
    const [leaseA, leaseB] = await Promise.all([leasePromiseA, leasePromiseB]);

    expect(mockState.created).toHaveLength(1);
    expect(leaseA.url).toBe(leaseB.url);

    leaseA.release("handle_close");
    leaseB.release("handle_close");
  });

  it("treats semantically identical shared configs as the same runtime even when key order differs", async () => {
    const configA = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        zed: { options: { apiKey: "one", baseURL: "https://example.test" } },
        alpha: { options: { apiKey: "two" } },
      },
    } as const;
    const configB = {
      snapshot: false,
      provider: {
        alpha: { options: { apiKey: "two" } },
        zed: { options: { baseURL: "https://example.test", apiKey: "one" } },
      },
      autoupdate: false,
      share: "disabled",
    } as const;

    const leaseA = await acquireSharedOpenCodeServer({
      config: configA,
      ownerKind: "chat",
      ownerId: "chat-a",
      idleTtlMs: 1_000,
    });
    const leaseB = await acquireSharedOpenCodeServer({
      config: configB,
      ownerKind: "chat",
      ownerId: "chat-b",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(1);
    expect(leaseA.url).toBe(leaseB.url);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    leaseA.release("handle_close");
    leaseB.release("handle_close");
  });

  it("rejects a config change while the existing server is still leased, then allows it after release", async () => {
    const configA = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const configB = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        openai: { options: { apiKey: "new-key" } },
      },
    } as const;

    const leaseA = await acquireSharedOpenCodeServer({
      config: configA,
      key: "shared:config-change",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    // Config change is rejected while leaseA is still held
    await expect(
      acquireSharedOpenCodeServer({
        config: configB,
        key: "shared:config-change",
        ownerKind: "inventory",
        idleTtlMs: 1_000,
      }),
    ).rejects.toThrow(/still in use/);

    // Release the old lease and the old server shuts down on idle
    leaseA.release("handle_close");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);

    // Now the config change succeeds — a new server is created
    const leaseB = await acquireSharedOpenCodeServer({
      config: configB,
      key: "shared:config-change",
      ownerKind: "inventory",
      idleTtlMs: 1_000,
    });

    expect(mockState.created).toHaveLength(2);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);
    expect(getOpenCodeRuntimeDiagnostics().entries[0]?.configFingerprint).toMatch(/^[a-f0-9]{64}$/);

    leaseB.release("handle_close");
  });

  it("compacts idle shared servers from older configs as soon as a new shared runtime is acquired", async () => {
    const configA = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        openai: { options: { apiKey: "one" } },
      },
    } as const;
    const configB = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        openai: { options: { apiKey: "two" } },
      },
    } as const;

    const leaseA = await acquireSharedOpenCodeServer({
      config: configA,
      key: "shared:a",
      ownerKind: "chat",
      idleTtlMs: 60_000,
    });
    leaseA.release("handle_close");
    expect(mockState.created[0]?.close).not.toHaveBeenCalled();

    const leaseB = await acquireSharedOpenCodeServer({
      config: configB,
      key: "shared:b",
      ownerKind: "chat",
      idleTtlMs: 60_000,
    });

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(mockState.created).toHaveLength(2);
    leaseB.release("handle_close");
  });

  it("shuts down a shared server immediately when its last lease closes with an error", async () => {
    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const lease = await acquireSharedOpenCodeServer({
      config,
      key: "shared:error",
      ownerKind: "chat",
      idleTtlMs: 60_000,
    });

    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    lease.close("error");

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(0);
  });

  it("keeps a shared server alive through a recoverable attach failure until idle TTL expires", async () => {
    const config = { share: "disabled", autoupdate: false, snapshot: false } as const;
    const lease = await acquireSharedOpenCodeServer({
      config,
      key: "shared:attach-failed",
      ownerKind: "chat",
      idleTtlMs: 1_000,
    });

    lease.close("attach_failed");

    expect(mockState.created[0]?.close).not.toHaveBeenCalled();
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockState.created[0]?.close).toHaveBeenCalledTimes(1);
    expect(getOpenCodeRuntimeDiagnostics().sharedCount).toBe(0);
  });

  it("refuses to reclaim leased dedicated servers when the budget is exceeded", async () => {
    const baseConfig = { share: "disabled", autoupdate: false, snapshot: false } as const;

    for (let index = 0; index < 6; index += 1) {
      const lease = await acquireDedicatedOpenCodeServer({
        ownerKey: `chat:${index}`,
        ownerKind: "chat",
        ownerId: `chat-${index}`,
        config: {
          ...baseConfig,
          agent: {
            [`role-${index}`]: {
              permission: {
                edit: "ask",
                bash: "ask",
                webfetch: "allow",
                doom_loop: "ask",
                external_directory: "ask",
              },
            },
          },
        } as const,
      });
      lease.setBusy(false);
      lease.setEvictionHandler(vi.fn());
    }

    await expect(
      acquireDedicatedOpenCodeServer({
        ownerKey: "chat:blocked",
        ownerKind: "chat",
        ownerId: "chat-blocked",
        config: {
          ...baseConfig,
          agent: {
            blocked: {
              permission: {
                edit: "ask",
                bash: "ask",
                webfetch: "allow",
                doom_loop: "ask",
                external_directory: "ask",
              },
            },
          },
        } as const,
      }),
    ).rejects.toThrow(/OpenCode runtime limit reached/);
    expect(mockState.created).toHaveLength(6);
    expect(mockState.created.every((entry) => entry.close.mock.calls.length === 0)).toBe(true);
  });

  it("builds an isolated OpenCode launch spec that strips inherited OpenCode env", () => {
    process.env.ADE_OPENCODE_XDG_ROOT = "/tmp/ade-opencode-test-home";
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/Users/tester";
    process.env.OPENCODE_API_KEY = "ambient-api-key";
    process.env.OPENCODE_BIN_PATH = "/tmp/rogue-opencode";
    process.env.OPENCODE_CONFIG_DIR = "/Users/tester/.config/opencode";
    process.env.OPENCODE_CONFIG_CONTENT = "{\"experimental\":{\"pencil\":true}}";

    const config = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        openai: {
          options: {
            apiKey: "ade-key",
          },
        },
      },
    } as const;

    const spec = __buildOpenCodeServeLaunchSpecForTests({
      config,
      port: 4310,
      isolatedConfig: true,
    });

    expect(spec.executable).toBe("/Users/admin/.opencode/bin/opencode");
    expect(spec.args).toEqual([
      "serve",
      "--hostname=127.0.0.1",
      "--port=4310",
    ]);
    expect(spec.useShell).toBe(false);
    expect(spec.env.PATH).toBe("/usr/bin:/bin");
    expect(spec.env.HOME).toBe("/Users/tester");
    expect(spec.env.XDG_CONFIG_HOME).toBe("/tmp/ade-opencode-test-home/xdg-v1/config");
    expect(spec.env.XDG_DATA_HOME).toBe("/tmp/ade-opencode-test-home/xdg-v1/data");
    expect(spec.env.XDG_STATE_HOME).toBe("/tmp/ade-opencode-test-home/xdg-v1/state");
    expect(spec.env.XDG_CACHE_HOME).toBe("/tmp/ade-opencode-test-home/xdg-v1/cache");
    expect(spec.env.XDG_RUNTIME_DIR).toBe("/tmp/ade-opencode-test-home/xdg-v1/runtime");
    expect(spec.env.OPENCODE_CONFIG_DIR).toBe("/tmp/ade-opencode-test-home/xdg-v1/config/opencode");
    expect(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(spec.env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(config));
    expect(spec.env.ADE_OPENCODE_MANAGED).toBe("1");
    expect(spec.env.ADE_OPENCODE_OWNER_PID).toBe(String(process.pid));
    expect(spec.env.OPENCODE_API_KEY).toBeUndefined();
    expect(spec.env.OPENCODE_BIN_PATH).toBeUndefined();
  });

  it("keeps the user's OpenCode config layers for ordinary chat servers", () => {
    process.env.ADE_OPENCODE_XDG_ROOT = "/tmp/ade-opencode-test-home";
    process.env.XDG_CONFIG_HOME = "/Users/tester/.config";
    process.env.OPENCODE_API_KEY = "ambient-api-key";
    process.env.OPENCODE_CONFIG_DIR = "/Users/tester/.config/opencode";
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: { filesystem: { type: "local", command: ["filesystem"] } },
      theme: "user-theme",
    });

    const spec = __buildOpenCodeServeLaunchSpecForTests({
      config: {
        mcp: { "ade-orchestration": { type: "remote", url: "http://ade/mcp" } },
      } as const,
      port: 4311,
    });

    expect(spec.env.XDG_CONFIG_HOME).toBe("/Users/tester/.config");
    expect(spec.env.OPENCODE_CONFIG_DIR).toBe("/Users/tester/.config/opencode");
    expect(spec.env.OPENCODE_API_KEY).toBe("ambient-api-key");
    expect(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      mcp: {
        filesystem: { type: "local", command: ["filesystem"] },
        "ade-orchestration": { type: "remote", url: "http://ade/mcp" },
      },
      theme: "user-theme",
    });
    expect(spec.env.ADE_OPENCODE_MANAGED).toBe("1");
  });

  it("does not replace malformed user OpenCode config content", () => {
    process.env.OPENCODE_CONFIG_CONTENT = "{not valid json";

    const spec = __buildOpenCodeServeLaunchSpecForTests({
      config: { mcp: { "ade-orchestration": { type: "remote", url: "http://ade/mcp" } } } as const,
      port: 4312,
    });

    expect(spec.env.OPENCODE_CONFIG_CONTENT).toBe("{not valid json");
    expect(spec.env.ADE_OPENCODE_MANAGED).toBe("1");
  });

  it("quotes the OpenCode executable in Windows cmd launch specs", () => {
    setProcessPlatform("win32");
    process.env.ADE_OPENCODE_XDG_ROOT = "/tmp/ade-opencode-test-home";
    mockState.resolveOpenCodeBinaryPath.mockReturnValue("C:\\Users\\100% dev\\bin\\opencode.bat");

    const spec = __buildOpenCodeServeLaunchSpecForTests({
      config: { share: "disabled" } as const,
      port: 4310,
    });

    expect(spec.executable).toBe("cmd.exe");
    expect(spec.args[0]).toBe("/d");
    expect(spec.args[1]).toBe("/s");
    expect(spec.args[2]).toBe("/c");
    // `quoteWindowsCmdArg` no longer doubles `%`: on a `cmd /c` command line
    // `%%` survives literally, so a directory genuinely named `100% dev` used
    // to be handed to cmd.exe as `100%% dev` and could not be launched.
    expect(spec.args[3]).toContain('&&"C:\\Users\\100% dev\\bin\\opencode.bat" "serve" "--hostname=127.0.0.1" "--port=4310"');
  });

  it("reaps orphaned ADE-managed OpenCode processes on Windows with a tree kill and skips ones with a live owner", async () => {
    setProcessPlatform("win32");
    let orphanAlive = true;
    const killProcess = vi.fn();
    const killProcessTree = vi.fn((pid: number) => {
      if (pid === 4101) {
        orphanAlive = false;
      }
      return true;
    });
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => ([
        {
          pid: 4101,
          ppid: 1,
          command:
            'C:\\Windows\\System32\\cmd.exe /d /s /c set "ADE_OPENCODE_MANAGED=1"&&set "OPENCODE_DISABLE_PROJECT_CONFIG=1"&&set "ADE_OPENCODE_OWNER_PID=999999"&&C:\\opencode\\opencode.cmd serve --hostname=127.0.0.1 --port=62298',
        },
        {
          pid: 4102,
          ppid: 1,
          command:
            'C:\\Windows\\System32\\cmd.exe /d /s /c set "ADE_OPENCODE_MANAGED=1"&&set "OPENCODE_DISABLE_PROJECT_CONFIG=1"&&set "ADE_OPENCODE_OWNER_PID=7788"&&C:\\opencode\\opencode.cmd serve --hostname=127.0.0.1 --port=62299',
        },
      ]),
      isProcessAlive: (pid) => {
        if (pid === 4101) return orphanAlive;
        return pid === 4102 || pid === 7788;
      },
      killProcess,
      killProcessTree,
    });
    const result = await recoverManagedOpenCodeOrphans();

    expect(result.recoveredPids).toEqual([4101]);
    expect(result.skippedPids).toEqual([4102]);
    expect(killProcessTree).toHaveBeenCalledWith(4101);
    expect(killProcessTree).not.toHaveBeenCalledWith(4102);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("does not mark stubborn orphaned processes as recovered", async () => {
    const logger = { warn: vi.fn() } as any;
    const killProcess = vi.fn();
    const homeDir = os.homedir();
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => ([
        {
          pid: 6101,
          ppid: 1,
          command: [
            "/Users/admin/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=62301",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            `XDG_CONFIG_HOME=${homeDir}/.ade/opencode-runtime/xdg-v1/config`,
          ].join(" "),
        },
      ]),
      isProcessAlive: (pid) => pid === 6101,
      killProcess,
    });

    const result = await recoverManagedOpenCodeOrphans({ force: true, logger });

    expect(result.recoveredPids).toEqual([]);
    expect(result.skippedPids).toEqual([6101]);
    expect(killProcess).toHaveBeenCalledWith(6101, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(6101, "SIGKILL");
    expect(logger.warn).toHaveBeenCalledWith(
      "opencode.server_orphan_recovery_failed",
      expect.objectContaining({ pid: 6101 }),
    );
  });

  it("resolves the actual managed listener pid for a launched OpenCode port", () => {
    __setOpenCodeProcessControllerForTests({
      listListeningPids: (port) => (port === 62244 ? [7202] : []),
      listProcesses: () => ([
        {
          pid: 7201,
          ppid: 1,
          command: [
            "node /Users/admin/.npm-global/bin/opencode serve --hostname=127.0.0.1 --port=62244",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
          ].join(" "),
        },
        {
          pid: 7202,
          ppid: 7201,
          command: [
            "/Users/admin/.npm-global/lib/node_modules/opencode-ai/bin/.opencode serve --hostname=127.0.0.1 --port=62244",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
          ].join(" "),
        },
      ]),
    });

    expect(__resolveOpenCodeListenerPidForTests(62244)).toBe(7202);
  });

  it("falls back to the managed non-node serve process when lsof is unavailable", () => {
    __setOpenCodeProcessControllerForTests({
      listListeningPids: () => [],
      listProcesses: () => ([
        {
          pid: 7301,
          ppid: 1,
          command: [
            "node /Users/admin/.npm-global/bin/opencode serve --hostname=127.0.0.1 --port 62245",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
          ].join(" "),
        },
        {
          pid: 7302,
          ppid: 7301,
          command: [
            "/Users/admin/.npm-global/lib/node_modules/opencode-ai/bin/.opencode serve --hostname=127.0.0.1 --port 62245",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
          ].join(" "),
        },
      ]),
    });

    expect(__resolveOpenCodeListenerPidForTests(62245)).toBe(7302);
  });

  it("recovers current-owner listeners that no longer have an active manager entry", async () => {
    let staleAlive = true;
    const killProcess = vi.fn((_pid: number) => {
      staleAlive = false;
    });
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => ([
        {
          pid: 7401,
          ppid: 1,
          command: [
            "/Users/admin/.npm-global/lib/node_modules/opencode-ai/bin/.opencode serve --hostname=127.0.0.1 --port=62246",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
            `ADE_OPENCODE_OWNER_PID=${process.pid}`,
          ].join(" "),
        },
      ]),
      isProcessAlive: (pid) => pid === 7401 && staleAlive,
      killProcess,
    });

    const result = await recoverManagedOpenCodeOrphans({ force: true });

    expect(result.recoveredPids).toEqual([7401]);
    expect(result.skippedPids).toEqual([]);
    expect(killProcess).toHaveBeenCalledWith(7401, "SIGTERM");
  });

  it("keeps current-owner listeners that are still registered as active", async () => {
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => [],
      isProcessAlive: () => false,
      killProcess: () => {},
    });
    const lease = await acquireSharedOpenCodeServer({
      config: { share: "disabled", autoupdate: false, snapshot: false },
      key: "shared:active-current-owner",
      ownerKind: "chat",
    });
    const activePort = new URL(lease.url).port;
    const killProcess = vi.fn();
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => ([
        {
          pid: 7501,
          ppid: 1,
          command: [
            `/Users/admin/.npm-global/lib/node_modules/opencode-ai/bin/.opencode serve --hostname=127.0.0.1 --port=${activePort}`,
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
            `ADE_OPENCODE_OWNER_PID=${process.pid}`,
          ].join(" "),
        },
      ]),
      isProcessAlive: (pid) => pid === 7501,
      killProcess,
    });

    const result = await recoverManagedOpenCodeOrphans({ force: true });

    expect(result.recoveredPids).toEqual([]);
    expect(result.skippedPids).toEqual([7501]);
    expect(killProcess).not.toHaveBeenCalled();
    lease.release("handle_close");
  });

  it("waits for an in-flight forced recovery before starting another forced scan", async () => {
    let releaseFirstWait!: () => void;
    const firstWaitGate = new Promise<void>((resolve) => {
      releaseFirstWait = resolve;
    });
    let orphanAlive = true;
    const homeDir = os.homedir();
    const listProcesses = vi.fn()
      .mockImplementationOnce(() => ([
        {
          pid: 5101,
          ppid: 1,
          command: [
            "/Users/admin/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=62301",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            `XDG_CONFIG_HOME=${homeDir}/.ade/opencode-runtime/xdg-v1/config`,
          ].join(" "),
        },
      ]))
      .mockImplementationOnce(() => []);
    const killProcess = vi.fn();
    __setOpenCodeProcessControllerForTests({
      listProcesses,
      isProcessAlive: (pid) => pid === 5101 && orphanAlive,
      killProcess,
      waitForMs: async () => {
        await firstWaitGate;
        orphanAlive = false;
      },
    });

    const firstRecovery = recoverManagedOpenCodeOrphans({ force: true });
    const secondRecovery = recoverManagedOpenCodeOrphans({ force: true });

    expect(listProcesses).toHaveBeenCalledTimes(1);

    releaseFirstWait();

    const [firstResult, secondResult] = await Promise.all([firstRecovery, secondRecovery]);

    expect(firstResult.recoveredPids).toEqual([5101]);
    expect(secondResult.recoveredPids).toEqual([]);
    expect(listProcesses).toHaveBeenCalledTimes(2);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(5101, "SIGTERM");
  });

  it("does not double-kill when the listener PID equals the spawned child PID", () => {
    setProcessPlatform("darwin");
    const killProcess = vi.fn();
    const killProcessTree = vi.fn(() => false);
    __setOpenCodeProcessControllerForTests({
      isProcessAlive: () => true,
      killProcess,
      killProcessTree,
    });

    const procKill = vi.fn();
    const fakeProc = {
      pid: 9001,
      exitCode: null,
      signalCode: null,
      kill: procKill,
    } as unknown as ChildProcess;

    __terminateOpenCodeServerProcessesForTests(fakeProc, 9001);

    // Listener PID kill happens exactly once via killProcess, and the child-side
    // fallback (stopChildProcess) must NOT fire a second signal at the same PID.
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(9001, "SIGTERM");
    expect(procKill).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("falls back to stopChildProcess when the listener PID differs from the child PID", () => {
    setProcessPlatform("darwin");
    const killProcess = vi.fn();
    __setOpenCodeProcessControllerForTests({
      isProcessAlive: () => true,
      killProcess,
      killProcessTree: () => false,
    });

    const procKill = vi.fn();
    const fakeProc = {
      pid: 8001,
      exitCode: null,
      signalCode: null,
      kill: procKill,
    } as unknown as ChildProcess;

    __terminateOpenCodeServerProcessesForTests(fakeProc, 8002);

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(8002, "SIGTERM");
    expect(procKill).toHaveBeenCalledTimes(1);
  });
});
