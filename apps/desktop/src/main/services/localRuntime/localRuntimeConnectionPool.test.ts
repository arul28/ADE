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
  createLocalRuntimeOutputLogger,
  isLocalChannelBuildOutputPath,
  isLocalRuntimeConnectionDropped,
  isLocalRuntimeMethodTimeout,
  isRetryableReadAction,
  localReleaseBuildOutputRuntimeBlock,
  LocalRuntimeConnectionPool,
  parseRuntimeServiceManagerOutput,
  shouldAutoInstallRuntimeServiceFromPath,
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

  it("does not let a stale timed-out action clear an in-flight reconnect", () => {
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
      resetConnectionAfterActionTimeout: (entry: typeof staleEntry) => void;
    }).resetConnectionAfterActionTimeout(staleEntry);

    expect((pool as unknown as { connection: Promise<unknown> | null }).connection).toBe(reconnect);
    expect(staleClient.close).toHaveBeenCalledTimes(1);
  });

  it("keeps ownership when reconnecting to an app-owned runtime kept alive after timeout", async () => {
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
    (pool as unknown as { preserveOwnedRuntimeChildOnNextConnect: boolean }).preserveOwnedRuntimeChildOnNextConnect = true;
    (pool as unknown as { connectClient: (socketPath: string) => Promise<unknown> }).connectClient = vi.fn(async () => client);

    const entry = await (pool as unknown as {
      tryConnect: (socketPath: string) => Promise<{ client: unknown; child: unknown; socketPath: string } | null>;
    }).tryConnect("/tmp/ade.sock");

    expect(entry?.client).toBe(client);
    expect(entry?.child).toBe(child);
    expect((pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild).toBe(child);
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

    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "list_ade_actions",
      arguments: { domain: "all" },
    });
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
      { rootPath },
      { timeoutMs: 120_000 },
    );
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenNthCalledWith(
      1,
      "projects.add",
      { rootPath },
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

  it("retries an idempotent read after a per-call timeout tears down the connection", async () => {
    // A per-call RPC timeout now fails the whole connection (failConnection),
    // so a concurrent idempotent read can be collaterally rejected with the
    // "timed out waiting for method" message. The pool must treat that as a
    // transient drop and retry the read once on a fresh connection instead of
    // surfacing the timeout to the renderer.
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
    const firstClient = {
      call: vi.fn(async (method: string) => {
        if (method === "projects.add") return project;
        if (method === "ade/actions/call") throw timedOut;
        throw new Error(`Unexpected method ${method}`);
      }),
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
      socketPath: "/tmp/ade-timeout.sock",
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

    // First connection timed out and was torn down; a second was created and
    // served the retry.
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenCalledWith(
      "ade/actions/call",
      expect.objectContaining({ name: "run_ade_action" }),
      { timeoutMs: 30_000 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "local_runtime.action_timeout_drop_client",
      expect.objectContaining({ domain: "lane", action: "list", socketPath: "/tmp/ade-timeout.sock" }),
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

    await expect(pool.ensureProject(rootPath)).resolves.toEqual(project);

    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstClient.call).not.toHaveBeenCalled();
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenCalledWith(
      "projects.add",
      { rootPath },
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

  it("bounds non-file action calls and drops a timed-out client without killing the runtime", async () => {
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
    expect(close).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect((pool as unknown as { connection: unknown }).connection).toBeNull();
    expect((pool as unknown as { ownedRuntimeChild: unknown }).ownedRuntimeChild).toBe(child);
    expect(logger.warn).toHaveBeenCalledWith("local_runtime.action_timeout_drop_client", expect.objectContaining({
      domain: "chat",
      action: "deleteSession",
      socketPath: "/tmp/ade.sock",
    }));
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

    expect(call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
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

  it("registers a foreground project without switching the mobile sync host", async () => {
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

    await pool.ensureProject(rootPath);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("projects.add", { rootPath }, { timeoutMs: expect.any(Number) });
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
    }, "epoch-local-1");

    cleanup();
    expect(call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", { subscriptionId: "runtime-events-4" });
  });

  it("drains the full backlog when a reconnect replay reports hasMore beyond the first batch", async () => {
    // A long disconnect gap can leave more buffered events than a single subscribe
    // replays (limit 100). The daemon signals the remainder with hasMore/nextCursor;
    // the pool must keep draining so every event is replayed, not just the first 100.
    const FIRST_BATCH = 100;
    const TOTAL = 150;
    const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    const makeEvent = (id: number) => ({
      id,
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "runtime" as const,
      payload: { seq: id },
    });
    const emit = (subscriptionId: string, ids: number[]) => {
      for (const listener of notificationListeners.get("runtime/event") ?? []) {
        for (const id of ids) {
          listener({
            subscriptionId,
            projectId: "project-1",
            event: makeEvent(id),
            eventEpoch: "epoch-local-1",
          });
        }
      }
    };
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "runtimeEvents.subscribe") {
        const cursor = typeof params?.cursor === "number" ? params.cursor : 0;
        if (cursor === 0) {
          // First batch: replay events 1..100, then report there is more.
          emit("sub-initial", Array.from({ length: FIRST_BATCH }, (_, i) => i + 1));
          return { subscriptionId: "sub-initial", nextCursor: FIRST_BATCH, hasMore: true, eventEpoch: "epoch-local-1" };
        }
        // Drain batch: replay the remaining events under a throwaway subscription.
        emit("sub-drain", Array.from({ length: TOTAL - FIRST_BATCH }, (_, i) => FIRST_BATCH + i + 1));
        return { subscriptionId: "sub-drain", nextCursor: TOTAL, hasMore: false, eventEpoch: "epoch-local-1" };
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
          if (existing.size === 0) notificationListeners.delete(method);
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

    const cleanup = await pool.subscribeEventsForRoot(rootPath, { cursor: 0, category: "runtime" }, onEvent);

    // Every buffered event — including the 50 past the first replay batch — was delivered.
    expect(onEvent).toHaveBeenCalledTimes(TOTAL);
    const deliveredIds = onEvent.mock.calls.map(([event]) => (event as { id: number }).id);
    expect(deliveredIds).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));

    // The follow-up subscribe used the advancing cursor and the wide drain limit,
    // and the throwaway drain subscription was torn down.
    expect(call).toHaveBeenCalledWith("runtimeEvents.subscribe", expect.objectContaining({
      cursor: FIRST_BATCH,
      limit: 1000,
      replay: true,
    }));
    expect(call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", { subscriptionId: "sub-drain" });

    cleanup();
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

  it("recognizes per-call method timeouts as a transient reconnect trigger", () => {
    // A per-call timeout tears down the shared client; the pool must treat it as
    // transient so the next connect() reconnects and an idempotent read retries.
    expect(
      isLocalRuntimeMethodTimeout(
        new Error("Remote ADE service timed out waiting for method ade/actions/call (5000ms)."),
      ),
    ).toBe(true);
    // Must NOT classify a connection drop or unrelated failure as a method
    // timeout — those are handled by isLocalRuntimeConnectionDropped, and
    // misclassifying would retry on the wrong condition.
    expect(isLocalRuntimeMethodTimeout(new Error("Remote ADE service connection closed."))).toBe(false);
    expect(isLocalRuntimeMethodTimeout(new Error("Local ADE service action failed."))).toBe(false);
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
