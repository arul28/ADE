import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePiSdkConnection,
  releasePiSdkConnection,
} from "./piSdkPool";
import { PI_SDK_PROTOCOL_VERSION } from "./piSdkProtocol";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

class FakePiWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  connected = true;
  disposeCount = 0;
  private exited = false;

  send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => this.emit("message", {
        protocolVersion: PI_SDK_PROTOCOL_VERSION,
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          protocolVersion: PI_SDK_PROTOCOL_VERSION,
          packageRoot: "/pi",
          packageEntry: "/pi/index.js",
          version: null,
          sessionFile: null,
          sessionId: null,
          currentModel: null,
          thinkingLevel: null,
          availableModels: [],
        },
      }));
    }
    if (message.type === "dispose") {
      this.disposeCount += 1;
      queueMicrotask(() => this.finishExit(0));
    }
    return true;
  }

  finishExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.connected = false;
    this.emit("exit", code, null);
  }

  kill(): boolean {
    this.killed = true;
    this.finishExit(1);
    return true;
  }
}

afterEach(() => {
  forkMock.mockReset();
});

describe("Pi SDK worker activity scope pooling", () => {
  it.skipIf(process.platform === "linux")("reuses a worker for equivalent activity executable and socket paths", async () => {
    const worker = new FakePiWorker();
    forkMock.mockReturnValue(worker);
    const poolKey = `pi-equivalent-activity-scope:${Date.now()}:${Math.random()}`;
    const cliPath = process.platform === "win32" ? "C:\\ADE\\bin\\ade.exe" : "/ADE/bin/ade";
    const equivalentCliPath = process.platform === "win32" ? "c:/ade/BIN/ADE.exe" : "/ade/BIN/ADE";
    const runtimeSocketPath = process.platform === "win32"
      ? "C:\\ADE\\runtime\\ade.sock"
      : "/ADE/runtime/ade.sock";
    const equivalentRuntimeSocketPath = process.platform === "win32"
      ? "c:/ade/RUNTIME/ade.sock"
      : "/ade/RUNTIME/ADE.sock";
    const args = {
      poolKey,
      packageRoot: "/pi",
      packageEntry: "/pi/index.js",
      cwd: "/workspace",
      agentDir: "/agent",
      activityScope: { cliPath, chatSessionId: "chat-1", runtimeSocketPath },
    };

    const first = await acquirePiSdkConnection(args);
    const equivalent = await acquirePiSdkConnection({
      ...args,
      activityScope: {
        cliPath: equivalentCliPath,
        chatSessionId: "chat-1",
        runtimeSocketPath: equivalentRuntimeSocketPath,
      },
    });

    expect(equivalent.pooled).toBe(first.pooled);
    expect(equivalent.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);
    releasePiSdkConnection(poolKey, first.generation);
    releasePiSdkConnection(poolKey, equivalent.generation);
  });

  it("reuses a matching activity scope and replaces a worker when its scope changes", async () => {
    const firstWorker = new FakePiWorker();
    const replacementWorker = new FakePiWorker();
    forkMock.mockReturnValueOnce(firstWorker).mockReturnValueOnce(replacementWorker);
    const poolKey = `pi-activity-scope:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      packageRoot: "/pi",
      packageEntry: "/pi/index.js",
      cwd: "/workspace",
      agentDir: "/agent",
      activityScope: {
        cliPath: "/ade/bin/ade",
        chatSessionId: "chat-1",
        runtimeSocketPath: "/runtime/alpha.sock",
      },
    };

    const first = await acquirePiSdkConnection(args);
    const sameScope = await acquirePiSdkConnection({ ...args, activityScope: { ...args.activityScope } });
    expect(sameScope.pooled).toBe(first.pooled);
    expect(sameScope.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);

    const replacement = await acquirePiSdkConnection({
      ...args,
      activityScope: { ...args.activityScope, runtimeSocketPath: "/runtime/beta.sock" },
    });
    expect(replacement.pooled).not.toBe(first.pooled);
    expect(replacement.generation).not.toBe(first.generation);
    expect(firstWorker.disposeCount).toBe(1);
    expect(firstWorker.exitCode).toBe(0);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releasePiSdkConnection(poolKey, replacement.generation);
  });
});

/** A Pi worker that answers `init` and exits only when told. */
class FakePiChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;
  disposeRequests = 0;

  send(message: { type?: string; requestId?: string }, callback?: (error: Error | null) => void): boolean {
    callback?.(null);
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => this.emit("message", {
        protocolVersion: PI_SDK_PROTOCOL_VERSION,
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          protocolVersion: PI_SDK_PROTOCOL_VERSION,
          packageRoot: "/pi",
          packageEntry: "/pi/index.js",
          version: "1.0.0",
          sessionFile: null,
          sessionId: null,
          currentModel: null,
          thinkingLevel: null,
          availableModels: [],
        },
      }));
    }
    if (message.type === "dispose") this.disposeRequests += 1;
    return true;
  }

  exit(): void {
    this.exitCode = 0;
    this.connected = false;
    this.emit("exit", 0, null);
  }

  kill(): boolean {
    this.killed = true;
    this.exit();
    return true;
  }
}

async function acquire(poolKey: string, child: FakePiChild) {
  forkMock.mockReturnValue(child);
  return acquirePiSdkConnection({
    poolKey,
    packageRoot: "/pi",
    packageEntry: "/pi/index.js",
    cwd: os.tmpdir(),
    agentDir: path.join(os.tmpdir(), `ade-pi-pool-test-${Math.random()}`),
    baseEnv: {},
  });
}

describe("Pi SDK pool release", () => {
  it("settles a release once the worker exits", async () => {
    const child = new FakePiChild();
    const poolKey = `pi-test:${Math.random()}`;
    const acquired = await acquire(poolKey, child);
    const onDisposed = vi.fn();
    releasePiSdkConnection(poolKey, acquired.generation, onDisposed);
    expect(child.disposeRequests).toBe(1);
    await Promise.resolve();
    expect(onDisposed).not.toHaveBeenCalled();
    child.exit();
    await vi.waitFor(() => expect(onDisposed).toHaveBeenCalledOnce());
  });

  // The Pi restart waits for this callback. A release that never called it
  // held every restart for the full 5 s ceiling.
  it("settles a release at once when another holder keeps the worker", async () => {
    const child = new FakePiChild();
    const poolKey = `pi-test:${Math.random()}`;
    const first = await acquire(poolKey, child);
    await acquire(poolKey, child);
    const onDisposed = vi.fn();
    releasePiSdkConnection(poolKey, first.generation, onDisposed);
    expect(onDisposed).toHaveBeenCalledOnce();
    expect(child.disposeRequests).toBe(0);
    releasePiSdkConnection(poolKey, first.generation);
    expect(child.disposeRequests).toBe(1);
    child.exit();
  });

  it("settles a release of a replaced generation once that worker has exited", async () => {
    const poolKey = `pi-test:${Math.random()}`;
    const old = new FakePiChild();
    const oldAcquired = await acquire(poolKey, old);
    // The old worker died; a new acquisition replaces it under the same key.
    old.exit();
    const replacement = new FakePiChild();
    const next = await acquire(poolKey, replacement);
    expect(next.generation).not.toBe(oldAcquired.generation);

    const onDisposed = vi.fn();
    releasePiSdkConnection(poolKey, oldAcquired.generation, onDisposed);
    await vi.waitFor(() => expect(onDisposed).toHaveBeenCalledOnce());
    // The replacement is untouched.
    expect(replacement.disposeRequests).toBe(0);
    releasePiSdkConnection(poolKey, next.generation);
    replacement.exit();
  });
});
