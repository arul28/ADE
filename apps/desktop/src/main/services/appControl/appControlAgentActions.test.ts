import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  cdpResults: [] as Array<{ method: string; result: unknown }>,
  // 1x1 PNG.
  screenshotData: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
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
        const queuedResultIndex = mockState.cdpResults.findIndex((entry) => entry.method === message.method);
        const result = queuedResultIndex >= 0
          ? mockState.cdpResults.splice(queuedResultIndex, 1)[0]!.result
          : message.method === "Runtime.evaluate" || message.method === "Runtime.callFunctionOn"
            ? { result: { value: mockState.runtimeValues.shift() ?? {} } }
            : message.method === "Page.captureScreenshot"
              ? { data: mockState.screenshotData }
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
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

type CollectorElement = {
  index: number;
  tagName?: string;
  role?: string | null;
  label?: string | null;
  text?: string | null;
  selector?: string | null;
  testId?: string | null;
  disabled?: boolean | null;
  frame: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
};

function collectorSnapshot(elements: CollectorElement[], overrides: Record<string, unknown> = {}) {
  return {
    readyState: "complete",
    snapshot: {
      url: "app://test/?view=a",
      title: "Test app",
      capturedAt: "2026-05-12T00:00:00.000Z",
      viewport: { x: 0, y: 0, width: 400, height: 300 },
      scroll: { x: 0, y: 0 },
      elementCount: elements.length,
      elements,
    },
    target: null,
    error: null,
    ...overrides,
  };
}

function saveButton(index = 1): CollectorElement {
  return {
    index,
    tagName: "button",
    role: "button",
    label: "Save",
    text: "Save",
    selector: "button.save",
    testId: "save-button",
    disabled: false,
    frame: { x: 10, y: 20, width: 40, height: 20 },
    center: { x: 30, y: 30 },
  };
}

function inputField(index = 2): CollectorElement {
  return {
    index,
    tagName: "input",
    role: "textbox",
    label: "Name",
    text: null,
    selector: "input#name",
    testId: "name-field",
    disabled: false,
    frame: { x: 10, y: 60, width: 120, height: 24 },
    center: { x: 70, y: 72 },
  };
}

function sentMethods(socketIndex = -1): Array<{ method: string; params?: Record<string, unknown> }> {
  const socket = mockState.sockets.at(socketIndex);
  return (socket?.sent ?? []).map((payload) => JSON.parse(payload) as { method: string; params?: Record<string, unknown> });
}

