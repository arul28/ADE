import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  created: [] as Array<{ close: ReturnType<typeof vi.fn>; url: string }>,
}));

vi.mock("./openCodeBinaryManager", () => ({
  resolveOpenCodeBinaryPath: vi.fn(() => "/Users/admin/.opencode/bin/opencode"),
}));

import {
  __buildOpenCodeServeLaunchSpecForTests,
  __resetOpenCodeServerManagerForTests,
  __setOpenCodeProcessControllerForTests,
  __setOpenCodeServerLauncherForTests,
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
  getOpenCodeRuntimeDiagnostics,
  recoverManagedOpenCodeOrphans,
} from "./openCodeServerManager";

describe("openCodeServerManager", () => {
  const originalEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ADE_OPENCODE_XDG_ROOT: process.env.ADE_OPENCODE_XDG_ROOT,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENCODE_BIN_PATH: process.env.OPENCODE_BIN_PATH,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
  };

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
    __resetOpenCodeServerManagerForTests();
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => [],
      isProcessAlive: () => false,
      killProcess: () => {},
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
    vi.useRealTimers();
    restoreEnv("PATH");
    restoreEnv("HOME");
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

  it("reaps orphaned ADE-managed OpenCode processes and skips ones with a live owner", async () => {
    let orphanAlive = true;
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 4101 && signal === "SIGKILL") {
        orphanAlive = false;
      }
    });
    const homeDir = os.homedir();
    __setOpenCodeProcessControllerForTests({
      listProcesses: () => ([
        {
          pid: 4101,
          ppid: 1,
          command: [
            "/Users/admin/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=62298",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            `XDG_CONFIG_HOME=${homeDir}/.ade/opencode-runtime/xdg-v1/config`,
          ].join(" "),
        },
        {
          pid: 4102,
          ppid: 1,
          command: [
            "/Users/admin/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=62299",
            "OPENCODE_DISABLE_PROJECT_CONFIG=1",
            "ADE_OPENCODE_MANAGED=1",
            "ADE_OPENCODE_OWNER_PID=7788",
            `XDG_CONFIG_HOME=${homeDir}/.ade/opencode-runtime/xdg-v1/config`,
          ].join(" "),
        },
      ]),
      isProcessAlive: (pid) => {
        if (pid === 4101) return orphanAlive;
        return pid === 4102 || pid === 7788;
      },
      killProcess,
    });
    const result = await recoverManagedOpenCodeOrphans();

    expect(result.recoveredPids).toEqual([4101]);
    expect(result.skippedPids).toEqual([4102]);
    expect(killProcess).toHaveBeenCalledWith(4101, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(4101, "SIGKILL");
    expect(killProcess).not.toHaveBeenCalledWith(4102, "SIGTERM");
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
});
