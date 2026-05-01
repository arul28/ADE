import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";

type FakeCdpTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

const mockState = vi.hoisted(() => ({
  httpResponses: [] as Array<FakeCdpTarget[] | Promise<FakeCdpTarget[]>>,
  sockets: [] as Array<{ url: string; sent: string[] }>,
  runtimeValues: [] as unknown[],
}));

vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      get: (_url: string, _options: { timeout?: number }, callback: (response: EventEmitter & { statusCode?: number }) => void) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy: (error?: Error) => void;
          setTimeout: () => void;
        };
        request.destroy = (error?: Error) => {
          if (error) request.emit("error", error);
        };
        request.setTimeout = () => {};
        const responseTargets = mockState.httpResponses.shift();
        queueMicrotask(async () => {
          try {
            const targets = await responseTargets;
            const response = new EventEmitter() as EventEmitter & { statusCode?: number };
            response.statusCode = 200;
            callback(response);
            response.emit("data", Buffer.from(JSON.stringify(targets ?? [])));
            response.emit("end");
          } catch (error) {
            request.emit("error", error);
          }
        });
        return request;
      },
    },
  };
});

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly OPEN = FakeWebSocket.OPEN;
    readonly CLOSING = FakeWebSocket.CLOSING;
    readonly CLOSED = FakeWebSocket.CLOSED;

    readyState = FakeWebSocket.OPEN;
    readonly sent: string[] = [];

    constructor(readonly url: string) {
      super();
      mockState.sockets.push({ url, sent: this.sent });
      queueMicrotask(() => this.emit("open"));
    }

    send(payload: string, callback?: (error?: Error) => void): void {
      this.sent.push(payload);
      const message = JSON.parse(payload) as { id: number; method: string };
      if (this.readyState === FakeWebSocket.OPEN) {
        const result = message.method === "Runtime.evaluate"
          ? { result: { value: mockState.runtimeValues.shift() ?? {} } }
          : {};
        this.emit("message", Buffer.from(JSON.stringify({ id: message.id, result })));
      }
      callback?.();
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.close();
    }
  }

  return { WebSocket: FakeWebSocket };
});

import { createAppControlService } from "./appControlService";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function target(id: string): FakeCdpTarget {
  return {
    id,
    type: "page",
    title: `Window ${id}`,
    url: `app://test/?view=${id}`,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  };
}

describe("appControlService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.httpResponses.length = 0;
    mockState.sockets.length = 0;
    mockState.runtimeValues.length = 0;
  });

  it("lets manual target switches win over an in-flight health poll", async () => {
    const targetA = target("a");
    const targetB = target("b");
    mockState.httpResponses.push([targetA, targetB]);

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    expect(service.getStatus().activeSession?.cdpTargetId).toBe("a");

    const healthPoll = deferred<FakeCdpTarget[]>();
    mockState.httpResponses.push(healthPoll.promise);
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();

    mockState.httpResponses.push([targetA, targetB]);
    const attached = await service.attachToTarget("b");
    expect(attached.cdpTargetId).toBe("b");
    expect(service.getStatus().activeSession?.cdpTargetId).toBe("b");

    healthPoll.resolve([targetA, targetB]);
    await Promise.resolve();

    expect(service.getStatus().activeSession?.cdpTargetId).toBe("b");
    expect(service.getStatus().activeSession?.cdpEndpoint).toBe(targetB.webSocketDebuggerUrl);
  });

  it("dispatches clicks without a blocking mouseMoved prelude", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const socket = mockState.sockets.at(-1);
    expect(socket).toBeTruthy();
    socket!.sent.length = 0;

    await service.click({ x: 20, y: 40, scale: 2 });

    const mouseEvents = socket!.sent
      .map((payload) => JSON.parse(payload) as { method: string; params?: { type?: string; x?: number; y?: number } })
      .filter((message) => message.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.map((event) => event.params?.type)).toEqual(["mousePressed", "mouseReleased"]);
    expect(mouseEvents.map((event) => ({ x: event.params?.x, y: event.params?.y }))).toEqual([
      { x: 10, y: 20 },
      { x: 10, y: 20 },
    ]);
  });

  it("uses an in-page click fallback when the Electron target is hidden", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);
    mockState.runtimeValues.push(
      { hasFocus: true, visibilityState: "hidden" },
      { ok: true, target: "button", label: "Open full app" },
    );

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const socket = mockState.sockets.at(-1);
    expect(socket).toBeTruthy();
    socket!.sent.length = 0;

    await service.click({ x: 20, y: 40, scale: 2 });

    const messages = socket!.sent.map((payload) => JSON.parse(payload) as { method: string });
    expect(messages.filter((message) => message.method === "Runtime.evaluate")).toHaveLength(2);
    expect(messages.some((message) => message.method === "Input.dispatchMouseEvent")).toBe(false);
  });
});
