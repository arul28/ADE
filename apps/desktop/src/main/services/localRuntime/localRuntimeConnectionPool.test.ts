import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordLastFailure } from "../runtime/lastFailureStore";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/Applications/ADE.app/Contents/Resources/app.asar",
  },
}));

import {
  buildLocalRuntimeNodeEnv,
  buildLocalRuntimeNodePath,
  buildLocalRuntimeServeArgs,
  compareRuntimeVersionStrings,
  computeLocalRuntimeBuildHash,
  createLocalRuntimeOutputLogger,
  isLocalChannelBuildOutputPath,
  isLocalRuntimeConnectionDropped,
  isRetryableReadAction,
  localReleaseBuildOutputRuntimeBlock,
  LocalRuntimeConnectionPool,
  parseRuntimeServiceManagerOutput,
  readLocalRuntimeInfo,
  shouldAutoInstallRuntimeServiceFromPath,
} from "./localRuntimeConnectionPool";
import {
  LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_SYNC_TIMEOUT_MS,
} from "./localRuntimeTimeoutPolicy";

type RawPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class RawRuntimeSocketClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, RawPendingRequest>();

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("ADE service socket closed.")));
  }

  static connect(socketPath: string): Promise<RawRuntimeSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve(new RawRuntimeSocketClient(socket));
      };
      const onError = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof parsed.id !== "number") continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      this.pending.delete(parsed.id);
      if (parsed.error) pending.reject(new Error(parsed.error.message ?? "ADE service request failed."));
      else pending.resolve(parsed.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function withTsxNodeOptions(value: string | undefined, loaderPath: string): string {
  const existing = value?.trim();
  return existing ? `${existing} --import ${loaderPath}` : `--import ${loaderPath}`;
}

async function waitForRuntimeSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(async () => {
    let client: RawRuntimeSocketClient | null = null;
    try {
      client = await RawRuntimeSocketClient.connect(socketPath);
      await client.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "local-runtime-test-readiness",
        identity: { role: "external", callerId: "local-runtime-test-readiness" },
      });
    } finally {
      client?.close();
    }
  }, { timeout: timeoutMs, interval: 100 });
}

function startServeProcess(args: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
}): ChildProcess {
  return spawn(process.execPath, [args.cliPath, "serve", "--socket", args.socketPath, "--no-sync"], {
    cwd: args.cwd,
    env: args.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function runningTestServiceStatus() {
  return {
    ok: true,
    serviceName: "com.ade.runtime",
    action: "status" as const,
    installed: true,
    running: true,
    path: "/test/com.ade.runtime",
    message: "ADE test service is running.",
  };
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function shutdownRuntime(socketPath: string): Promise<void> {
  let client: RawRuntimeSocketClient | null = null;
  try {
    client = await RawRuntimeSocketClient.connect(socketPath);
    await client.request("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "local-runtime-test-cleanup",
      identity: { role: "external", callerId: "local-runtime-test-cleanup" },
    });
    await client.request("shutdown").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("socket closed")) throw error;
    });
  } catch {
    // Best-effort cleanup; a failed test should not mask the original assertion.
  } finally {
    client?.close();
  }
}

