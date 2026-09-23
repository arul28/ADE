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
  sent: unknown[] = [];
  initResultExtra: Record<string, unknown> = {};
  sendResult: Record<string, unknown> = {};

  send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    this.sent.push(message);
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
            ...this.initResultExtra,
          },
        });
      });
    }
    if (message.type === "send" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: this.sendResult,
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

  it("sends screenshot paths over worker IPC instead of inline bytes", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test-image-paths:${Date.now()}:${Math.random()}`;
    const acquired = await acquireDroidSdkConnection({
      poolKey,
      droidPath: "/usr/local/bin/droid",
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      sessionId: "session-1",
      settings: {
        modelId: "droid-model",
        autonomyLevel: "medium",
        interactionMode: "auto",
      },
    });

    await acquired.pooled.sendPrompt({
      promptText: "compare these screens",
      images: [
        { path: "/repo/.ade/attachments/a.png", mimeType: "image/png", rootPath: "/repo" },
        { path: "/repo/.ade/attachments/b.png", mimeType: "image/png", rootPath: "/repo" },
      ],
      settings: { modelId: "droid-model" },
    });

    const sendReq = child.sent.find((message) => (
      message
      && typeof message === "object"
      && "type" in message
      && message.type === "send"
    )) as { payload?: { images?: Array<{ path?: string; data?: string }> } } | undefined;
    expect(sendReq?.payload?.images).toEqual([
      { path: "/repo/.ade/attachments/a.png", mimeType: "image/png", rootPath: "/repo" },
      { path: "/repo/.ade/attachments/b.png", mimeType: "image/png", rootPath: "/repo" },
    ]);
    expect(sendReq?.payload?.images?.some((image) => image.data)).toBeFalsy();

    releaseDroidSdkConnection(poolKey, acquired.generation);
  });

  // A model switch replaces the worker but resumes the same Droid session,
  // which still carries the effort the old worker stated. The next worker is
  // told, so an effort the chat has since cleared is reset, not inherited.
  it("tells a resuming worker which effort ADE stated to the session", async () => {
    const chat = `chat-effort-${Math.random()}`;
    const acquire = async (child: FakeSdkChild, settings: { modelId: string; reasoningEffort?: "high" }, resume: string | null) => {
      forkMock.mockReturnValue(child);
      const poolKey = `test-effort:${Date.now()}:${Math.random()}`;
      const acquired = await acquireDroidSdkConnection({
        poolKey,
        droidPath: "/usr/local/bin/droid",
        workspacePath: path.join(os.tmpdir(), "ade-workspace"),
        sessionId: chat,
        resumeSessionId: resume,
        settings,
      });
      return { poolKey, acquired };
    };

    const first = new FakeSdkChild();
    const one = await acquire(first, { modelId: "model-a" }, null);
    await one.acquired.pooled.sendPrompt({ promptText: "hi", settings: { modelId: "model-a", reasoningEffort: "high" } });
    releaseDroidSdkConnection(one.poolKey, one.acquired.generation);

    // The chat switched model and has no effort now.
    const second = new FakeSdkChild();
    const two = await acquire(second, { modelId: "model-b" }, "sdk-session-1");
    expect(second.initPayloads[0]).toMatchObject({ resumeSessionId: "sdk-session-1", statedReasoningEffort: "high" });
    expect((second.initPayloads[0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty("reasoningEffort");
    releaseDroidSdkConnection(two.poolKey, two.acquired.generation);

    // That worker reset it; a third one inherits nothing.
    const third = new FakeSdkChild();
    const three = await acquire(third, { modelId: "model-b" }, "sdk-session-1");
    expect(third.initPayloads[0]).not.toHaveProperty("statedReasoningEffort");
    releaseDroidSdkConnection(three.poolKey, three.acquired.generation);
  });

  // The worker's reset of a cleared effort can fail (Droid's model list did
  // not load). The effort is then still on the session, so the chat's next
  // worker must still be told to reset it.
  it("keeps a cleared effort for the next worker until a worker reports the reset landed", async () => {
    const chat = `chat-effort-kept-${Math.random()}`;
    const acquire = async (child: FakeSdkChild, settings: { modelId: string; reasoningEffort?: "high" }, resume: string | null) => {
      forkMock.mockReturnValue(child);
      const poolKey = `test-effort-kept:${Date.now()}:${Math.random()}`;
      const acquired = await acquireDroidSdkConnection({
        poolKey,
        droidPath: "/usr/local/bin/droid",
        workspacePath: path.join(os.tmpdir(), "ade-workspace"),
        sessionId: chat,
        resumeSessionId: resume,
        settings,
      });
      return { poolKey, acquired };
    };

    const first = new FakeSdkChild();
    const one = await acquire(first, { modelId: "model-a", reasoningEffort: "high" }, null);
    // The chat cleared the effort, and this worker's reset failed.
    first.sendResult = { statedReasoningEffort: "high" };
    await one.acquired.pooled.sendPrompt({ promptText: "hi", settings: { modelId: "model-a" } });
    releaseDroidSdkConnection(one.poolKey, one.acquired.generation);

    const second = new FakeSdkChild();
    second.initResultExtra = { statedReasoningEffort: null };
    const two = await acquire(second, { modelId: "model-b" }, "sdk-session-1");
    expect(second.initPayloads[0]).toMatchObject({ statedReasoningEffort: "high" });
    releaseDroidSdkConnection(two.poolKey, two.acquired.generation);

    // The second worker reset it, so a third inherits nothing.
    const third = new FakeSdkChild();
    const three = await acquire(third, { modelId: "model-b" }, "sdk-session-1");
    expect(third.initPayloads[0]).not.toHaveProperty("statedReasoningEffort");
    releaseDroidSdkConnection(three.poolKey, three.acquired.generation);
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
