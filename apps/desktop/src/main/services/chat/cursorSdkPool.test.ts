import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCursorSdkConnection,
  buildCursorSdkPaths,
  buildCursorSdkWorkerEnv,
  isCursorSdkPooledAlive,
  releaseCursorSdkConnection,
  resolveCursorSdkUserHome,
} from "./cursorSdkPool";

const forkMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

class FakeSdkChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  disposeCount = 0;

  send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: { agentId: "agent-1" },
        });
      });
    }
    if (message.type === "dispose") {
      this.disposeCount += 1;
    }
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}

class ExitingBeforeInitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;

  send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init") {
      queueMicrotask(() => {
        this.exitCode = 1;
        this.connected = false;
        this.emit("exit", 1, null);
      });
      return true;
    }
    if (message.type === "dispose") {
      throw Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
    }
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}

class ExitingWithStderrBeforeInitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;

  send(message: { type?: string }): boolean {
    if (message.type === "init") {
      queueMicrotask(() => {
        this.stderr.emit(
          "data",
          [
            "ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
            "  rawMessage: 'Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'",
            "Node.js v26.0.0",
          ].join("\n"),
        );
        this.exitCode = 1;
        this.connected = false;
        this.emit("exit", 1, null);
      });
      return true;
    }
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}

afterEach(() => {
  forkMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("Cursor SDK pool paths", () => {
  it("uses the real user home while keeping ADE runtime state under the project cache", () => {
    const projectRoot = path.join(os.tmpdir(), "ade-project");
    const userHomeDir = path.join(os.tmpdir(), "real-home");
    const paths = buildCursorSdkPaths({
      projectRoot,
      poolKey: "lane:/repo:session",
      userHomeDir,
    });

    expect(paths.userHomeDir).toBe(userHomeDir);
    expect(paths.cacheRoot).toContain(path.join(projectRoot, ".ade", "cache", "cursor-sdk"));
    expect(paths.stateRoot).toBe(path.join(paths.cacheRoot, "state"));
    if (process.platform === "win32") {
      expect(paths.socketPath).toContain("\\\\.\\pipe\\ade-cursor-sdk-");
    } else {
      expect(paths.socketPath).toContain(`ade-cursor-sdk-${process.getuid?.() ?? ""}`);
      expect(path.basename(paths.socketPath)).toBe("hook.sock");
    }
  });

  it("builds a worker environment with real HOME parity and no ADE brain ownership metadata", () => {
    const cliRoot = makeTempDir("ade-cli-current-");
    const cliBinDir = path.join(cliRoot, "bin");
    const cliEntry = path.join(cliRoot, "cli.cjs");
    fs.mkdirSync(cliBinDir, { recursive: true });
    const adeCommand = path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade");
    fs.writeFileSync(adeCommand, "");
    fs.writeFileSync(cliEntry, "");
    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        HOME: "/synthetic",
        USERPROFILE: "/synthetic-profile",
        PATH: "/bin",
        ADE_CLI_ENTRY_PATH: cliEntry,
        ADE_CLI_BIN_DIR: cliBinDir,
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_DESKTOP_BRIDGE_SOCKET_PATH: "/Users/admin/.ade-beta/sock/desktop-bridge.sock",
        ADE_RUNTIME_BUILD_HASH: "old-build",
        ADE_RUNTIME_PARENT_PID: "1234",
        ADE_RUNTIME_IDLE_EXIT_MS: "300000",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
        ADE_DEFAULT_ROLE: "cto",
        ADE_DESKTOP_APP_NAME: "ADE Beta",
        ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
        ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL: "1",
        ELECTRON_RUN_AS_NODE: "1",
        CURSOR_API_KEY: "cursor-secret",
        CURSOR_AUTH_TOKEN: "cursor-token",
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.HOME).toBe("/Users/admin");
    expect(env.USERPROFILE).toBe("/Users/admin");
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(env.ADE_HOME).toBeUndefined();
    expect(env.ADE_PACKAGE_CHANNEL).toBeUndefined();
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_RPC_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_DESKTOP_BRIDGE_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_RUNTIME_BUILD_HASH).toBeUndefined();
    expect(env.ADE_RUNTIME_PARENT_PID).toBeUndefined();
    expect(env.ADE_RUNTIME_IDLE_EXIT_MS).toBeUndefined();
    expect(env.ADE_CLI_JS).toBeUndefined();
    expect(env.ADE_CLI_INSTALL_NAME).toBeUndefined();
    expect(env.ADE_DEFAULT_ROLE).toBeUndefined();
    expect(env.ADE_DESKTOP_APP_NAME).toBeUndefined();
    expect(env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION).toBeUndefined();
    expect(env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ADE_CLI_ENTRY_PATH).toBeUndefined();
    expect(env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL).toBe("1");
    expect(env.ADE_CLI_BIN_DIR).toBe(cliBinDir);
    expect(env.ADE_CLI_PATH).toBe(adeCommand);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(cliBinDir);
    expect(env.ADE_CURSOR_SDK_SOCKET).toBe("/tmp/ade-cursor-sdk/socket.sock");
    expect(env.ADE_CURSOR_SDK_LANE_ROOT).toBe("/repo/.ade/worktrees/lane");
    expect(env.ADE_CURSOR_SDK_SESSION_ID).toBe("session-1");
    expect(env.ADE_CURSOR_SDK_STATE_ROOT).toBe("/repo/.ade/cache/cursor-sdk/hash/state");
  });

  it("normalizes stale ADE CLI metadata to the current command bin dir without exposing CLI internals", () => {
    const stableRoot = makeTempDir("ade-cli-stable-");
    const betaRoot = makeTempDir("ade-cli-beta-");
    const stableEntry = path.join(stableRoot, "cli.cjs");
    const betaBinDir = path.join(betaRoot, "bin");
    const betaCommand = path.join(betaBinDir, process.platform === "win32" ? "ade-beta.cmd" : "ade-beta");
    fs.mkdirSync(betaBinDir, { recursive: true });
    fs.writeFileSync(stableEntry, "");
    fs.writeFileSync(betaCommand, "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_ENTRY_PATH: stableEntry,
        ADE_CLI_BIN_DIR: betaBinDir,
        ADE_CLI_PATH: betaCommand,
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.ADE_CLI_ENTRY_PATH).toBeUndefined();
    expect(env.ADE_PACKAGE_CHANNEL).toBeUndefined();
    expect(env.ADE_HOME).toBeUndefined();
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_CLI_BIN_DIR).toBe(betaBinDir);
    expect(env.ADE_CLI_PATH).toBe(betaCommand);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(betaBinDir);
  });

  it("prefers HOME on POSIX and USERPROFILE on Windows when resolving the Cursor user home", () => {
    const resolved = resolveCursorSdkUserHome({
      HOME: "/posix-home",
      USERPROFILE: "C:\\Users\\admin",
    });
    expect(resolved).toBe(process.platform === "win32" ? "C:\\Users\\admin" : "/posix-home");
  });

  it("retains a ref for each concurrent waiter on a shared initialization", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: {
        chatMode: "agent" as const,
        approvalPolicy: "on-request" as const,
        sandbox: "ade" as const,
        force: false,
        hardGuards: true,
      },
    };

    const [first, second] = await Promise.all([
      acquireCursorSdkConnection(args),
      acquireCursorSdkConnection(args),
    ]);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(second.pooled).toBe(first.pooled);
    expect(second.generation).toBe(first.generation);

    releaseCursorSdkConnection(poolKey, first.generation);
    expect(child.disposeCount).toBe(0);

    releaseCursorSdkConnection(poolKey, second.generation);
    expect(child.disposeCount).toBe(1);
  });

  it("does not reuse a worker whose IPC channel has closed", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const poolKey = `test-disconnected:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: {
        chatMode: "agent" as const,
        approvalPolicy: "on-request" as const,
        sandbox: "ade" as const,
        force: false,
        hardGuards: true,
      },
    };

    const first = await acquireCursorSdkConnection(args);
    expect(isCursorSdkPooledAlive(first.pooled)).toBe(true);
    (firstChild as unknown as { connected: boolean }).connected = false;
    expect(isCursorSdkPooledAlive(first.pooled)).toBe(false);

    const second = await acquireCursorSdkConnection(args);
    expect(second.pooled).not.toBe(first.pooled);
    expect(second.generation).not.toBe(first.generation);
    expect(firstChild.killed).toBe(true);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("rejects initialization instead of throwing when the worker IPC channel closes", async () => {
    forkMock.mockReturnValue(new ExitingBeforeInitChild());
    const poolKey = `test-exit:${Date.now()}:${Math.random()}`;

    await expect(acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: {
        chatMode: "agent" as const,
        approvalPolicy: "on-request" as const,
        sandbox: "ade" as const,
        force: false,
        hardGuards: true,
      },
    })).rejects.toThrow("Cursor SDK worker exited (1).");
  });

  it("includes recent worker stderr when a Cursor SDK worker exits", async () => {
    forkMock.mockReturnValue(new ExitingWithStderrBeforeInitChild());
    const poolKey = `test-exit-stderr:${Date.now()}:${Math.random()}`;

    await expect(acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: {
        chatMode: "agent" as const,
        approvalPolicy: "on-request" as const,
        sandbox: "ade" as const,
        force: false,
        hardGuards: true,
      },
    })).rejects.toThrow(/NGHTTP2_ENHANCE_YOUR_CALM/);
  });
});
