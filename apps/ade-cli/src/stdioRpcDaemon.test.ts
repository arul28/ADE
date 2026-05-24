import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Timed out connecting to ${socketPath}`));
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
  throw lastError ?? new Error(`ADE runtime socket did not become available: ${socketPath}`);
}

function startServeProcess(args: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [args.cliPath, "serve", "--socket", args.socketPath, "--no-sync"], {
    cwd: args.cwd,
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
      }, 15_000);
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
      }, 15_000);
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

const itUnix = process.platform === "win32" ? it.skip : it;

describe("ade rpc --stdio daemon bridge", () => {
  itUnix("keeps the machine runtime alive after the stdio client exits", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-"));
    const projectRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-project-")),
    );
    const expectedProjectRoot = projectRoot;
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const env = {
      ...process.env,
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
  }, 45_000);

  itUnix("restarts a stale daemon before bridging stdio requests", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-version-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const baseEnv = {
      ...process.env,
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
  }, 45_000);

  itUnix("restarts a same-version daemon when its build hash is stale", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-build-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const baseEnv = {
      ...process.env,
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
  }, 45_000);

  itUnix("keeps a compatible cto daemon when the proxy requests an agent role", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-role-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const baseEnv = {
      ...process.env,
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
  }, 45_000);

  itUnix("does not replace a real daemon when the bridging CLI has only the placeholder version", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(packageRoot, "src", "cli.ts");
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-stdio-rpc-placeholder-version-"));
    const socketPath = path.join(adeHome, "sock", "ade.sock");
    const baseEnv = {
      ...process.env,
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
  }, 45_000);
});