describe("local runtime connection pool", () => {
  it("aggregates slow actions into a bounded 24h runtime-health window", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never) as unknown as {
      recordSlowAction: (atMs: number, totalMs: number) => void;
      getRuntimeHealth: (nowMs?: number) => {
        slowActions24h: number;
        slowActionP95Ms: number | null;
        sampledAt: string;
      };
      dispose: () => void;
    };
    const now = Date.parse("2026-07-17T12:00:00.000Z");

    // An empty window reports zero slow actions and a null p95.
    expect(pool.getRuntimeHealth(now)).toMatchObject({ slowActions24h: 0, slowActionP95Ms: null });

    // One sample 25h old (out of window) plus 100 in-window samples 501..600 ms.
    pool.recordSlowAction(now - 25 * 60 * 60_000, 9_000);
    for (let index = 0; index < 100; index += 1) {
      pool.recordSlowAction(now - index * 60_000, 501 + index);
    }
    const health = pool.getRuntimeHealth(now);
    expect(health.slowActions24h).toBe(100); // the 25h-old sample is pruned
    // Nearest-rank p95 of 501..600 → index ceil(0.95*100)-1 = 94 → 595.
    expect(health.slowActionP95Ms).toBe(595);
    expect(health.sampledAt).toBe(new Date(now).toISOString());
    pool.dispose();
  });

  it("compares ADE runtime versions without requiring exact tag formatting", () => {
    expect(compareRuntimeVersionStrings("v1.2.14", "1.2.13")).toBe(1);
    expect(compareRuntimeVersionStrings("1.2.12", "v1.2.13")).toBe(-1);
    expect(compareRuntimeVersionStrings("1.2.13", "v1.2.13")).toBe(0);
    expect(compareRuntimeVersionStrings("1.2.13+runtime.1", "v1.2.13")).toBe(0);
    expect(compareRuntimeVersionStrings("v1.2.14-beta.2", "1.2.14-beta.1")).toBe(1);
    expect(compareRuntimeVersionStrings("1.2.14", "1.2.14-beta.2")).toBe(1);
    expect(compareRuntimeVersionStrings("1.2.14-beta.2", "1.2.14")).toBe(-1);
    expect(compareRuntimeVersionStrings("0.0.0", "1.2.13")).toBe(-1);
    expect(compareRuntimeVersionStrings(null, "1.2.13")).toBeNull();
    expect(compareRuntimeVersionStrings("next", "1.2.13")).toBeNull();
  });

  it("quarantines a newer brain whose protocol window excludes this desktop", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pool = new LocalRuntimeConnectionPool("1.0.0", logger as never);
    const internals = pool as unknown as {
      runtimeCompatibilityError: (socketPath: string, runtimeInfo: {
        version: string;
        buildHash: string;
        defaultRole: string;
        pid: number;
        minCompatibleProtocol: number;
        protocolVersion: number;
      }) => Error & { skewState: string };
      connectClient: (socketPath: string) => Promise<unknown>;
      startIsolatedRuntime: (socketPath: string, error: Error) => Promise<{
        client: unknown;
        child: null;
        socketPath: string;
      }>;
      tryConnect: (socketPath: string) => Promise<{ socketPath: string } | null>;
    };
    const compatibilityError = internals.runtimeCompatibilityError("/tmp/ade.sock", {
      version: "2.0.0",
      buildHash: "newer-build",
      defaultRole: "cto",
      pid: 4321,
      minCompatibleProtocol: 2,
      protocolVersion: 2,
    });
    vi.spyOn(internals, "connectClient").mockRejectedValue(compatibilityError);
    const startIsolatedRuntime = vi.spyOn(internals, "startIsolatedRuntime")
      .mockResolvedValue({
        client: {},
        child: null,
        socketPath: "/tmp/ade-isolated.sock",
      });

    try {
      await expect(internals.tryConnect("/tmp/ade.sock")).resolves.toMatchObject({
        socketPath: "/tmp/ade-isolated.sock",
      });
      expect(compatibilityError.skewState).toBe("runtime_newer");
      expect(startIsolatedRuntime).toHaveBeenCalledWith(
        "/tmp/ade.sock",
        compatibilityError,
      );
    } finally {
      pool.dispose();
    }
  });

  it("starts fallback runtimes with sync enabled by default", () => {
    const args = buildLocalRuntimeServeArgs("/opt/ade/cli.cjs", "/tmp/ade.sock");

    expect(args).toEqual(["/opt/ade/cli.cjs", "serve", "--socket", "/tmp/ade.sock"]);
    expect(args).not.toContain("--no-sync");
  });

  it("keeps explicit no-sync support for narrow test or diagnostic launches", () => {
    const args = buildLocalRuntimeServeArgs("/opt/ade/cli.cjs", "/tmp/ade.sock", { disableSync: true });

    expect(args).toContain("--no-sync");
  });

  it("builds packaged runtime NODE_PATH for macOS universal app layouts", () => {
    const nodePath = buildLocalRuntimeNodePath({
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
      existingNodePath: "/custom/node_modules",
    });

    expect(nodePath?.split(path.delimiter)).toEqual([
      "/Applications/ADE.app/Contents/Resources/app-arm64.asar.unpacked/node_modules",
      "/Applications/ADE.app/Contents/Resources/app.asar.unpacked/node_modules",
      "/Applications/ADE.app/Contents/Resources/app-arm64.asar/node_modules",
      "/Applications/ADE.app/Contents/Resources/app.asar/node_modules",
      "/custom/node_modules",
    ]);
  });

  it("uses the packaged runtime module path when spawning the service", () => {
    const env = buildLocalRuntimeNodeEnv(
      "1.2.3",
      {
        NODE_PATH: "/custom/node_modules",
        ADE_CHAT_SESSION_ID: "agent-chat",
        ADE_RUN_ID: "agent-run",
        ADE_STEP_ID: "agent-step",
        ADE_ATTEMPT_ID: "agent-attempt",
        ADE_OWNER_ID: "agent-owner",
        UNRELATED_VALUE: "preserved",
      },
      { resourcesPath: "/Applications/ADE.app/Contents/Resources", platform: "darwin", arch: "x64" },
    );

    expect(env.ADE_DEFAULT_ROLE).toBe("cto");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.ADE_CLI_VERSION).toBe("1.2.3");
    expect(env.ADE_CHAT_SESSION_ID).toBeUndefined();
    expect(env.ADE_RUN_ID).toBeUndefined();
    expect(env.ADE_STEP_ID).toBeUndefined();
    expect(env.ADE_ATTEMPT_ID).toBeUndefined();
    expect(env.ADE_OWNER_ID).toBeUndefined();
    expect(env.UNRELATED_VALUE).toBe("preserved");
    expect(env.NODE_PATH).toContain("app-x64.asar.unpacked");
    expect(env.NODE_PATH).toContain("app.asar.unpacked");
    expect(env.NODE_PATH).toContain("/custom/node_modules");
  });

  it("does not auto-install channel services from local release build output paths", () => {
    const releaseCliPath = "/Users/admin/Projects/ADE/apps/desktop/release-beta/mac-arm64/ADE Beta.app/Contents/Resources/ade-cli/cli.cjs";
    const installedCliPath = "/Applications/ADE Beta.app/Contents/Resources/ade-cli/cli.cjs";
    const originalAllow = process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;

    try {
      delete process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;

      expect(isLocalChannelBuildOutputPath(releaseCliPath)).toBe(true);
      expect(shouldAutoInstallRuntimeServiceFromPath(releaseCliPath)).toBe(false);
      expect(localReleaseBuildOutputRuntimeBlock(releaseCliPath)).toMatchObject({
        cliPath: releaseCliPath,
      });
      expect(isLocalChannelBuildOutputPath(installedCliPath)).toBe(false);
      expect(shouldAutoInstallRuntimeServiceFromPath(installedCliPath)).toBe(true);
      expect(localReleaseBuildOutputRuntimeBlock(installedCliPath)).toBeNull();

      process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL = "1";
      expect(shouldAutoInstallRuntimeServiceFromPath(releaseCliPath)).toBe(true);
      expect(localReleaseBuildOutputRuntimeBlock(releaseCliPath)).toBeNull();
    } finally {
      if (originalAllow === undefined) delete process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;
      else process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL = originalAllow;
    }
  });

  it("records skipped service install status for local release build output paths", async () => {
    const releaseCliPath = "/Users/admin/Projects/ADE/apps/desktop/release-beta/mac-arm64/ADE Beta.app/Contents/Resources/ade-cli/cli.cjs";
    const originalCliJs = process.env.ADE_CLI_JS;
    const originalAllow = process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);

    try {
      process.env.ADE_CLI_JS = releaseCliPath;
      delete process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;
      await pool.installServiceBestEffort();

      expect(pool.getStatus().serviceInstall).toMatchObject({
        state: "skipped",
        attempted: false,
        path: releaseCliPath,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "local_runtime.service_install_skipped",
        expect.objectContaining({
          cliPath: releaseCliPath,
          reason: "local_release_build_output",
        }),
      );
    } finally {
      pool.dispose();
      if (originalCliJs === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalCliJs;
      if (originalAllow === undefined) delete process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;
      else process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL = originalAllow;
    }
  });

  it("skips service install when a newer compatible brain is already running", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-install-skip-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const daemonEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_CLI_VERSION: "2.0.0",
      // A real desktop-spawned brain always runs with the CTO role. Pin it
      // here instead of inheriting ADE_DEFAULT_ROLE from the test host: ADE
      // sessions set it on macOS, while GitHub's Linux runner does not.
      ADE_DEFAULT_ROLE: "cto",
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const daemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: daemonEnv,
      socketPath,
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pool = new LocalRuntimeConnectionPool("1.0.0", logger as never, {
      queryServiceStatus: runningTestServiceStatus,
    });

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = daemonEnv.NODE_OPTIONS;

      await pool.installServiceBestEffort();

      expect(pool.getStatus()).toMatchObject({
        versionSkew: {
          state: "none",
          appVersion: "1.0.0",
          runtimeVersion: null,
        },
        serviceInstall: {
          state: "skipped",
          attempted: false,
          path: cliPath,
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        "local_runtime.service_install_skipped",
        expect.objectContaining({
          reason: "compatible_newer_runtime",
          runtimeVersion: "2.0.0",
          appVersion: "1.0.0",
        }),
      );
    } finally {
      pool.dispose();
      await shutdownRuntime(socketPath);
      if (!daemon.killed) daemon.kill("SIGKILL");
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("logs child runtime stderr by line and flushes partial output", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const output = createLocalRuntimeOutputLogger({
      logger,
      socketPath: "/tmp/ade.sock",
      pid: 123,
      stream: "stderr",
    });

    output.push(Buffer.from("first line\npartial"));
    output.push(" rest");
    output.flush();

    expect(logger.warn).toHaveBeenNthCalledWith(1, "local_runtime.stderr", {
      socketPath: "/tmp/ade.sock",
      pid: 123,
      line: "first line",
    });
    expect(logger.warn).toHaveBeenNthCalledWith(2, "local_runtime.stderr", {
      socketPath: "/tmp/ade.sock",
      pid: 123,
      line: "partial rest",
      partial: true,
    });
  });

  it("caps very long runtime output lines before writing logs", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const output = createLocalRuntimeOutputLogger({
      logger,
      socketPath: "/tmp/ade.sock",
      pid: 123,
      stream: "stdout",
    });

    output.push(`${"x".repeat(4_100)}\n`);

    expect(logger.info).toHaveBeenCalledWith("local_runtime.stdout", {
      socketPath: "/tmp/ade.sock",
      pid: 123,
      line: "x".repeat(4_000),
      truncated: true,
      originalChars: 4_100,
    });
  });

  it("reports local ADE service install and connection status", () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, {
      queryServiceStatus: () => ({
        ok: true,
        serviceName: "com.ade.runtime",
        action: "status",
        installed: true,
        running: true,
        path: "/tmp/com.ade.runtime.plist",
        message: "ADE service is running.",
      }),
    });

    expect(pool.getStatus()).toMatchObject({
      connectionState: "idle",
      pid: null,
      syncPort: null,
      publishHealth: null,
      lastWedge: null,
      versionSkew: {
        state: "none",
      },
      serviceInstall: {
        state: "not_attempted",
        attempted: false,
      },
      serviceHealth: {
        state: "running",
        installed: true,
        running: true,
        path: "/tmp/com.ade.runtime.plist",
      },
    });

    pool.noteServiceInstallSkipped("Disabled for this test.");
    (pool as unknown as { activeClient: unknown }).activeClient = {};

    expect(pool.getStatus()).toMatchObject({
      connectionState: "connected",
      serviceInstall: {
        state: "skipped",
        attempted: false,
        message: "Disabled for this test.",
      },
      serviceHealth: {
        state: "running",
      },
    });
  });

  it("parses and carries runtime recovery health onto LocalRuntimeStatus", () => {
    const parsed = readLocalRuntimeInfo({
      runtimeInfo: {
        version: "1.2.35",
        buildHash: "build",
        defaultRole: "cto",
        pid: 4321,
        syncPort: 8789,
        publishHealth: {
          state: "http_timeout",
          failingSinceMs: 123_000,
          lastLegDurations: { snapshot: 12, token: 34, http: 9_200 },
        },
        lastWedge: {
          lastCommand: "chat.send",
          blockedMs: 16_500,
          ts: "2026-07-23T12:00:00.000Z",
        },
        minCompatibleProtocol: 1,
        protocolVersion: 1,
      },
    });
    const pool = new LocalRuntimeConnectionPool("1.2.35", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const internals = pool as unknown as {
      activeClient: unknown;
      activeRuntimePid: number | null;
      activeRuntimeSyncPort: number | null;
      activeRuntimePublishHealth: typeof parsed.publishHealth;
      activeRuntimeLastWedge: typeof parsed.lastWedge;
    };
    internals.activeClient = {};
    internals.activeRuntimePid = parsed.pid;
    internals.activeRuntimeSyncPort = parsed.syncPort;
    internals.activeRuntimePublishHealth = parsed.publishHealth;
    internals.activeRuntimeLastWedge = parsed.lastWedge;

    expect(pool.getStatus()).toMatchObject({
      connectionState: "connected",
      pid: 4321,
      syncPort: 8789,
      publishHealth: {
        state: "http_timeout",
        failingSinceMs: 123_000,
        lastLegDurations: { snapshot: 12, token: 34, http: 9_200 },
      },
      lastWedge: {
        lastCommand: "chat.send",
        blockedMs: 16_500,
        ts: "2026-07-23T12:00:00.000Z",
      },
    });
    pool.dispose();
  });

  it("refreshes live publish and wedge health when status is read", async () => {
    const onRuntimeStatusChange = vi.fn();
    const call = vi.fn(async () => ({
      runtimeInfo: {
        version: "1.2.35",
        pid: 4321,
        syncPort: 8789,
        publishHealth: {
          state: "http_timeout",
          failingSinceMs: 456_000,
          lastLegDurations: { snapshot: 15, token: 45, http: 9_500 },
        },
        lastWedge: {
          lastCommand: "chat.send",
          blockedMs: 17_000,
          ts: "2026-07-23T13:00:00.000Z",
        },
      },
    }));
    const pool = new LocalRuntimeConnectionPool("1.2.35", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, {
      queryServiceStatus: runningTestServiceStatus,
      onRuntimeStatusChange,
    });
    (pool as unknown as { activeClient: unknown }).activeClient = { call };

    const status = await pool.getFreshStatus();

    expect(call).toHaveBeenCalledWith("runtime/info", {}, { timeoutMs: 2_000 });
    expect(status).toMatchObject({
      connectionState: "connected",
      pid: 4321,
      syncPort: 8789,
      publishHealth: {
        state: "http_timeout",
        failingSinceMs: 456_000,
        lastLegDurations: { snapshot: 15, token: 45, http: 9_500 },
      },
      lastWedge: {
        lastCommand: "chat.send",
        blockedMs: 17_000,
        ts: "2026-07-23T13:00:00.000Z",
      },
    });
    expect(onRuntimeStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      lastWedge: expect.objectContaining({ lastCommand: "chat.send" }),
    }));
    pool.dispose();
  });

  it("retries the service install from isolated recovery and reports runtime mode transitions", async () => {
    const modeChanges: string[] = [];
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, {
      preferServiceRepair: true,
      onRuntimeModeChange: (mode) => modeChanges.push(mode),
    });
    const internals = pool as unknown as {
      activeConnection: { client: unknown; child: null; socketPath: string } | null;
      probeCompatibleRuntime: (socketPath: string) => Promise<boolean>;
      installServiceBestEffort: () => Promise<void>;
      scheduleIsolatedRuntimeRecovery: (primarySocketPath: string) => void;
      tryRecoverFromIsolatedRuntime: (primarySocketPath: string) => Promise<void>;
      lastIsolatedServiceRepairMs: number;
    };
    const installSpy = vi.fn(async () => {});
    internals.installServiceBestEffort = installSpy;
    internals.probeCompatibleRuntime = async () => false;
    internals.activeConnection = { client: {}, child: null, socketPath: "/tmp/ade-isolated.sock" };

    internals.scheduleIsolatedRuntimeRecovery("/tmp/ade.sock");
    expect(modeChanges).toEqual(["isolated"]);
    expect(pool.getStatus().runtimeMode).toBe("isolated");

    // A failed probe re-attempts the service install once per cooldown window.
    await internals.tryRecoverFromIsolatedRuntime("/tmp/ade.sock");
    expect(installSpy).toHaveBeenCalledTimes(1);
    await internals.tryRecoverFromIsolatedRuntime("/tmp/ade.sock");
    expect(installSpy).toHaveBeenCalledTimes(1);
    internals.lastIsolatedServiceRepairMs = 0;
    await internals.tryRecoverFromIsolatedRuntime("/tmp/ade.sock");
    expect(installSpy).toHaveBeenCalledTimes(2);

    // Landing back on the primary socket announces the recovery exactly once.
    internals.activeConnection = { client: {}, child: null, socketPath: "/tmp/ade.sock" };
    await internals.tryRecoverFromIsolatedRuntime("/tmp/ade.sock");
    expect(modeChanges).toEqual(["isolated", "primary"]);
    expect(pool.getStatus().runtimeMode).toBe("primary");

    pool.dispose();
  });

  it("parses structured service manager output for settings status", () => {
    expect(parseRuntimeServiceManagerOutput(JSON.stringify({
      ok: false,
      serviceName: "com.ade.runtime",
      action: "status",
      installed: true,
      running: false,
      path: "/Users/admin/Library/LaunchAgents/com.ade.runtime.plist",
      message: "launchctl failed",
    }))).toEqual({
      ok: false,
      path: "/Users/admin/Library/LaunchAgents/com.ade.runtime.plist",
      message: "launchctl failed",
    });

    expect(parseRuntimeServiceManagerOutput("not json")).toBeNull();
  });

  it("disposes the desktop client without shutting down the ADE service", async () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const client = {
      call: vi.fn(),
      close: vi.fn(),
    };
    (pool as unknown as { connection: Promise<unknown>; activeClient: unknown }).connection = Promise.resolve({
      client,
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    (pool as unknown as { activeClient: unknown }).activeClient = client;

    pool.dispose();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.call).not.toHaveBeenCalledWith("shutdown", expect.anything());
    expect(pool.getStatus().connectionState).toBe("idle");
  });

  it("clears stale client and project state when an app-owned runtime exits", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-exit-"));
    const cliPath = path.join(tempDir, "cli.cjs");
    const socketPath = path.join(tempDir, "ade.sock");
    const originalAdeCliJs = process.env.ADE_CLI_JS;
    fs.writeFileSync(cliPath, "setTimeout(() => process.exit(0), 50);\n", "utf8");
    process.env.ADE_CLI_JS = cliPath;

    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const rootPath = path.resolve("/repo");
    const client = { close: vi.fn() };
    let child: ChildProcess | null = null;

    try {
      child = (pool as unknown as {
        spawnRuntime: (path: string) => ChildProcess;
      }).spawnRuntime(socketPath);
      (pool as unknown as { connection: Promise<unknown>; activeClient: unknown }).connection = Promise.resolve({
        client,
        child,
        socketPath,
      });
      (pool as unknown as { activeClient: unknown }).activeClient = client;
      (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
        projectId: "project-1",
        rootPath,
        displayName: "repo",
        addedAt: 1,
        lastOpenedAt: 1,
        gitOriginUrl: null,
      });

      expect(pool.getStatus().connectionState).toBe("connected");

      await new Promise<void>((resolve, reject) => {
        child?.once("exit", () => resolve());
        child?.once("error", reject);
      });

      expect(pool.getStatus().connectionState).toBe("idle");
      expect((pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.size).toBe(0);
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      if (child && !child.killed) child.kill();
      if (originalAdeCliJs === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalAdeCliJs;
      removeTempDir(tempDir);
    }
  });

  it("does not clear a replacement connection when a superseded owned runtime exits", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-superseded-"));
    const oldCliPath = path.join(tempDir, "old-cli.cjs");
    const replacementCliPath = path.join(tempDir, "replacement-cli.cjs");
    const socketPath = path.join(tempDir, "ade.sock");
    const replacementSocketPath = path.join(tempDir, "ade-replacement.sock");
    const originalAdeCliJs = process.env.ADE_CLI_JS;
    fs.writeFileSync(oldCliPath, "setTimeout(() => process.exit(0), 100);\n", "utf8");
    fs.writeFileSync(replacementCliPath, "setInterval(() => {}, 1000);\n", "utf8");

    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const rootPath = path.resolve("/repo");
    const replacementClient = { close: vi.fn() };
    let oldChild: ChildProcess | null = null;
    let replacementChild: ChildProcess | null = null;

    try {
      const spawnRuntime = (pool as unknown as {
        spawnRuntime: (path: string) => ChildProcess;
      }).spawnRuntime.bind(pool);
      process.env.ADE_CLI_JS = oldCliPath;
      oldChild = spawnRuntime(socketPath);
      process.env.ADE_CLI_JS = replacementCliPath;
      replacementChild = spawnRuntime(replacementSocketPath);
      (pool as unknown as { connection: Promise<unknown>; activeClient: unknown }).connection = Promise.resolve({
        client: replacementClient,
        child: replacementChild,
        socketPath: replacementSocketPath,
      });
      (pool as unknown as { activeClient: unknown }).activeClient = replacementClient;
      (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
        projectId: "project-1",
        rootPath,
        displayName: "repo",
        addedAt: 1,
        lastOpenedAt: 1,
        gitOriginUrl: null,
      });

      await new Promise<void>((resolve, reject) => {
        oldChild?.once("exit", () => resolve());
        oldChild?.once("error", reject);
      });

      expect(pool.getStatus().connectionState).toBe("connected");
      expect((pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.size).toBe(1);
      expect(replacementClient.close).not.toHaveBeenCalled();
    } finally {
      if (oldChild && !oldChild.killed) oldChild.kill();
      if (replacementChild && !replacementChild.killed) replacementChild.kill();
      if (originalAdeCliJs === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalAdeCliJs;
      removeTempDir(tempDir);
    }
  });

  it("does not let a stale dropped connection clear an in-flight reconnect", () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const reconnect = new Promise<unknown>(() => {});
    const staleClient = { close: vi.fn() };
    const staleEntry = {
      client: staleClient,
      child: null,
      socketPath: "/tmp/old-ade.sock",
    };
    (pool as unknown as {
      connection: Promise<unknown>;
      activeClient: unknown;
      activeConnection: unknown;
    }).connection = reconnect;
    (pool as unknown as { activeClient: unknown }).activeClient = null;
    (pool as unknown as { activeConnection: unknown }).activeConnection = null;

    (pool as unknown as {
      resetActiveConnection: (entry: typeof staleEntry) => void;
    }).resetActiveConnection(staleEntry);

    expect((pool as unknown as { connection: Promise<unknown> | null }).connection).toBe(reconnect);
    expect(staleClient.close).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale timed-out action clear or close an in-flight reconnect", async () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const rootPath = path.resolve("/repo");
    const reconnect = new Promise<unknown>(() => {});
    let rejectAction!: (error: Error) => void;
    const staleClient = {
      call: vi.fn(() => new Promise((_resolve, reject) => {
        rejectAction = reject;
      })),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const staleEntry = {
      client: staleClient,
      child: null,
      socketPath: "/tmp/old-ade.sock",
    };
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as {
      connection: Promise<unknown>;
      activeClient: unknown;
      activeConnection: unknown;
    }).connection = Promise.resolve(staleEntry);
    (pool as unknown as { activeClient: unknown }).activeClient = staleClient;
    (pool as unknown as { activeConnection: unknown }).activeConnection = staleEntry;

    const pending = pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "deleteSession",
      args: { sessionId: "chat-1" },
    });
    while (staleClient.call.mock.calls.length === 0) await Promise.resolve();

    (pool as unknown as { connection: Promise<unknown> }).connection = reconnect;
    (pool as unknown as { activeClient: unknown }).activeClient = null;
    (pool as unknown as { activeConnection: unknown }).activeConnection = null;
    rejectAction(new Error(
      "Remote ADE service timed out waiting for method ade/actions/call (30000ms).",
    ));

    await expect(pending).rejects.toThrow(/timed out waiting for method ade\/actions\/call/i);
    expect((pool as unknown as { connection: Promise<unknown> | null }).connection).toBe(reconnect);
    expect(staleClient.close).not.toHaveBeenCalled();
  });

  it("does not attach a stale owned child when connecting to an external runtime", async () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const child = {
      pid: 1234,
      kill: vi.fn(),
      once: vi.fn(),
    };
    const client = { call: vi.fn(), close: vi.fn(), isClosed: vi.fn(() => false) };
    (pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild = child;
    (pool as unknown as { connectClient: (socketPath: string) => Promise<unknown> }).connectClient = vi.fn(async () => client);

    const entry = await (pool as unknown as {
      tryConnect: (socketPath: string) => Promise<{ client: unknown; child: unknown; socketPath: string } | null>;
    }).tryConnect("/tmp/ade.sock");

    expect(entry?.client).toBe(client);
    expect(entry?.child).toBeNull();
    expect((pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild).toBeNull();
  });

  it("normalizes local action registry entries from runtime action names", async () => {
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const client = {
      call: vi.fn(async () => ({
        ok: true,
        actions: [
          { domain: "git", action: "push", name: "git.push", description: "Push changes" },
          { domain: "git", action: "status", name: "git.status" },
          { domain: "chat", action: "create", name: "chat.create" },
        ],
      })),
      close: vi.fn(),
    };
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot = new Map([
      [path.resolve("/repo"), { projectId: "project-1", rootPath: path.resolve("/repo") }],
    ]);
    (pool as unknown as { connection: Promise<unknown>; activeClient: unknown }).connection = Promise.resolve({
      client,
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    (pool as unknown as { activeClient: unknown }).activeClient = client;

    const registry = await pool.listActionRegistryForRoot("/repo");

    expect(client.call).toHaveBeenCalledWith(
      "ade/actions/call",
      {
        projectId: "project-1",
        name: "list_ade_actions",
        arguments: { domain: "all" },
      },
      { timeoutMs: LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS },
    );
    expect(registry).toEqual([
      { domain: "chat", actions: [{ name: "create" }] },
      {
        domain: "git",
        actions: [
          { name: "push", description: "Push changes" },
          { name: "status" },
        ],
      },
    ]);
    pool.dispose();
  });

  it("coalesces matching local runtime action calls while the first call is in flight", async () => {
    let resolveCall!: (value: unknown) => void;
    const call = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    }));
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    const first = pool.callActionForRoot(rootPath, {
      domain: "session",
      action: "list",
      args: { limit: 500, laneId: "lane-1" },
    });
    const second = pool.callActionForRoot(rootPath, {
      domain: "session",
      action: "list",
      args: { laneId: "lane-1", limit: 500 },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(call).toHaveBeenCalledTimes(1);

    resolveCall({
      domain: "session",
      action: "list",
      result: [{ id: "session-1" }],
      statusHints: {},
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        domain: "session",
        action: "list",
        result: [{ id: "session-1" }],
        statusHints: {},
      },
      {
        domain: "session",
        action: "list",
        result: [{ id: "session-1" }],
        statusHints: {},
      },
    ]);

    call.mockResolvedValueOnce({
      domain: "session",
      action: "list",
      result: [{ id: "session-1" }],
      statusHints: {},
    });
    await pool.callActionForRoot(rootPath, {
      domain: "session",
      action: "list",
      args: { limit: 500, laneId: "lane-1" },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("single-flights initial project registration without dropping or reordering PTY writes", async () => {
    let resolveRegistration!: (value: unknown) => void;
    const registration = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const deliveredInput: string[] = [];
    const call = vi.fn((method: string, params?: unknown) => {
      if (method === "projects.add") return registration;
      if (method === "ade/actions/call") {
        const data = (params as {
          arguments?: { args?: { data?: unknown } };
        }).arguments?.args?.data;
        if (typeof data !== "string") throw new Error("PTY write data is missing.");
        deliveredInput.push(data);
        return Promise.resolve({
          domain: "pty",
          action: "write",
          result: null,
          statusHints: {},
        });
      }
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    const inputChunks = ["a", "\x1b", "\r"];
    const rootPaths = [rootPath, `${rootPath}/.`, `${rootPath}/nested/..`];

    const writes = inputChunks.map((data, index) => pool.callActionForRoot(rootPaths[index]!, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(0);
    expect(deliveredInput).toEqual([]);

    resolveRegistration(project);
    await expect(Promise.all(writes)).resolves.toHaveLength(inputChunks.length);

    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(inputChunks.length);
    expect(deliveredInput).toEqual(inputChunks);
    expect(deliveredInput.join("")).toBe(inputChunks.join(""));
  });

  it("lets foreground recent registration satisfy PTY routing after a project switch", async () => {
    let resolveRegistration!: (value: unknown) => void;
    const registration = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
      catalogVisibility: "recent",
      registrationSource: "desktop",
    } as const;
    const deliveredInput: string[] = [];
    const call = vi.fn((method: string, params?: unknown) => {
      if (method === "projects.add") return registration;
      if (method === "ade/actions/call") {
        const data = (params as {
          arguments?: { args?: { data?: unknown } };
        }).arguments?.args?.data;
        if (typeof data !== "string") throw new Error("PTY write data is missing.");
        deliveredInput.push(data);
        return Promise.resolve({
          domain: "pty",
          action: "write",
          result: null,
          statusHints: {},
        });
      }
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    // Foregrounding mirrors the desktop-recent intent. Terminal input can
    // arrive immediately afterward with the internal system/runtime-auto
    // intent used by action routing.
    const foreground = pool.ensureProject(rootPath, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    const writes = ["a", "b", "\r"].map((data) => pool.callActionForRoot(rootPath, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(0);

    resolveRegistration(project);
    await expect(Promise.all([foreground, ...writes])).resolves.toHaveLength(4);

    // The authoritative foreground record now satisfies background routing;
    // no second projects.add is inserted before the individual PTY writes.
    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(3);
    expect(deliveredInput).toEqual(["a", "b", "\r"]);
  });

  it("preserves registration intent order after a conflicting waiter closes the active flight", async () => {
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const registrations: Array<{
      params: Record<string, unknown>;
      resolve: (value: unknown) => void;
    }> = [];
    const call = vi.fn((method: string, params?: unknown) => {
      if (method !== "projects.add") {
        return Promise.reject(new Error(`Unexpected method ${method}`));
      }
      return new Promise<unknown>((resolve) => {
        registrations.push({ params: params as Record<string, unknown>, resolve });
      });
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    const desktopIntent = {
      catalogVisibility: "recent" as const,
      registrationSource: "desktop" as const,
    };
    const mobileIntent = {
      catalogVisibility: "recent" as const,
      registrationSource: "mobile" as const,
    };

    const firstDesktop = pool.ensureProject(rootPath, desktopIntent);
    while (registrations.length < 1) await Promise.resolve();
    const mobile = pool.ensureProject(rootPath, mobileIntent);
    const secondDesktop = pool.ensureProject(rootPath, desktopIntent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.params.registrationSource).toBe("desktop");

    registrations[0]!.resolve({ ...project, ...desktopIntent });
    while (registrations.length < 2) await Promise.resolve();
    expect(registrations.map(({ params }) => params.registrationSource))
      .toEqual(["desktop", "mobile"]);

    registrations[1]!.resolve({ ...project, ...mobileIntent });
    while (registrations.length < 3) await Promise.resolve();
    expect(registrations.map(({ params }) => params.registrationSource))
      .toEqual(["desktop", "mobile", "desktop"]);

    registrations[2]!.resolve({ ...project, ...desktopIntent });
    await expect(Promise.all([firstDesktop, mobile, secondDesktop])).resolves.toHaveLength(3);
    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(3);
  });

  it("clears a failed project registration single-flight so the next action retries", async () => {
    let rejectRegistration!: (error: Error) => void;
    const firstRegistration = new Promise<unknown>((_resolve, reject) => {
      rejectRegistration = reject;
    });
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    let registrationAttempts = 0;
    const deliveredInput: string[] = [];
    const call = vi.fn((method: string, params?: unknown) => {
      if (method === "projects.add") {
        registrationAttempts += 1;
        return registrationAttempts === 1 ? firstRegistration : Promise.resolve(project);
      }
      if (method === "ade/actions/call") {
        const data = (params as {
          arguments?: { args?: { data?: unknown } };
        }).arguments?.args?.data;
        if (typeof data !== "string") throw new Error("PTY write data is missing.");
        deliveredInput.push(data);
        return Promise.resolve({
          domain: "pty",
          action: "write",
          result: null,
          statusHints: {},
        });
      }
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    const first = pool.callActionForRoot(rootPath, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data: "first" },
    });
    const shared = pool.callActionForRoot(`${rootPath}/.`, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data: "shared" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(registrationAttempts).toBe(1);

    rejectRegistration(new Error("project registration failed"));
    const failures = await Promise.allSettled([first, shared]);
    expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(failures.map((result) => result.status === "rejected" ? result.reason.message : null))
      .toEqual(["project registration failed", "project registration failed"]);
    expect(deliveredInput).toEqual([]);

    await expect(pool.callActionForRoot(rootPath, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data: "retry" },
    })).resolves.toMatchObject({ domain: "pty", action: "write", result: null });

    expect(registrationAttempts).toBe(2);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(1);
    expect(deliveredInput).toEqual(["retry"]);
  });

  it("keeps project registration single-flighted while retrying a dropped connection", async () => {
    const dropped = new Error("Remote ADE service connection closed.");
    let resolveRetry!: (value: unknown) => void;
    const retryRegistration = new Promise<unknown>((resolve) => {
      resolveRetry = resolve;
    });
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const deliveredInput: string[] = [];
    const firstClient = {
      call: vi.fn().mockRejectedValue(dropped),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const secondClient = {
      call: vi.fn((method: string, params?: unknown) => {
        if (method === "projects.add") return retryRegistration;
        if (method === "ade/actions/call") {
          const data = (params as {
            arguments?: { args?: { data?: unknown } };
          }).arguments?.args?.data;
          if (typeof data !== "string") throw new Error("PTY write data is missing.");
          deliveredInput.push(data);
          return Promise.resolve({ domain: "pty", action: "write", result: null, statusHints: {} });
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      }),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const createConnection = vi.fn<[], Promise<unknown>>()
      .mockResolvedValueOnce({ client: firstClient, child: null, socketPath: "/tmp/ade-stale.sock" })
      .mockResolvedValueOnce({ client: secondClient, child: null, socketPath: "/tmp/ade-fresh.sock" });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { createConnection: () => Promise<unknown> }).createConnection = createConnection;

    const write = (data: string) => pool.callActionForRoot(rootPath, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data },
    });
    const first = write("first");
    while (!secondClient.call.mock.calls.some(([method]) => method === "projects.add")) {
      await Promise.resolve();
    }
    const writes = [first, write("second"), write("third")];
    await new Promise((resolve) => setImmediate(resolve));

    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(secondClient.call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);

    resolveRetry(project);
    await expect(Promise.all(writes)).resolves.toHaveLength(3);

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(secondClient.call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(3);
    expect(deliveredInput).toEqual(["first", "second", "third"]);
  });

  it("makes disposal terminal while project registration is in flight", async () => {
    let resolveRegistration!: (value: unknown) => void;
    const registration = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const call = vi.fn((method: string) => {
      if (method === "projects.add") return registration;
      if (method === "ade/actions/call") {
        return Promise.resolve({ domain: "pty", action: "write", result: null, statusHints: {} });
      }
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const client = {
      call,
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const createConnection = vi.fn(async () => ({
      client,
      child: null,
      socketPath: "/tmp/ade.sock",
    }));
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    (pool as unknown as { createConnection: () => Promise<unknown> }).createConnection = createConnection;

    const pendingWrite = pool.callActionForRoot(rootPath, {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-1", data: "blocked" },
    });
    while (!call.mock.calls.some(([method]) => method === "projects.add")) {
      await Promise.resolve();
    }

    pool.dispose();
    resolveRegistration(project);

    await expect(pendingWrite).rejects.toThrow("Local runtime connection pool is disposed.");
    await expect(pool.ensureProject(rootPath)).rejects.toThrow(
      "Local runtime connection pool is disposed.",
    );
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter(([method]) => method === "projects.add")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(0);
    expect((pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot).toHaveLength(0);
    expect(
      (pool as unknown as { projectRegistrationsByRoot: Map<string, unknown> }).projectRegistrationsByRoot,
    ).toHaveLength(0);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("single-flights an exact lane delete and keeps its client timeout above daemon work", async () => {
    let resolveCall!: (value: unknown) => void;
    const call = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    }));
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    const request = {
      domain: "lane",
      action: "delete",
      args: { laneId: "lane-1", force: true, deleteRemoteBranch: true },
    };

    const first = pool.callActionForRoot(rootPath, request);
    const duplicate = pool.callActionForRoot(rootPath, {
      ...request,
      args: { deleteRemoteBranch: true, force: true, laneId: "lane-1" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({ domain: "lane", action: "delete" }),
      }),
      { timeoutMs: 4 * 60_000 },
    );

    resolveCall({ domain: "lane", action: "delete", result: null, statusHints: {} });
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("extends archive mutations while preserving a single delivery attempt", async () => {
    const call = vi.fn().mockResolvedValue({
      domain: "lane",
      action: "archive",
      result: null,
      statusHints: {},
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1", rootPath, displayName: "repo", addedAt: 1, lastOpenedAt: 1, gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) }, child: null, socketPath: "/tmp/ade.sock",
    });

    await pool.callActionForRoot(rootPath, {
      domain: "lane",
      action: "archive",
      args: { laneId: "lane-1" },
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "ade/actions/call",
      expect.anything(),
      { timeoutMs: 120_000 },
    );
  });

  it("retries project registration when the cached runtime connection drops before a read action", async () => {
    const dropped = new Error("Remote ADE service connection closed.");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const firstClient = {
      call: vi.fn().mockRejectedValue(dropped),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const secondClient = {
      call: vi.fn(async (method: string) => {
        if (method === "projects.add") return project;
        if (method === "ade/actions/call") {
          return {
            domain: "lane",
            action: "list",
            result: [{ id: "lane-1" }],
            statusHints: {},
          };
        }
        throw new Error(`Unexpected method ${method}`);
      }),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const firstEntry = {
      client: firstClient,
      child: null,
      socketPath: "/tmp/ade-stale.sock",
    };
    const secondEntry = {
      client: secondClient,
      child: null,
      socketPath: "/tmp/ade-fresh.sock",
    };
    const createConnection = vi.fn<[], Promise<unknown>>()
      .mockResolvedValueOnce(firstEntry)
      .mockResolvedValueOnce(secondEntry);
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);
    (pool as unknown as { createConnection: () => Promise<unknown> }).createConnection = createConnection;

    await expect(pool.callActionForRoot(rootPath, {
      domain: "lane",
      action: "list",
      args: {},
    })).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-1" }],
      statusHints: {},
    });

    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith(
      "projects.add",
      { rootPath, catalogVisibility: "system", registrationSource: "runtime-auto" },
      { timeoutMs: 120_000 },
    );
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenNthCalledWith(
      1,
      "projects.add",
      { rootPath, catalogVisibility: "system", registrationSource: "runtime-auto" },
      { timeoutMs: 120_000 },
    );
    expect(secondClient.call).toHaveBeenNthCalledWith(
      2,
      "ade/actions/call",
      {
        projectId: "project-1",
        name: "run_ade_action",
        arguments: {
          domain: "lane",
          action: "list",
          args: {},
        },
      },
      { timeoutMs: 30_000 },
    );
    expect(logger.warn).toHaveBeenCalledWith("local_runtime.ensure_project_connection_dropped", {
      rootPath,
      socketPath: "/tmp/ade-stale.sock",
      attempt: 1,
      willRetry: true,
      error: dropped.message,
    });
  });

  it("propagates a read timeout without resetting or retrying the shared client", async () => {
    const timedOut = new Error(
      "Remote ADE service timed out waiting for method ade/actions/call (30000ms).",
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    let actionCalls = 0;
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "projects.add") return project;
        if (method === "ade/actions/call") {
          actionCalls += 1;
          if (actionCalls === 1) throw timedOut;
          return {
            domain: "lane",
            action: "list",
            result: [{ id: "lane-1" }],
            statusHints: {},
          };
        }
        throw new Error(`Unexpected method ${method}`);
      }),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const entry = {
      client,
      child: null,
      socketPath: "/tmp/ade-timeout.sock",
    };
    const createConnection = vi.fn<[], Promise<unknown>>().mockResolvedValue(entry);
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);
    (pool as unknown as { createConnection: () => Promise<unknown> }).createConnection = createConnection;

    await expect(pool.callActionForRoot(rootPath, {
      domain: "lane",
      action: "list",
      args: {},
    })).rejects.toThrow(timedOut.message);

    await expect(pool.callActionForRoot(rootPath, {
      domain: "lane",
      action: "list",
      args: {},
    })).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-1" }],
      statusHints: {},
    });

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.call).toHaveBeenLastCalledWith(
      "ade/actions/call",
      expect.objectContaining({ name: "run_ade_action" }),
      { timeoutMs: 30_000 },
    );
    expect(actionCalls).toBe(2);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "local_runtime.action_connection_dropped",
      expect.anything(),
    );
  });

  it("reconnects before project registration when the runtime client is already closed", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const firstClient = {
      call: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => true),
    };
    const secondClient = {
      call: vi.fn().mockResolvedValue(project),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const createConnection = vi.fn<[], Promise<unknown>>()
      .mockResolvedValueOnce({
        client: firstClient,
        child: null,
        socketPath: "/tmp/ade-closed.sock",
      })
      .mockResolvedValueOnce({
        client: secondClient,
        child: null,
        socketPath: "/tmp/ade-open.sock",
      });
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);
    (pool as unknown as { createConnection: () => Promise<unknown> }).createConnection = createConnection;

    // ensureProject coerces the record, which stamps a null icon by default.
    await expect(pool.ensureProject(rootPath)).resolves.toEqual({
      ...project,
      icon: null,
    });

    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstClient.call).not.toHaveBeenCalled();
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenCalledWith(
      "projects.add",
      { rootPath, catalogVisibility: "system", registrationSource: "runtime-auto" },
      { timeoutMs: 120_000 },
    );
    expect(logger.warn).toHaveBeenCalledWith("local_runtime.ensure_project_connection_dropped", {
      rootPath,
      socketPath: "/tmp/ade-closed.sock",
      attempt: 1,
      willRetry: true,
      error: "Remote ADE service connection closed.",
    });
  });

  it("terminates an app-owned fallback runtime when disposed", async () => {
    vi.useFakeTimers();
    const child = {
      pid: 24680,
      kill: vi.fn(),
      once: vi.fn(),
    } as unknown as ChildProcess;
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never, { disableSync: true });
    const client = {
      call: vi.fn(),
      close: vi.fn(),
    };
    (pool as unknown as { connection: Promise<unknown>; activeClient: unknown }).connection = Promise.resolve({
      client,
      child,
      socketPath: "/tmp/ade-owned-runtime.sock",
    });
    (pool as unknown as { activeClient: unknown }).activeClient = client;

    try {
      pool.dispose();
      await Promise.resolve();

      expect(client.close).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reattaches to an externally managed machine daemon after the desktop-side client disconnects", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-project-"));
    const expectedProjectRoot = fs.realpathSync.native(projectRoot);
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const expectedBuildHash = computeLocalRuntimeBuildHash(cliPath);
    expect(expectedBuildHash).toBeTruthy();
    const daemonEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_CLI_VERSION: "1.2.3",
      ADE_RUNTIME_BUILD_HASH: expectedBuildHash!,
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const daemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: daemonEnv,
      socketPath,
    });
    let firstPool: LocalRuntimeConnectionPool | null = null;
    let secondPool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = daemonEnv.NODE_OPTIONS;

      firstPool = new LocalRuntimeConnectionPool("1.2.3", logger as never, { disableSync: true });
      const registered = await firstPool.ensureProject(projectRoot);
      firstPool.dispose();

      // Allow the daemon to fully process the first client's socket teardown before
      // reconnecting — without this pause the second connect can race and hit EPIPE.
      await new Promise((resolve) => setTimeout(resolve, 250));

      secondPool = new LocalRuntimeConnectionPool("1.2.3", logger as never, { disableSync: true });
      const projects = await secondPool.projects();

      expect(registered.rootPath).toBe(expectedProjectRoot);
      expect(projects).toContainEqual(expect.objectContaining({
        projectId: registered.projectId,
        rootPath: expectedProjectRoot,
      }));
    } finally {
      firstPool?.dispose();
      secondPool?.dispose();
      await shutdownRuntime(socketPath);
      if (!daemon.killed) daemon.kill("SIGKILL");
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(projectRoot);
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("preserves an incompatible local daemon and starts an isolated runtime when versions diverge", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-version-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-version-project-"));
    const secondProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-version-project-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const baseEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "1.0.0",
      },
      socketPath,
    });
    const oldPid = oldDaemon.pid!;
    expect(oldPid).toBeGreaterThan(0);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;
    let secondPool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = baseEnv.NODE_OPTIONS;

      pool = new LocalRuntimeConnectionPool("2.0.0", logger as never, { disableSync: true });
      const registered = await pool.ensureProject(projectRoot);
      expect(fs.realpathSync(registered.rootPath)).toBe(fs.realpathSync(projectRoot));

      expect(logger.info).toHaveBeenCalledWith("local_runtime.version_mismatch_detected", expect.objectContaining({
        runtimeVersion: "1.0.0",
        appVersion: "2.0.0",
        runtimePid: oldPid,
      }));
      expect(logger.warn).toHaveBeenCalledWith("local_runtime.incompatible_preserved", expect.objectContaining({
        pid: oldPid,
        primarySocketPath: socketPath,
        isolatedSocketPath: expect.any(String),
      }));

      const client = await RawRuntimeSocketClient.connect(socketPath);
      try {
        const initialized = await client.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-version-test",
          identity: { role: "external", callerId: "local-runtime-version-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "1.0.0",
          },
        });
      } finally {
        client.close();
      }

      expect(() => process.kill(oldPid, 0)).not.toThrow();
      const connection = await (pool as unknown as { connection: Promise<{ socketPath: string }> }).connection;
      expect(connection.socketPath).not.toBe(socketPath);
      expect(pool.getStatus()).toMatchObject({
        runtimeMode: "isolated",
        versionSkew: {
          state: "runtime_older",
          appVersion: "2.0.0",
          runtimeVersion: "1.0.0",
        },
      });
      const isolatedClient = await RawRuntimeSocketClient.connect(connection.socketPath);
      try {
        const initialized = await isolatedClient.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-version-isolated-test",
          identity: { role: "external", callerId: "local-runtime-version-isolated-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "2.0.0",
          },
        });
      } finally {
        isolatedClient.close();
      }

      secondPool = new LocalRuntimeConnectionPool("2.0.0", logger as never, { disableSync: true });
      const secondRegistered = await secondPool.ensureProject(secondProjectRoot);
      expect(fs.realpathSync(secondRegistered.rootPath)).toBe(fs.realpathSync(secondProjectRoot));
      const secondConnection = await (secondPool as unknown as { connection: Promise<{ socketPath: string; child: unknown }> }).connection;
      expect(secondConnection.socketPath).toBe(connection.socketPath);
      expect(secondConnection.child).toBeNull();
    } finally {
      secondPool?.dispose();
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!oldDaemon.killed) {
        try { oldDaemon.kill("SIGKILL"); } catch {}
      }
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(projectRoot);
      removeTempDir(secondProjectRoot);
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("connects normally to a newer protocol-compatible local brain", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-newer-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const daemonEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_CLI_VERSION: "2.0.0",
      ADE_DEFAULT_ROLE: "cto",
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const daemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: daemonEnv,
      socketPath,
    });
    const daemonPid = daemon.pid!;
    expect(daemonPid).toBeGreaterThan(0);

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = daemonEnv.NODE_OPTIONS;

      pool = new LocalRuntimeConnectionPool("1.0.0", logger as never, {
        disableSync: true,
        preferServiceRepair: true,
        queryServiceStatus: runningTestServiceStatus,
      });
      const internals = pool as unknown as {
        tryConnect: (socketPath: string) => Promise<{ socketPath: string } | null>;
        tryRepairServiceConnection: (...args: unknown[]) => Promise<unknown>;
      };
      const tryRepair = vi.spyOn(internals, "tryRepairServiceConnection");
      const connection = await internals.tryConnect(socketPath);

      expect(connection?.socketPath).toBe(socketPath);
      expect(tryRepair).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("local_runtime.newer_brain_accepted", expect.objectContaining({
        appVersion: "1.0.0",
        runtimeVersion: "2.0.0",
        runtimePid: daemonPid,
      }));
      expect(pool.getStatus()).toMatchObject({
        versionSkew: {
          state: "none",
          appVersion: "1.0.0",
          runtimeVersion: null,
        },
      });
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!daemon.killed) daemon.kill("SIGKILL");
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("marks semver-equal exact-version mismatches as unknown skew", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-eq-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const daemonEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_CLI_VERSION: "2.0.0+runtime.1",
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const daemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: daemonEnv,
      socketPath,
    });
    const daemonPid = daemon.pid!;
    expect(daemonPid).toBeGreaterThan(0);

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = daemonEnv.NODE_OPTIONS;

      pool = new LocalRuntimeConnectionPool("2.0.0", logger as never, { disableSync: true });
      const internals = pool as unknown as {
        tryConnect: (socketPath: string) => Promise<{ socketPath: string } | null>;
      };
      const connection = await internals.tryConnect(socketPath);

      expect(connection?.socketPath).toBeTruthy();
      expect(connection?.socketPath).not.toBe(socketPath);
      expect(pool.getStatus()).toMatchObject({
        runtimeMode: "isolated",
        versionSkew: {
          state: "unknown",
          appVersion: "2.0.0",
          runtimeVersion: "2.0.0+runtime.1",
        },
      });
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!daemon.killed) daemon.kill("SIGKILL");
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("accepts a dev placeholder-version daemon when the runtime build hash matches", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-dev-version-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-dev-version-project-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const expectedBuildHash = computeLocalRuntimeBuildHash(cliPath);
    expect(expectedBuildHash).toBeTruthy();
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const baseEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const devDaemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "0.0.0",
        ADE_RUNTIME_BUILD_HASH: expectedBuildHash!,
        ADE_DEFAULT_ROLE: "cto",
      },
      socketPath,
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = baseEnv.NODE_OPTIONS;

      pool = new LocalRuntimeConnectionPool("1.0.0-beta.1", logger as never, { disableSync: true });
      const registered = await pool.ensureProject(projectRoot);

      expect(fs.realpathSync(registered.rootPath)).toBe(fs.realpathSync(projectRoot));
      expect(logger.info).not.toHaveBeenCalledWith(
        "local_runtime.version_mismatch_detected",
        expect.anything(),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        "local_runtime.incompatible_preserved",
        expect.anything(),
      );
    } finally {
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!devDaemon.killed) devDaemon.kill();
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(projectRoot);
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("preserves a same-version local daemon and starts an isolated runtime when the packaged runtime build changed", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-build-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-build-project-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const baseEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "1.0.0",
        ADE_RUNTIME_BUILD_HASH: "old-build",
      },
      socketPath,
    });
    const oldPid = oldDaemon.pid!;
    expect(oldPid).toBeGreaterThan(0);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = baseEnv.NODE_OPTIONS;

      const expectedBuildHash = computeLocalRuntimeBuildHash(cliPath);
      expect(expectedBuildHash).toBeTruthy();
      pool = new LocalRuntimeConnectionPool("1.0.0", logger as never, { disableSync: true });
      const registered = await pool.ensureProject(projectRoot);
      expect(fs.realpathSync(registered.rootPath)).toBe(fs.realpathSync(projectRoot));

      expect(logger.info).toHaveBeenCalledWith("local_runtime.build_mismatch_detected", expect.objectContaining({
        runtimeBuildHash: "old-build",
        expectedBuildHash,
        runtimePid: oldPid,
      }));
      expect(logger.warn).toHaveBeenCalledWith("local_runtime.incompatible_preserved", expect.objectContaining({
        pid: oldPid,
        primarySocketPath: socketPath,
        isolatedSocketPath: expect.any(String),
      }));

      const client = await RawRuntimeSocketClient.connect(socketPath);
      try {
        const initialized = await client.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-build-test",
          identity: { role: "external", callerId: "local-runtime-build-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "1.0.0",
            buildHash: "old-build",
          },
        });
      } finally {
        client.close();
      }

      expect(() => process.kill(oldPid, 0)).not.toThrow();
      const connection = await (pool as unknown as { connection: Promise<{ socketPath: string }> }).connection;
      expect(connection.socketPath).not.toBe(socketPath);
      const isolatedClient = await RawRuntimeSocketClient.connect(connection.socketPath);
      try {
        const initialized = await isolatedClient.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-build-isolated-test",
          identity: { role: "external", callerId: "local-runtime-build-isolated-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "1.0.0",
            buildHash: expectedBuildHash,
          },
        });
      } finally {
        isolatedClient.close();
      }
    } finally {
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!oldDaemon.killed) {
        try { oldDaemon.kill("SIGKILL"); } catch {}
      }
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(projectRoot);
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("preserves a same-version local daemon and starts an isolated runtime when its default role is not CTO", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-role-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-role-project-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const expectedBuildHash = computeLocalRuntimeBuildHash(cliPath);
    expect(expectedBuildHash).toBeTruthy();
    const originalEnv = {
      ADE_CLI_JS: process.env.ADE_CLI_JS,
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    const baseEnv = {
      ...process.env,
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath),
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: adeCliRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "1.0.0",
        ADE_RUNTIME_BUILD_HASH: expectedBuildHash!,
        ADE_DEFAULT_ROLE: "agent",
      },
      socketPath,
    });
    const oldPid = oldDaemon.pid!;
    expect(oldPid).toBeGreaterThan(0);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let pool: LocalRuntimeConnectionPool | null = null;

    try {
      await waitForRuntimeSocket(socketPath);
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = baseEnv.NODE_OPTIONS;

      pool = new LocalRuntimeConnectionPool("1.0.0", logger as never, { disableSync: true });
      const registered = await pool.ensureProject(projectRoot);
      expect(fs.realpathSync(registered.rootPath)).toBe(fs.realpathSync(projectRoot));

      expect(logger.info).toHaveBeenCalledWith("local_runtime.role_mismatch_detected", expect.objectContaining({
        runtimeDefaultRole: "agent",
        expectedDefaultRole: "cto",
        runtimePid: oldPid,
      }));
      expect(logger.warn).toHaveBeenCalledWith("local_runtime.incompatible_preserved", expect.objectContaining({
        pid: oldPid,
        primarySocketPath: socketPath,
        isolatedSocketPath: expect.any(String),
      }));

      const client = await RawRuntimeSocketClient.connect(socketPath);
      try {
        const initialized = await client.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-role-test",
          identity: { role: "external", callerId: "local-runtime-role-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "1.0.0",
            buildHash: expectedBuildHash,
            defaultRole: "agent",
          },
        });
      } finally {
        client.close();
      }

      expect(() => process.kill(oldPid, 0)).not.toThrow();
      const connection = await (pool as unknown as { connection: Promise<{ socketPath: string }> }).connection;
      expect(connection.socketPath).not.toBe(socketPath);
      const isolatedClient = await RawRuntimeSocketClient.connect(connection.socketPath);
      try {
        const initialized = await isolatedClient.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-role-isolated-test",
          identity: { role: "external", callerId: "local-runtime-role-isolated-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "1.0.0",
            buildHash: expectedBuildHash,
            defaultRole: "cto",
          },
        });
      } finally {
        isolatedClient.close();
      }
    } finally {
      pool?.dispose();
      await shutdownRuntime(socketPath);
      if (!oldDaemon.killed) {
        try { oldDaemon.kill("SIGKILL"); } catch {}
      }
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
      removeTempDir(projectRoot);
      removeTempDir(adeHome);
    }
  }, 45_000);

  it("streams local runtime events through the project-scoped RPC action", async () => {
    const call = vi.fn().mockResolvedValue({
      events: [
        {
          id: 12,
          timestamp: "2026-05-10T12:00:00.000Z",
          category: "pty",
          payload: { type: "pty_data", event: { ptyId: "pty-1", data: "hello" } },
        },
        { id: "bad", timestamp: "nope", category: "runtime", payload: {} },
      ],
      nextCursor: 13,
      hasMore: true,
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    const result = await pool.streamEventsForRoot(rootPath, {
      cursor: 7.5,
      limit: 2,
      category: "pty",
    });

    expect(call).toHaveBeenCalledWith(
      "ade/actions/call",
      {
        projectId: "project-1",
        name: "stream_events",
        arguments: {
          cursor: 7,
          limit: 2,
          category: "pty",
        },
      },
      { timeoutMs: LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS },
    );
    expect(result).toEqual({
      events: [
        {
          id: 12,
          timestamp: "2026-05-10T12:00:00.000Z",
          category: "pty",
          payload: { type: "pty_data", event: { ptyId: "pty-1", data: "hello" } },
        },
      ],
      nextCursor: 13,
      hasMore: true,
    });
  });

  it("bounds local runtime file actions so UI file calls cannot hit the desktop IPC timeout", async () => {
    const call = vi.fn().mockResolvedValue({
      domain: "file",
      action: "listWorkspaces",
      result: [],
      statusHints: {},
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await expect(pool.callActionForRoot(rootPath, {
      domain: "file",
      action: "listWorkspaces",
      args: {},
    })).resolves.toMatchObject({
      result: [],
      statusHints: {},
    });

    expect(call).toHaveBeenCalledWith(
      "ade/actions/call",
      {
        projectId: "project-1",
        name: "run_ade_action",
        arguments: {
          domain: "file",
          action: "listWorkspaces",
          args: {},
        },
      },
      { timeoutMs: 8_000 },
    );
  });

  it("extends local runtime lane naming actions without changing the default chat timeout", async () => {
    const call = vi.fn().mockResolvedValue({
      domain: "chat",
      action: "suggestLaneNameFromPrompt",
      result: { name: "update-modal-flow" },
      statusHints: {},
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "suggestLaneNameFromPrompt",
      args: { prompt: "Fix update modal flow" },
    });
    await pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "deleteSession",
      args: { sessionId: "chat-1" },
    });

    expect(call).toHaveBeenNthCalledWith(
      1,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "suggestLaneNameFromPrompt",
        }),
      }),
      { timeoutMs: 120_000 },
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "deleteSession",
        }),
      }),
      { timeoutMs: 30_000 },
    );
  });

  // ADE-122 regression: the 30s default action timeout fired a false failure on
  // brief handoffs (AI brief + session creation + first-message dispatch) while
  // the daemon-side handoff kept running to a late "surprise" success.
  it("extends handoff actions beyond the default chat action timeout", async () => {
    const call = vi.fn().mockResolvedValue({
      domain: "chat",
      action: "handoffSession",
      result: {},
      statusHints: {},
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: vi.fn(() => false) },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "handoffSession",
      args: { sourceSessionId: "chat-1", targetModelId: "openai/gpt-5.5", mode: "brief" },
    });
    await pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "prepareCrossMachineHandoff",
      args: { sourceSessionId: "chat-1" },
    });

    expect(call).toHaveBeenNthCalledWith(
      1,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "handoffSession",
        }),
      }),
      { timeoutMs: 120_000 },
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "prepareCrossMachineHandoff",
        }),
      }),
      { timeoutMs: 120_000 },
    );
  });

  it("bounds mutations and propagates their timeout without closing or replaying the client", async () => {
    const timeout = new Error("Remote ADE service timed out waiting for method ade/actions/call (30000ms).");
    const call = vi.fn().mockRejectedValue(timeout);
    const close = vi.fn();
    const child = {
      pid: 1234,
      kill: vi.fn(),
      once: vi.fn(),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    const client = { call, close, isClosed: vi.fn(() => false) };
    const entry = {
      client,
      child,
      socketPath: "/tmp/ade.sock",
    };
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve(entry);
    (pool as unknown as { activeConnection: unknown; activeClient: unknown }).activeConnection = entry;
    (pool as unknown as { activeClient: unknown }).activeClient = client;
    (pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild = child;

    await expect(pool.callActionForRoot(rootPath, {
      domain: "chat",
      action: "deleteSession",
      args: { sessionId: "chat-1" },
    })).rejects.toThrow(/timed out waiting for method ade\/actions\/call/i);

    expect(call).toHaveBeenCalledWith(
      "ade/actions/call",
      {
        projectId: "project-1",
        name: "run_ade_action",
        arguments: {
          domain: "chat",
          action: "deleteSession",
          args: { sessionId: "chat-1" },
        },
      },
      { timeoutMs: 30_000 },
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(await (pool as unknown as { connection: Promise<unknown> }).connection).toBe(entry);
    expect((pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild).toBe(child);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "local_runtime.action_connection_dropped",
      expect.anything(),
    );
  });

  it("does not spawn a primary sync runtime when service repair is configured but unavailable", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never, {
      preferServiceRepair: true,
    });
    const internals = pool as unknown as {
      createConnection: () => Promise<unknown>;
      tryConnect: (socketPath: string) => Promise<unknown>;
      tryRepairServiceConnection: (socketPath: string, reason: "missing") => Promise<unknown>;
      spawnRuntime: (socketPath: string) => ChildProcess;
    };
    const tryConnect = vi.spyOn(internals, "tryConnect").mockResolvedValue(null);
    const tryRepair = vi.spyOn(internals, "tryRepairServiceConnection").mockResolvedValue(null);
    const spawnRuntime = vi.spyOn(internals, "spawnRuntime");

    await expect(internals.createConnection()).rejects.toThrow(
      /refusing to spawn an app-owned sync-enabled brain/i,
    );

    expect(tryConnect).toHaveBeenCalled();
    expect(tryRepair).toHaveBeenCalled();
    expect(spawnRuntime).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "local_runtime.service_repair_fallback_blocked",
      expect.objectContaining({ socketPath: expect.any(String) }),
    );
  });

  it("surfaces a recorded disk failure with crash-loop context when repair remains blocked", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-recovery-report-"));
    const originalAdeHome = process.env.ADE_HOME;
    process.env.ADE_HOME = adeHome;
    try {
      for (let count = 0; count < 4; count += 1) {
        recordLastFailure({ kind: "machine" }, {
          code: "disk_full",
          component: "project_db_open",
          projectRoot: "/repo",
          message: "Project data could not open.",
          detail: "internal disk detail",
        });
      }
      const pool = new LocalRuntimeConnectionPool("1.2.3", {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      } as never, { preferServiceRepair: true });
      const internals = pool as unknown as {
        createConnection: () => Promise<unknown>;
        tryConnect: () => Promise<unknown>;
        tryRepairServiceConnection: () => Promise<unknown>;
      };
      vi.spyOn(internals, "tryConnect").mockResolvedValue(null);
      vi.spyOn(internals, "tryRepairServiceConnection").mockResolvedValue(null);

      const error = await internals.createConnection().catch((caught) => caught) as Error & { code?: string };
      expect(error.code).toBe("disk_full");
      expect(error.message).toContain("brain_crash_looping");
      expect(error.message).toContain("4 consecutive failures");
    } finally {
      if (originalAdeHome === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalAdeHome;
      removeTempDir(adeHome);
    }
  });

  it("codes a missing unowned primary endpoint as socket_stale_no_owner", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-stale-socket-"));
    const originalAdeHome = process.env.ADE_HOME;
    process.env.ADE_HOME = adeHome;
    try {
      const pool = new LocalRuntimeConnectionPool("1.2.3", {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      } as never, {
        queryServiceStatus: () => ({
          ok: true,
          serviceName: "com.ade.runtime",
          action: "status",
          installed: true,
          running: false,
          path: "/tmp/com.ade.runtime.plist",
          message: "ADE service is installed.",
        }),
      });
      const internals = pool as unknown as {
        createConnection: () => Promise<unknown>;
        tryConnect: () => Promise<unknown>;
        tryRepairServiceConnection: () => Promise<unknown>;
      };
      vi.spyOn(internals, "tryConnect").mockResolvedValue(null);
      vi.spyOn(internals, "tryRepairServiceConnection").mockResolvedValue(null);

      const error = await internals.createConnection().catch((caught) => caught) as Error & { code?: string };
      expect(error.code).toBe("socket_stale_no_owner");
    } finally {
      if (originalAdeHome === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalAdeHome;
      removeTempDir(adeHome);
    }
  });

  it("does not spawn a primary sync runtime when service repair is not configured", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-primary-block-"));
    const originalEnv = {
      ADE_HOME: process.env.ADE_HOME,
      ADE_RUNTIME_SOCKET_PATH: process.env.ADE_RUNTIME_SOCKET_PATH,
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pool = new LocalRuntimeConnectionPool("1.2.3", logger as never);
    const internals = pool as unknown as {
      createConnection: () => Promise<unknown>;
      tryConnect: (socketPath: string) => Promise<unknown>;
      tryRepairServiceConnection: (socketPath: string, reason: "missing") => Promise<unknown>;
      spawnRuntime: (socketPath: string) => ChildProcess;
    };
    const tryConnect = vi.spyOn(internals, "tryConnect").mockResolvedValue(null);
    const tryRepair = vi.spyOn(internals, "tryRepairServiceConnection").mockResolvedValue(null);
    const spawnRuntime = vi.spyOn(internals, "spawnRuntime");

    try {
      process.env.ADE_HOME = adeHome;
      delete process.env.ADE_RUNTIME_SOCKET_PATH;

      await expect(internals.createConnection()).rejects.toThrow(
        /refusing to spawn an app-owned brain on a primary channel socket/i,
      );

      expect(tryConnect).toHaveBeenCalledWith(path.join(adeHome, "sock", "ade.sock"));
      expect(tryRepair).toHaveBeenCalled();
      expect(spawnRuntime).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "local_runtime.primary_runtime_spawn_blocked",
        expect.objectContaining({
          socketPath: path.join(adeHome, "sock", "ade.sock"),
          preferServiceRepair: false,
        }),
      );
    } finally {
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      removeTempDir(adeHome);
    }
  });

  it("routes local sync calls through the project-scoped runtime RPC", async () => {
    const call = vi.fn().mockResolvedValue({
      mode: "standalone",
      connectedPeers: [],
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: () => false },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await expect(pool.callSyncForRoot(rootPath, "sync.getStatus", {
      includeTransferReadiness: true,
    })).resolves.toEqual({
      mode: "standalone",
      connectedPeers: [],
    });

    expect(call).toHaveBeenCalledWith(
      "sync.getStatus",
      {
        projectId: "project-1",
        includeTransferReadiness: true,
      },
      { timeoutMs: LOCAL_RUNTIME_SYNC_TIMEOUT_MS },
    );
  });

  it("routes machine sync calls without adding a project id", async () => {
    const call = vi.fn().mockResolvedValue({
      mode: "standalone",
      connectedPeers: [],
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: () => false },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await expect(pool.callSync("sync.getStatus", {
      includeTransferReadiness: true,
    })).resolves.toEqual({
      mode: "standalone",
      connectedPeers: [],
    });

    expect(call).toHaveBeenCalledWith("sync.getStatus", {
      includeTransferReadiness: true,
    });
  });

  it("keeps foreground catalog metadata authoritative while routing background actions", async () => {
    const rootPath = path.resolve("/repo");
    const project = {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    };
    const call = vi.fn(async (method: string) => {
      if (method === "projects.add") return project;
      if (method === "projects.setCatalogVisibility") {
        return { ...project, catalogVisibility: "system", registrationSource: "desktop" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client: { call, isClosed: () => false },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await pool.ensureProject(rootPath, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    await pool.setProjectCatalogVisibility(rootPath, "system", "desktop");
    await pool.ensureProject(rootPath);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(
      1,
      "projects.add",
      { rootPath, catalogVisibility: "recent", registrationSource: "desktop" },
      { timeoutMs: expect.any(Number) },
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "projects.setCatalogVisibility",
      {
        rootPath,
        catalogVisibility: "system",
        registrationSource: "desktop",
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(call).not.toHaveBeenCalledWith(
      "projects.add",
      { rootPath, catalogVisibility: "system", registrationSource: "runtime-auto" },
      expect.anything(),
    );
    expect(call).not.toHaveBeenCalledWith("sync.switchHost", expect.anything());
  });

  it("subscribes to local runtime event notifications", async () => {
    const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    const call = vi.fn(async (method: string) => {
      if (method === "runtimeEvents.subscribe") {
        for (const listener of notificationListeners.get("runtime/event") ?? []) {
          listener({
            subscriptionId: "runtime-events-4",
            projectId: "project-1",
            event: {
              id: 21,
              timestamp: "2026-05-10T12:00:00.000Z",
              category: "runtime",
              payload: { type: "file_change" },
            },
            eventEpoch: "epoch-local-1",
          });
        }
        return { subscriptionId: "runtime-events-4", nextCursor: 22, hasMore: false, eventEpoch: "epoch-local-1" };
      }
      if (method === "runtimeEvents.unsubscribe") {
        return { removed: true };
      }
      return null;
    });
    const client = {
      call,
      onDisconnect: vi.fn(() => () => {}),
      onNotification: vi.fn((method: string, callback: (params: unknown) => void) => {
        const existing = notificationListeners.get(method) ?? new Set<(params: unknown) => void>();
        existing.add(callback);
        notificationListeners.set(method, existing);
        return () => {
          existing.delete(callback);
          if (existing.size === 0) {
            notificationListeners.delete(method);
          }
        };
      }),
    };
    const pool = new LocalRuntimeConnectionPool("1.2.3", {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const rootPath = path.resolve("/repo");
    (pool as unknown as { projectsByRoot: Map<string, unknown> }).projectsByRoot.set(rootPath, {
      projectId: "project-1",
      rootPath,
      displayName: "repo",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: null,
    });
    (pool as unknown as { connection: Promise<unknown> }).connection = Promise.resolve({
      client,
      child: null,
      socketPath: "/tmp/ade.sock",
    });
    const onEvent = vi.fn();

    const cleanup = await pool.subscribeEventsForRoot(rootPath, {
      cursor: 20,
      limit: 5,
      category: "runtime",
    }, onEvent);

    expect(call).toHaveBeenCalledWith(
      "runtimeEvents.subscribe",
      {
        projectId: "project-1",
        cursor: 20,
        limit: 5,
        category: "runtime",
      },
      { timeoutMs: LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS },
    );
    expect(onEvent).toHaveBeenCalledWith({
      id: 21,
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "runtime",
      payload: { type: "file_change" },
    }, "epoch-local-1");

    cleanup();
    expect(call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", { subscriptionId: "runtime-events-4" });
  });
});

describe("local runtime action retry classification", () => {
  it("recognizes dropped/closed daemon connection errors", () => {
    expect(isLocalRuntimeConnectionDropped(new Error("Remote ADE service connection closed."))).toBe(true);
    expect(isLocalRuntimeConnectionDropped(new Error("Remote ADE service connection failed: ECONNRESET"))).toBe(true);
    // Must NOT treat unrelated failures as a connection drop (would wrongly retry).
    expect(isLocalRuntimeConnectionDropped(new Error("Remote ADE service timed out waiting for method ade/actions/call (5000ms)."))).toBe(false);
    expect(isLocalRuntimeConnectionDropped(new Error("Local ADE service action failed."))).toBe(false);
  });

  it("only retries idempotent read actions, never mutations", () => {
    // Reads — safe to retry after a connection drop.
    expect(isRetryableReadAction("lane", "list")).toBe(true);
    expect(isRetryableReadAction("lane", "listSnapshots")).toBe(true);
    expect(isRetryableReadAction("diff", "getChanges")).toBe(true);
    expect(isRetryableReadAction("diff", "getFilePatch")).toBe(true);
    expect(isRetryableReadAction("file", "readFile")).toBe(true);
    expect(isRetryableReadAction("chat", "getChatEventHistory")).toBe(true);
    expect(isRetryableReadAction("file", "quickOpen")).toBe(true);

    // Mutations — must NOT be retried (a retry could re-run the side effect).
    expect(isRetryableReadAction("lane", "delete")).toBe(false);
    expect(isRetryableReadAction("lane", "create")).toBe(false);
    expect(isRetryableReadAction("lane", "archive")).toBe(false);
    expect(isRetryableReadAction("file", "writeTextAtomic")).toBe(false);
    expect(isRetryableReadAction("chat", "sendMessage")).toBe(false);
    expect(isRetryableReadAction("pr", "merge")).toBe(false);
    // Prefix must respect a camelCase boundary, not arbitrary substrings.
    expect(isRetryableReadAction("lane", "getaway")).toBe(false);
    expect(isRetryableReadAction("lane", "listenStop")).toBe(false);
  });
});
