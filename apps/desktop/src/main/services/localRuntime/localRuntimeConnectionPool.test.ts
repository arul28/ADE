import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/Applications/ADE.app/Contents/Resources/app.asar",
  },
}));

import {
  buildLocalRuntimeNodeEnv,
  buildLocalRuntimeNodePath,
  buildLocalRuntimeServeArgs,
  computeLocalRuntimeBuildHash,
  LocalRuntimeConnectionPool,
  parseRuntimeServiceManagerOutput,
} from "./localRuntimeConnectionPool";

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
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const client = await RawRuntimeSocketClient.connect(socketPath);
      client.close();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`ADE service socket did not become available: ${socketPath}`);
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
      { NODE_PATH: "/custom/node_modules" },
      { resourcesPath: "/Applications/ADE.app/Contents/Resources", platform: "darwin", arch: "x64" },
    );

    expect(env.ADE_DEFAULT_ROLE).toBe("cto");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.ADE_CLI_VERSION).toBe("1.2.3");
    expect(env.NODE_PATH).toContain("app-x64.asar.unpacked");
    expect(env.NODE_PATH).toContain("app.asar.unpacked");
    expect(env.NODE_PATH).toContain("/custom/node_modules");
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

  it("reattaches to a machine daemon after the desktop-side client disconnects", async () => {
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
    let firstPool: LocalRuntimeConnectionPool | null = null;
    let secondPool: LocalRuntimeConnectionPool | null = null;

    try {
      process.env.ADE_CLI_JS = cliPath;
      process.env.ADE_HOME = adeHome;
      process.env.ADE_RUNTIME_SOCKET_PATH = socketPath;
      process.env.NODE_OPTIONS = withTsxNodeOptions(originalEnv.NODE_OPTIONS, tsxLoaderPath);

      firstPool = new LocalRuntimeConnectionPool("1.2.3", logger as never, { disableSync: true });
      const registered = await firstPool.ensureProject(projectRoot);
      firstPool.dispose();

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
      if (originalEnv.ADE_CLI_JS === undefined) delete process.env.ADE_CLI_JS;
      else process.env.ADE_CLI_JS = originalEnv.ADE_CLI_JS;
      if (originalEnv.ADE_HOME === undefined) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = originalEnv.ADE_HOME;
      if (originalEnv.ADE_RUNTIME_SOCKET_PATH === undefined) delete process.env.ADE_RUNTIME_SOCKET_PATH;
      else process.env.ADE_RUNTIME_SOCKET_PATH = originalEnv.ADE_RUNTIME_SOCKET_PATH;
      if (originalEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalEnv.NODE_OPTIONS;
    }
  }, 45_000);

  it("replaces a stale local daemon when versions diverge", async () => {
    const adeCliRoot = path.resolve(process.cwd(), "../ade-cli");
    const cliPath = path.join(adeCliRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(adeCliRoot, "node_modules", "tsx", "dist", "loader.mjs");
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(tsxLoaderPath)).toBe(true);

    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-version-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-runtime-version-project-"));
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
      expect(logger.warn).toHaveBeenCalledWith("local_runtime.replacing_stale", expect.objectContaining({
        pid: oldPid,
        socketPath,
      }));

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(oldPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          break;
        }
      }
      expect(() => process.kill(oldPid, 0)).toThrow();

      const client = await RawRuntimeSocketClient.connect(socketPath);
      try {
        const initialized = await client.request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientName: "local-runtime-version-test",
          identity: { role: "external", callerId: "local-runtime-version-test" },
        });
        expect(initialized).toMatchObject({
          runtimeInfo: {
            version: "2.0.0",
          },
        });
      } finally {
        client.close();
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
        "local_runtime.replacing_stale",
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
    }
  }, 45_000);

  it("replaces a same-version local daemon when the packaged runtime build changed", async () => {
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
      expect(logger.warn).toHaveBeenCalledWith("local_runtime.replacing_stale", expect.objectContaining({
        pid: oldPid,
        socketPath,
      }));

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(oldPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          break;
        }
      }
      expect(() => process.kill(oldPid, 0)).toThrow();

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
            buildHash: expectedBuildHash,
          },
        });
      } finally {
        client.close();
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
      client: { call },
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
      { timeoutMs: 2_000 },
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
      client: { call },
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
      client: { call },
      child: null,
      socketPath: "/tmp/ade.sock",
    });

    await expect(pool.callSyncForRoot(rootPath, "sync.getStatus", {
      includeTransferReadiness: true,
    })).resolves.toEqual({
      mode: "standalone",
      connectedPeers: [],
    });

    expect(call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
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
          });
        }
        return { subscriptionId: "runtime-events-4", nextCursor: 22, hasMore: false };
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

    expect(call).toHaveBeenCalledWith("runtimeEvents.subscribe", {
      projectId: "project-1",
      cursor: 20,
      limit: 5,
      category: "runtime",
    });
    expect(onEvent).toHaveBeenCalledWith({
      id: 21,
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "runtime",
      payload: { type: "file_change" },
    });

    cleanup();
    expect(call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", { subscriptionId: "runtime-events-4" });
  });
});
