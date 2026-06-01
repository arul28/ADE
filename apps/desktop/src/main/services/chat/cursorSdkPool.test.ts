import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCursorSdkConnection,
  buildCursorSdkPaths,
  buildCursorSdkWorkerEnv,
  releaseCursorSdkConnection,
  resolveCursorSdkUserHome,
} from "./cursorSdkPool";

const forkMock = vi.hoisted(() => vi.fn());

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

afterEach(() => {
  forkMock.mockReset();
});

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

  it("builds a worker environment with real HOME parity and ADE socket metadata", () => {
    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        HOME: "/synthetic",
        USERPROFILE: "/synthetic-profile",
        PATH: "/bin",
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
    expect(env.ADE_CURSOR_SDK_SOCKET).toBe("/tmp/ade-cursor-sdk/socket.sock");
    expect(env.ADE_CURSOR_SDK_LANE_ROOT).toBe("/repo/.ade/worktrees/lane");
    expect(env.ADE_CURSOR_SDK_SESSION_ID).toBe("session-1");
    expect(env.ADE_CURSOR_SDK_STATE_ROOT).toBe("/repo/.ade/cache/cursor-sdk/hash/state");
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
});