describe("appControlService agent actions", () => {
  let projectRoot: string;

  beforeEach(() => {
    mockState.httpResponses.length = 0;
    mockState.sockets.length = 0;
    mockState.runtimeValues.length = 0;
    mockState.cdpResults.length = 0;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-agent-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  async function connectedService() {
    mockState.httpResponses.push([target("a")]);
    const service = createAppControlService({ projectRoot, logger: createLogger() });
    await service.connect({ cdpPort: 12345, projectRoot, force: true });
    return service;
  }

  it("mints stable obs-...:e:N handles and prunes to the latest three observations", async () => {
    const service = await connectedService();
    try {
      for (let round = 0; round < 4; round += 1) {
        mockState.runtimeValues.push(collectorSnapshot([saveButton(), inputField()]));
      }

      const first = await service.observe();
      expect(first.id).toMatch(/^obs-/);
      expect(first.dom?.elements.map((element) => element.handle)).toEqual([
        `${first.id}:e:1`,
        `${first.id}:e:2`,
      ]);
      expect(first.sessionId).toBe(service.getStatus().activeSession?.id);
      expect(first.diagnostics).toEqual(expect.objectContaining({ pendingRequestCount: 0 }));

      const observations = [first];
      for (let round = 0; round < 3; round += 1) {
        observations.push(await service.observe());
      }

      // Handles are per-observation, so a later capture never reuses an id.
      const ids = new Set(observations.map((entry) => entry.id));
      expect(ids.size).toBe(4);

      const dir = path.dirname(first.filePath);
      const records = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
      expect(records).toHaveLength(3);
      expect(records).not.toContain(`${first.id}.json`);
      expect(observations.at(-1)?.cleanup).toEqual(
        expect.objectContaining({ keepCount: 3, keptCount: 3 }),
      );
      // The screenshot the handle was minted against is pruned with its record.
      expect(fs.existsSync(first.filePath)).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("clicks the element a handle points at and records a trace entry", async () => {
    const service = await connectedService();
    try {
      mockState.runtimeValues.push(collectorSnapshot([saveButton(), inputField()]));
      const observation = await service.observe();
      const handle = observation.dom?.elements[0]?.handle;
      expect(handle).toBe(`${observation.id}:e:1`);

      mockState.runtimeValues.push(collectorSnapshot([saveButton(), inputField()], { target: saveButton() }));
      const socketIndex = mockState.sockets.length - 1;
      mockState.sockets[socketIndex]!.sent.length = 0;

      const result = await service.agentClick({ handle, observe: false, waitAfterMs: 0 });

      expect(result.ok).toBe(true);
      expect(result.observation).toBeNull();
      const mouse = sentMethods()
        .filter((message) => message.method === "Input.dispatchMouseEvent")
        .map((message) => ({ type: message.params?.type, x: message.params?.x, y: message.params?.y }));
      expect(mouse).toEqual([
        { type: "mousePressed", x: 30, y: 30 },
        { type: "mouseReleased", x: 30, y: 30 },
      ]);

      // The handle resolved through the saved observation, so the collector was
      // asked for the element by its recorded selector.
      const locate = sentMethods()
        .filter((message) => message.method === "Runtime.evaluate")
        .map((message) => String(message.params?.expression ?? ""));
      expect(locate.some((expression) => expression.includes("button.save"))).toBe(true);

      expect(result.trace).toEqual(expect.objectContaining({
        action: "click",
        status: "ok",
        sessionId: observation.sessionId,
      }));
      expect(result.trace?.target).toEqual(expect.objectContaining({ handle }));
      expect(service.getTrace().entries.map((entry) => entry.action)).toEqual(["click"]);
    } finally {
      service.dispose();
    }
  });

  // Regression: `switchWindow` cleared only the trace, so a handle minted in
  // window A still resolved against window B's DOM and clicked whatever matched
  // there — silently, with an `ok` trace entry — while the docs and the skill
  // both promise the handle stops resolving.
  it("refuses a handle minted against a different window after switchWindow", async () => {
    mockState.httpResponses.push([target("a"), target("b")]);
    const service = createAppControlService({ projectRoot, logger: createLogger() });
    try {
      await service.connect({ cdpPort: 12345, projectRoot, force: true });
      mockState.runtimeValues.push(collectorSnapshot([saveButton()]));
      const observation = await service.observe();
      const handle = observation.dom?.elements[0]?.handle;
      expect(handle).toBeTruthy();

      mockState.httpResponses.push([target("a"), target("b")], [target("a"), target("b")]);
      await service.switchWindow({ targetId: "b" });

      await expect(service.agentClick({ handle, observe: false, waitAfterMs: 0 }))
        .rejects.toThrow(/different window/i);
    } finally {
      service.dispose();
    }
  });

  it("refuses to act on a disabled target and records the failure in the trace", async () => {
    const service = await connectedService();
    try {
      const disabled = { ...saveButton(), disabled: true };
      mockState.runtimeValues.push(collectorSnapshot([disabled], { target: disabled }));

      await expect(service.agentClick({ selector: "button.save", observe: false, waitAfterMs: 0 }))
        .rejects.toThrow(/disabled/i);

      const messages = sentMethods().filter((message) => message.method === "Input.dispatchMouseEvent");
      expect(messages).toHaveLength(0);

      const trace = service.getTrace();
      expect(trace.entries).toHaveLength(1);
      expect(trace.entries[0]).toEqual(expect.objectContaining({
        action: "click",
        status: "error",
      }));
      expect(trace.entries[0]?.error).toMatch(/disabled/i);
    } finally {
      service.dispose();
    }
  });

  it("bounds the trace by the requested limit and keeps the newest entries", async () => {
    const service = await connectedService();
    try {
      for (let round = 0; round < 5; round += 1) {
        mockState.runtimeValues.push(
          collectorSnapshot([saveButton()], { target: saveButton() }),
        );
      }
      for (let round = 0; round < 5; round += 1) {
        await service.agentPress({ key: "Enter", observe: false, waitAfterMs: 0 });
      }

      expect(service.getTrace().entries).toHaveLength(5);
      const bounded = service.getTrace({ limit: 2 });
      expect(bounded.entries).toHaveLength(2);
      expect(bounded.entries.every((entry) => entry.action === "press")).toBe(true);
      // Trace is session-scoped, and the requested id must match.
      expect(() => service.getTrace({ sessionId: "not-the-active-session" }))
        .toThrow(/not the active session/i);
    } finally {
      service.dispose();
    }
  });

  it("fills only through an explicit value and clears the field first", async () => {
    const service = await connectedService();
    try {
      mockState.runtimeValues.push(collectorSnapshot([inputField(1)], { target: inputField(1) }));
      mockState.sockets.at(-1)!.sent.length = 0;

      await service.agentFill({ selector: "input#name", value: "Ada", observe: false, waitAfterMs: 0 });

      const evaluate = sentMethods().find((message) => message.method === "Runtime.evaluate");
      const payload = String(evaluate?.params?.expression ?? "");
      expect(payload).toContain('"clear":true');
      expect(payload).toContain('"editableRequired":true');
      const insert = sentMethods().find((message) => message.method === "Input.insertText");
      expect(insert?.params).toEqual({ text: "Ada" });

      await expect(service.agentFill({ selector: "input#name", observe: false, waitAfterMs: 0 }))
        .rejects.toThrow(/requires a value/i);
    } finally {
      service.dispose();
    }
  });

  it("reports the computer_use driver as unavailable and refuses to select it", async () => {
    const service = await connectedService();
    try {
      const drivers = service.listDrivers();
      expect(drivers.activeDriver).toBe("cdp");
      expect(drivers.drivers.find((entry) => entry.driver === "cdp")).toEqual(
        expect.objectContaining({ status: "available", implemented: true }),
      );
      const computerUse = drivers.drivers.find((entry) => entry.driver === "computer_use");
      expect(computerUse).toEqual(expect.objectContaining({ status: "unavailable", implemented: false }));
      expect(computerUse?.reason).toMatch(/not implemented in this build/i);

      mockState.httpResponses.push([target("a")]);
      await expect(service.connect({ cdpPort: 12345, projectRoot, force: true, driver: "computer_use" }))
        .rejects.toThrow(/computer_use.*unavailable/i);
      await expect(service.launch({ command: "npm run dev", driver: "computer_use" }))
        .rejects.toThrow(/computer_use.*unavailable/i);
    } finally {
      service.dispose();
    }
  });

  // The Windows-facing copy must not imply the feature works on a Mac: the
  // driver is unimplemented on every platform in this build.
  it("gates the computer_use driver on platform when App Control is not on macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const service = await connectedService();
    try {
      const computerUse = service.listDrivers().drivers.find((entry) => entry.driver === "computer_use");
      expect(computerUse).toEqual(expect.objectContaining({
        status: "unavailable",
        implemented: false,
      }));
      expect(computerUse?.reason).toMatch(/not implemented in this build/i);
      expect(computerUse?.reason).toMatch(/macOS only/i);
    } finally {
      service.dispose();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("lists windows and switches the driven target, resetting the stale trace", async () => {
    mockState.httpResponses.push([target("a"), target("b")]);
    const service = createAppControlService({ projectRoot, logger: createLogger() });
    try {
      await service.connect({ cdpPort: 12345, projectRoot, force: true });

      mockState.httpResponses.push([target("a"), target("b")]);
      const listed = await service.windows();
      expect(listed.windows.map((entry) => entry.id)).toEqual(["a", "b"]);
      expect(listed.activeTargetId).toBe(listed.windows.find((entry) => entry.active)?.id);

      mockState.runtimeValues.push(collectorSnapshot([saveButton()], { target: saveButton() }));
      await service.agentPress({ key: "Enter", observe: false, waitAfterMs: 0 });
      expect(service.getTrace().entries).toHaveLength(1);

      mockState.httpResponses.push([target("a"), target("b")], [target("a"), target("b")]);
      const switched = await service.switchWindow({ targetId: "b" });
      expect(switched.activeTargetId).toBe("b");
      expect(service.getStatus().activeSession?.cdpTargetId).toBe("b");
      // Handles minted against the previous document no longer apply.
      expect(service.getTrace().entries).toHaveLength(0);
    } finally {
      service.dispose();
    }
  });
});
