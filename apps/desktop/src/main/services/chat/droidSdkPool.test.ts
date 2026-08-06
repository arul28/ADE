import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDroidSdkConnection,
  releaseDroidSdkConnection,
} from "./droidSdkPool";

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
  initPayloads: unknown[] = [];

  send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    if (message.type === "init" && message.requestId) {
      this.initPayloads.push(message.payload);
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: {
            sessionId: "sdk-session-1",
            currentModelId: "droid-model",
            availableModels: [{ id: "droid-model" }],
          },
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

afterEach(() => {
  forkMock.mockReset();
});

describe("Droid SDK pool", () => {
  it("retains a ref for each concurrent waiter on a shared initialization", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      droidPath: "/usr/local/bin/droid",
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      sessionId: "session-1",
      settings: {
        modelId: "droid-model",
        autonomyLevel: "medium" as const,
        interactionMode: "auto" as const,
      },
      baseEnv: {
        PATH: "/tmp/ade-cli/bin",
        ADE_CHAT_SESSION_ID: "session-1",
        ADE_DEFAULT_ROLE: "agent",
      },
      allowedMcpServerNames: [],
    };

    const [first, second] = await Promise.all([
      acquireDroidSdkConnection(args),
      acquireDroidSdkConnection(args),
    ]);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/tmp/ade-cli/bin",
          ADE_CHAT_SESSION_ID: "session-1",
          ADE_DEFAULT_ROLE: "agent",
        }),
      }),
    );
    expect(second.pooled).toBe(first.pooled);
    expect(second.generation).toBe(first.generation);
    expect((child.initPayloads[0] as { allowedMcpServerNames?: string[] }).allowedMcpServerNames).toEqual([]);

    releaseDroidSdkConnection(poolKey, first.generation);
    expect(child.disposeCount).toBe(0);

    releaseDroidSdkConnection(poolKey, second.generation);
    expect(child.disposeCount).toBe(1);
  });

  it("rejects initialization instead of throwing when the worker IPC channel closes", async () => {
    forkMock.mockReturnValue(new ExitingBeforeInitChild());
    const poolKey = `test-exit:${Date.now()}:${Math.random()}`;

    await expect(acquireDroidSdkConnection({
      poolKey,
      droidPath: "/usr/local/bin/droid",
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      sessionId: "session-1",
      settings: {
        modelId: "droid-model",
        autonomyLevel: "medium" as const,
        interactionMode: "auto" as const,
      },
    })).rejects.toThrow("Droid SDK worker exited (1).");
  });
});
