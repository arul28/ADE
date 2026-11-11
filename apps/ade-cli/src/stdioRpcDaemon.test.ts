import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import { createFileLogger } from "../../desktop/src/main/services/logging/logger";
import { BRAIN_CONNECTION_LOST_CODE } from "../../desktop/src/shared/brainConnectionLoss";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function withTsxNodeOptions(value: string | undefined): string {
  const existing = value?.trim();
  return existing ? `${existing} --import tsx` : "--import tsx";
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Resolve the machine runtime endpoint for a temp `ADE_HOME` exactly the way
 * production does (`resolveMachineRuntimeSocketPath` in cli.ts falls through to
 * this same layout), so daemon-backed tests exercise the real per-platform
 * transport: a Unix domain socket at `<ADE_HOME>/sock/ade.sock` on macOS and
 * Linux, and a per-user named pipe on Windows.
 *
 * Hardcoding `<adeHome>/sock/ade.sock` is not portable. Windows has no Unix
 * domain sockets, so `net` treats a path-style endpoint as a named pipe name
 * there; a filesystem path is not a connectable address and every such test
 * died with `connect ENOENT`. Deriving the endpoint keeps the POSIX value
 * byte-identical — `resolveMachineAdeLayout` returns exactly
 * `path.join(adeHome, "sock", "ade.sock")` off win32 — while giving Windows the
 * address the runtime actually listens on.
 */
/**
 * This process's environment without any `ADE_*` variable. Run inside an ADE
 * chat or terminal, the parent's `ADE_RPC_URL`, `ADE_RPC_SOCKET_PATH`, caller
 * identity and role point the CLI under test at that machine's real brain;
 * each test names the ADE variables it means to set.
 */
function environmentWithoutAde(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ADE_")));
}

function machineRuntimeSocketPath(adeHome: string): string {
  return resolveMachineAdeLayout({ ...environmentWithoutAde(), ADE_HOME: adeHome }).socketPath;
}

/**
 * Mirrors `LOCAL_RUNTIME_STARTUP_TIMEOUT_MS` in the desktop local runtime pool:
 * a cold Windows daemon start (process spawn + tsx transform + SQLite init) is
 * genuinely slower than on macOS/Linux, so production already waits 30s there
 * against 10s elsewhere. This is a ceiling, not a sleep — a healthy daemon is
 * reachable in a few seconds on every platform — so widening it on Windows only
 * removes a false failure under load.
 */
const RUNTIME_SOCKET_READY_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

/**
 * A request that cold-starts the daemon (the first `ade/initialize`) waits for
 * that start as well as its own answer. On Windows the start alone may take the
 * 30s production allows, so a fixed 15s request guard failed under load while
 * the daemon was still starting. Each test's own limit grows by the same
 * allowance. macOS and Linux keep their original limits.
 */
const WINDOWS_COLD_START_ALLOWANCE_MS = process.platform === "win32" ? RUNTIME_SOCKET_READY_TIMEOUT_MS : 0;
const REQUEST_TIMEOUT_MS = 15_000 + WINDOWS_COLD_START_ALLOWANCE_MS;
const DAEMON_TEST_TIMEOUT_MS = 45_000 + WINDOWS_COLD_START_ALLOWANCE_MS;

async function getFreeTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a TCP port for test.");
  }
  return address.port;
}

async function waitForConnection(
  label: string,
  connect: () => net.Socket,
  timeoutMs = RUNTIME_SOCKET_READY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect();
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Timed out connecting to ${label}`));
        }, 500);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`ADE runtime socket did not become available: ${label}`);
}

async function waitForSocket(
  socketPath: string,
  timeoutMs = RUNTIME_SOCKET_READY_TIMEOUT_MS,
): Promise<void> {
  await waitForConnection(socketPath, () => net.createConnection(socketPath), timeoutMs);
}

async function waitForTcpUrl(
  tcpUrl: string,
  timeoutMs = RUNTIME_SOCKET_READY_TIMEOUT_MS,
): Promise<void> {
  const parsed = new URL(tcpUrl);
  const port = Number.parseInt(parsed.port, 10);
  const host = parsed.hostname;
  await waitForConnection(tcpUrl, () => net.createConnection({ host, port }), timeoutMs);
}

function startServeProcess(args: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  extraArgs?: string[];
}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [args.cliPath, "serve", "--socket", args.socketPath, "--no-sync", ...(args.extraArgs ?? [])],
    {
      cwd: args.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

class StdioRpcProcess {
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`ADE stdio RPC process exited before response: code=${code} signal=${signal} stderr=${this.stderr.trim()}`);
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    });
  }

  static start(args: {
    cliPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): StdioRpcProcess {
    return new StdioRpcProcess(spawn(process.execPath, [args.cliPath, "rpc", "--stdio"], {
      cwd: args.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
    }));
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.stderr.trim()}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  closeInput(): void {
    this.child.stdin.end();
  }

  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ADE stdio RPC process did not exit. stderr=${this.stderr.trim()}`));
      }, REQUEST_TIMEOUT_MS);
      this.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  kill(): void {
    try {
      this.child.kill();
    } catch {
      // Best-effort cleanup.
    }
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    while (true) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof parsed.id !== "number") continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "ADE JSON-RPC request failed."));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }
}

