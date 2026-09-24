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

/** A Pi worker that answers `init`; it exits on `dispose` only when asked to, else when told. */
class FakePiChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  connected = true;
  disposeRequests = 0;

  constructor(private readonly exitOnDispose = false) {
    super();
  }

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
    if (message.type === "dispose") {
      this.disposeRequests += 1;
      if (this.exitOnDispose) queueMicrotask(() => this.exit());
    }
    return true;
  }

  exit(): void {
    if (this.exitCode !== null) return;
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

type ActivityScope = { cliPath: string; chatSessionId: string; runtimeSocketPath: string };

async function acquire(poolKey: string, child: FakePiChild, activityScope?: ActivityScope) {
  forkMock.mockReturnValue(child);
  return acquirePiSdkConnection({
    poolKey,
    packageRoot: "/pi",
    packageEntry: "/pi/index.js",
    cwd: os.tmpdir(),
    agentDir: path.join(os.tmpdir(), "ade-pi-pool-test-agent"),
    baseEnv: {},
    ...(activityScope ? { activityScope } : {}),
  });
}

afterEach(() => {
  forkMock.mockReset();
});

describe("Pi SDK worker activity scope pooling", () => {
  it.skipIf(process.platform === "linux")("reuses a worker for equivalent activity executable and socket paths", async () => {
    const worker = new FakePiChild(true);
    const poolKey = `pi-equivalent-activity-scope:${Math.random()}`;
    const win = process.platform === "win32";
    const first = await acquire(poolKey, worker, {
      cliPath: win ? "C:\\ADE\\bin\\ade.exe" : "/ADE/bin/ade",
      chatSessionId: "chat-1",
      runtimeSocketPath: win ? "C:\\ADE\\runtime\\ade.sock" : "/ADE/runtime/ade.sock",
    });
    const equivalent = await acquire(poolKey, worker, {
      cliPath: win ? "c:/ade/BIN/ADE.exe" : "/ade/BIN/ADE",
      chatSessionId: "chat-1",
      runtimeSocketPath: win ? "c:/ade/RUNTIME/ade.sock" : "/ade/RUNTIME/ADE.sock",
    });

    expect(equivalent.pooled).toBe(first.pooled);
    expect(equivalent.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);
    releasePiSdkConnection(poolKey, first.generation);
    releasePiSdkConnection(poolKey, equivalent.generation);
  });

  it("reuses a matching activity scope and replaces a worker when its scope changes", async () => {
    const firstWorker = new FakePiChild(true);
    const poolKey = `pi-activity-scope:${Math.random()}`;
    const scope = { cliPath: "/ade/bin/ade", chatSessionId: "chat-1", runtimeSocketPath: "/runtime/alpha.sock" };

    const first = await acquire(poolKey, firstWorker, scope);
    const sameScope = await acquire(poolKey, firstWorker, { ...scope });
    expect(sameScope.pooled).toBe(first.pooled);
    expect(sameScope.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);

    const replacement = await acquire(poolKey, new FakePiChild(true), { ...scope, runtimeSocketPath: "/runtime/beta.sock" });
    expect(replacement.pooled).not.toBe(first.pooled);
    expect(replacement.generation).not.toBe(first.generation);
    expect(firstWorker.disposeRequests).toBe(1);
    expect(firstWorker.exitCode).toBe(0);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releasePiSdkConnection(poolKey, replacement.generation);
  });
});

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