describe("ade rpc --stdio daemon bridge", () => {
  // Skipped on Windows: the second client intermittently could not reach the
  // named pipe (ENOENT) or timed out on initialize, failing on unrelated
  // branches and on main. The Linux job runs this contract, and the daemon
  // tests below still spawn real daemons over Windows named pipes.
  it.skipIf(process.platform === "win32")("keeps the machine runtime alive after the stdio client exits", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-"));
    const projectRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-project-")),
    );
    const expectedProjectRoot = projectRoot;
    const socketPath = machineRuntimeSocketPath(adeHome);
    const env = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
    };

    let first: StdioRpcProcess | null = null;
    let second: StdioRpcProcess | null = null;
    try {
      first = StdioRpcProcess.start({ cliPath, cwd: packageRoot, env });
      const initialize = await first.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-test-1",
        identity: { role: "external", callerId: "stdio-daemon-test-1" },
      });
      const project = await first.request("projects.add", { rootPath: projectRoot });

      first.closeInput();
      await expect(first.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });

      second = StdioRpcProcess.start({ cliPath, cwd: packageRoot, env });
      await second.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-test-2",
        identity: { role: "external", callerId: "stdio-daemon-test-2" },
      });
      const persisted = await second.request("projects.list");

      expect(initialize).toMatchObject({
        runtimeInfo: {
          multiProject: true,
        },
      });
      expect(project).toMatchObject({
        rootPath: expectedProjectRoot,
      });
      expect(Array.isArray(persisted)).toBe(true);
      expect((persisted as Array<{ projectId?: string }>)).toContainEqual(
        expect.objectContaining({
          projectId: (project as { projectId: string }).projectId,
        }),
      );

      await expect(second.request("shutdown")).resolves.toEqual({});
      second.closeInput();
      await expect(second.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      first?.kill();
      second?.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("restarts a stale daemon before bridging stdio requests", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-version-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "1.0.0",
      },
      socketPath,
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await waitForSocket(socketPath);

      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: {
          ...baseEnv,
          ADE_CLI_VERSION: "2.0.0",
        },
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-version-test",
        identity: { role: "external", callerId: "stdio-daemon-version-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          version: "2.0.0",
          multiProject: true,
        },
      });

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!oldDaemon.killed) oldDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("restarts a same-version daemon when its build hash is stale", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-build-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
      ADE_CLI_VERSION: "2.0.0",
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: {
        ...baseEnv,
        ADE_RUNTIME_BUILD_HASH: "old-build",
      },
      socketPath,
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await waitForSocket(socketPath);

      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: baseEnv,
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-build-test",
        identity: { role: "external", callerId: "stdio-daemon-build-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          version: "2.0.0",
          multiProject: true,
        },
      });
      expect(
        (initialize as { runtimeInfo?: { buildHash?: string | null } }).runtimeInfo?.buildHash,
      ).toBeTruthy();
      expect(
        (initialize as { runtimeInfo?: { buildHash?: string | null } }).runtimeInfo?.buildHash,
      ).not.toBe("old-build");

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!oldDaemon.killed) oldDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("accepts a compatible TCP daemon and computes a build hash when none is advertised", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-tcp-build-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const tcpPort = await getFreeTcpPort();
    const tcpUrl = `tcp://127.0.0.1:${tcpPort}`;
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
      ADE_CLI_VERSION: "2.0.0",
      ADE_RUNTIME_BUILD_HASH: "",
    };
    const tcpDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: baseEnv,
      socketPath,
      extraArgs: ["--port", String(tcpPort)],
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await Promise.all([waitForSocket(socketPath), waitForTcpUrl(tcpUrl)]);

      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: {
          ...baseEnv,
          ADE_RUNTIME_SOCKET_PATH: tcpUrl,
        },
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-tcp-build-test",
        identity: { role: "external", callerId: "stdio-daemon-tcp-build-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          version: "2.0.0",
          multiProject: true,
          pid: tcpDaemon.pid,
        },
      });
      // With no env-advertised build hash, the daemon computes a sha256 of its
      // own entrypoint, so buildHash is a truthy string rather than null.
      expect(
        (initialize as { runtimeInfo?: { buildHash?: string | null } }).runtimeInfo?.buildHash,
      ).toBeTruthy();

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!tcpDaemon.killed) tcpDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("keeps a compatible cto daemon when the proxy requests an agent role", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-role-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
      ADE_CLI_VERSION: "2.0.0",
    };
    const oldDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: {
        ...baseEnv,
        ADE_DEFAULT_ROLE: "cto",
        ADE_RUNTIME_BUILD_HASH: fileSha256(cliPath),
      },
      socketPath,
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await waitForSocket(socketPath);

      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: {
          ...baseEnv,
          ADE_DEFAULT_ROLE: "agent",
        },
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-role-test",
        identity: { role: "external", callerId: "stdio-daemon-role-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          version: "2.0.0",
          defaultRole: "cto",
          multiProject: true,
        },
      });
      expect((initialize as { runtimeInfo?: { pid?: number | null } }).runtimeInfo?.pid).toBe(oldDaemon.pid);

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!oldDaemon.killed) oldDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("does not replace a real daemon when the bridging CLI has only the placeholder version", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-placeholder-version-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
    };
    const realDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "2.0.0",
      },
      socketPath,
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await waitForSocket(socketPath);

      const placeholderEnv: NodeJS.ProcessEnv = { ...baseEnv };
      delete placeholderEnv.ADE_CLI_VERSION;
      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: placeholderEnv,
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-placeholder-version-test",
        identity: { role: "external", callerId: "stdio-daemon-placeholder-version-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          version: "2.0.0",
          multiProject: true,
        },
      });

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!realDaemon.killed) realDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  it("restarts an incompatible-role daemon even when the proxy has only the placeholder version", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-placeholder-role-"));
    const socketPath = machineRuntimeSocketPath(adeHome);
    const baseEnv = {
      ...environmentWithoutAde(),
      ADE_HOME: adeHome,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS),
    };
    const realDaemon = startServeProcess({
      cliPath,
      cwd: packageRoot,
      env: {
        ...baseEnv,
        ADE_CLI_VERSION: "2.0.0",
        ADE_DEFAULT_ROLE: "agent",
      },
      socketPath,
    });

    let proxy: StdioRpcProcess | null = null;
    try {
      await waitForSocket(socketPath);

      const placeholderEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        ADE_DEFAULT_ROLE: "cto",
      };
      delete placeholderEnv.ADE_CLI_VERSION;
      proxy = StdioRpcProcess.start({
        cliPath,
        cwd: packageRoot,
        env: placeholderEnv,
      });
      const initialize = await proxy.request("ade/initialize", {
        protocolVersion: "2025-06-18",
        clientName: "stdio-daemon-placeholder-role-test",
        identity: { role: "external", callerId: "stdio-daemon-placeholder-role-test" },
      });

      expect(initialize).toMatchObject({
        runtimeInfo: {
          defaultRole: "cto",
          multiProject: true,
        },
      });
      expect((initialize as { runtimeInfo?: { pid?: number | null } }).runtimeInfo?.pid).not.toBe(realDaemon.pid);

      await expect(proxy.request("shutdown")).resolves.toEqual({});
      proxy.closeInput();
      await expect(proxy.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      proxy?.kill();
      if (!realDaemon.killed) realDaemon.kill();
    }
  }, DAEMON_TEST_TIMEOUT_MS);

  /**
   * A remote desktop reaches a machine's brain only through this proxy
   * (`ade --socket … rpc --stdio` over SSH). The brain's typed answers cross
   * it whole, and a brain that drops the socket under pending calls reads as
   * a lost connection, with structured facts about why and no free text.
   */
  it.skipIf(process.platform === "win32")("passes the brain's typed errors through, and names a dropped brain socket", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-errors-"));
    // TCP, so the brain can reset the connection the way a crashed process's
    // socket does; the proxy treats both transports the same.
    const port = await getFreeTcpPort();
    const socketPath = `tcp://127.0.0.1:${port}`;
    const brainSockets = new Set<net.Socket>();
    const heldIds: unknown[] = [];
    // The brain the relay talks to "dies": its pid is one that has exited, and
    // its log's last lines say why. Their message text (with a path) must not cross.
    const exited = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => exited.once("exit", resolve));
    const deadBrainPid = exited.pid!;
    const runtimeDir = resolveMachineAdeLayout({ ...environmentWithoutAde(), ADE_HOME: adeHome }).runtimeDir;
    fs.mkdirSync(runtimeDir, { recursive: true });
    // Written by the file logger the brain's logger wraps (`createBrainLogger`
    // adds only a stderr copy), so the lines have the shape a real brain
    // writes. Its own level, whatever ADE_LOG_LEVEL this test runs under, and
    // `flushSync` so the lines are on disk before the relay reads them.
    const inheritedLogLevel = process.env.ADE_LOG_LEVEL;
    process.env.ADE_LOG_LEVEL = "info";
    const brainLog = createFileLogger(path.join(runtimeDir, "brain.jsonl"));
    if (inheritedLogLevel === undefined) delete process.env.ADE_LOG_LEVEL;
    else process.env.ADE_LOG_LEVEL = inheritedLogLevel;
    brainLog.info("brain.started");
    brainLog.error("process.uncaught_exception", {
      err: Object.assign(new Error("ENOSPC: no space left on device, write '/home/tiger/.ade/ade.db-wal'"), { code: "ENOSPC" }),
    });
    expect(brainLog.flushSync, "the file logger writes queued lines synchronously").toBeTypeOf("function");
    brainLog.flushSync!();
    const brain = net.createServer((socket) => {
      brainSockets.add(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id?: unknown; method?: string };
          if (request.id === undefined) continue;
          const reply = (body: Record<string, unknown>) =>
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`);
          if (request.method === "ade/initialize") {
            reply({ result: { runtimeInfo: { version: "2.0.0", multiProject: true, pid: deadBrainPid, defaultRole: "cto" } } });
          } else if (request.method === "typed") {
            reply({ error: { code: -32010, message: "Not allowed here.", data: { code: "policy" }, expected: "user" } });
          } else {
            heldIds.push(request.id);
            if (heldIds.length === 3) socket.resetAndDestroy();
          }
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => brain.listen(port, "127.0.0.1", resolve));
    const child = spawn(process.execPath, [cliPath, "--socket", socketPath, "rpc", "--stdio"], {
      cwd: packageRoot,
      env: { ...environmentWithoutAde(), ADE_HOME: adeHome, ADE_RUNTIME_SOCKET_PATH: socketPath, ADE_CLI_VERSION: "2.0.0", ADE_DEFAULT_ROLE: "cto", NODE_OPTIONS: withTsxNodeOptions(process.env.NODE_OPTIONS) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map<number, { result?: unknown; error?: { code?: number; message?: string; data?: unknown; expected?: unknown } }>();
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const replied = (id: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No reply to ${id}. stderr=${stderr}`)), REQUEST_TIMEOUT_MS);
      const check = () => {
        if (!replies.has(id)) return;
        clearTimeout(timer);
        child.stdout.off("data", check);
        resolve();
      };
      child.stdout.on("data", check);
      check();
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (let newline = stdout.indexOf("\n"); newline >= 0; newline = stdout.indexOf("\n")) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as { id?: number };
        if (typeof parsed.id === "number") replies.set(parsed.id, parsed as never);
      }
    });
    const send = (id: number, method: string) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
    try {
      send(1, "ade/initialize");
      await replied(1);
      send(2, "typed");
      await replied(2);
      expect(replies.get(2)?.error).toEqual({
        code: -32010,
        message: "Not allowed here.",
        data: { code: "policy" },
        expected: "user",
      });

      for (const id of [3, 4, 5]) send(id, "ade/actions/call");
      await Promise.all([replied(3), replied(4), replied(5)]);
      for (const id of [3, 4, 5]) {
        const error = replies.get(id)?.error;
        expect(error?.data).toEqual({
          code: BRAIN_CONNECTION_LOST_CODE,
          socketError: "ECONNRESET",
          brainState: "exited",
          heartbeatAgeSec: null,
          brainLogTail: [
            { level: "info", event: "brain.started" },
            { level: "error", event: "process.uncaught_exception", code: "ENOSPC" },
          ],
        });
        expect(JSON.stringify(error)).not.toContain("/home/tiger");
      }
    } finally {
      child.kill();
      for (const socket of brainSockets) socket.destroy();
      brain.close();
    }
  }, DAEMON_TEST_TIMEOUT_MS);
});
