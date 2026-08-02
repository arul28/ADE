import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  sockets: [] as Array<{ url: string; sent: string[]; emitMessage: (payload: unknown) => void }>,
  runtimeValues: [] as unknown[],
  cdpResults: [] as Array<{ method: string; result: unknown }>,
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
      mockState.sockets.push({
        url,
        sent: this.sent,
        emitMessage: (payload: unknown) => this.emit("message", Buffer.from(JSON.stringify(payload))),
      });
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
            : message.method === "Browser.getWindowForTarget"
              ? { windowId: 7 }
              : message.method === "DOM.getNodeForLocation"
                ? { backendNodeId: 101 }
                : message.method === "DOM.resolveNode"
                  ? { object: { objectId: "node-101" } }
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
    mockState.cdpResults.length = 0;
  });

  it("passes Windows Electron launches to the PTY as structured argv and env", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const create = vi.fn(async () => ({
      sessionId: "terminal-windows",
      ptyId: "pty-windows",
      pid: 42,
    }));
    const projectRoot = process.cwd();
    const service = createAppControlService({
      projectRoot,
      logger: createLogger(),
      resolveLaneId: () => "lane-1",
      ptyService: {
        create,
        onExit: vi.fn(() => () => {}),
        signalTerminal: vi.fn(),
      } as any,
    });

    try {
      const value = "C:\\Program Files\\ADE's $lane %TEMP% & café";
      await service.launch({
        command: `ADE_TEST="${value}" npx electron "C:\\Program Files\\My & App café"`,
        cwd: projectRoot,
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        command: "npx",
        args: [
          "electron",
          expect.stringMatching(/^--remote-debugging-port=\d+$/),
          "C:\\Program Files\\My & App café",
        ],
        startupCommand: expect.not.stringContaining("ADE_TEST="),
        env: expect.objectContaining({
          ADE_TEST: value,
          ADE_APP_CONTROL: "1",
        }),
      }));
    } finally {
      service.dispose();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("passes shell-specific Windows package-script commands through to the PTY", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      sessionId: "terminal-windows-shells",
      ptyId: "pty-windows-shells",
      pid: 42,
    }));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-shells-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      scripts: { dev: "echo preparing && electron ." },
    }), "utf8");
    const service = createAppControlService({
      projectRoot,
      logger: createLogger(),
      resolveLaneId: () => "lane-1",
      ptyService: {
        create,
        onExit: vi.fn(() => () => {}),
        signalTerminal: vi.fn(),
      } as any,
    });

    try {
      await service.launch({ command: "npm run dev", cwd: projectRoot });

      const createArgs = create.mock.calls[0]?.[0] as Record<string, any>;
      expect(createArgs).not.toHaveProperty("command");
      expect(createArgs.windowsStartupCommands.powershell).toContain("Set-Location -LiteralPath");
      expect(createArgs.windowsStartupCommands.powershell).not.toContain(" && ");
      expect(createArgs.windowsStartupCommands.cmd).toContain('cd /d "');
      expect(createArgs.windowsStartupCommands.cmd).toContain(" && ");
      expect(createArgs.windowsStartupCommands["git-bash"]).toMatch(/^cd -- \/[a-z]\//);
      expect(createArgs.windowsStartupCommands["git-bash"]).toContain(" && ");
      expect(createArgs.startupCommand).toBe(createArgs.windowsStartupCommands.powershell);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("preserves shell environment expansion for Electron launches outside Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      sessionId: "terminal-darwin",
      ptyId: "pty-darwin",
      pid: 42,
    }));
    const projectRoot = process.cwd();
    const service = createAppControlService({
      projectRoot,
      logger: createLogger(),
      resolveLaneId: () => "lane-1",
      ptyService: {
        create,
        onExit: vi.fn(() => () => {}),
        signalTerminal: vi.fn(),
      } as any,
    });

    try {
      await service.launch({
        command: 'ADE_TEST="$HOME" npx electron "."',
        cwd: projectRoot,
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        startupCommand: expect.stringContaining('ADE_TEST="$HOME"'),
      }));
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty("command");
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty("args");
    } finally {
      service.dispose();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
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

  it("can claim an active renderer for a lane without relaunching it", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const claimed = service.claim({ laneId: "lane-1", chatSessionId: "chat-1" });

    expect(claimed.activeSession).toMatchObject({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      cdpPort: 12345,
    });
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

  it("dispatches viewport-space clicks without screenshot scale conversion", async () => {
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

    await service.click({ x: 20, y: 40, scale: 2, coordinateSpace: "viewport" });

    const mouseEvents = socket!.sent
      .map((payload) => JSON.parse(payload) as { method: string; params?: { type?: string; x?: number; y?: number } })
      .filter((message) => message.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.map((event) => ({ x: event.params?.x, y: event.params?.y }))).toEqual([
      { x: 20, y: 40 },
      { x: 20, y: 40 },
    ]);
  });

  it("normalizes screenshot-space input with independent screencast x/y scales", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const socket = mockState.sockets.at(-1);
    expect(socket).toBeTruthy();
    socket!.emitMessage({
      method: "Page.screencastFrame",
      params: {
        data: mockState.screenshotData,
        sessionId: 1,
        metadata: { deviceWidth: 0.5, deviceHeight: 0.25, pageScaleFactor: 2 },
      },
    });
    socket!.sent.length = 0;

    await service.click({ x: 20, y: 40 });

    const mouseEvents = socket!.sent
      .map((payload) => JSON.parse(payload) as { method: string; params?: { type?: string; x?: number; y?: number } })
      .filter((message) => message.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.map((event) => ({ x: event.params?.x, y: event.params?.y }))).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ]);
  });

  it("uses CDP node lookup for point inspection", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);
    mockState.runtimeValues.push({
      url: "app://test",
      title: "Test app",
      viewport: { width: 100, height: 80, devicePixelRatio: 2 },
      elements: [{
        tagName: "button",
        role: "button",
        label: "Save",
        value: null,
        selector: "button.save",
        testId: "save-button",
        rect: { x: 10, y: 10, width: 40, height: 20 },
        metadata: {},
      }],
    });

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const result = await service.inspectPoint({
      x: 20,
      y: 20,
      coordinateSpace: "viewport",
      includeScreenshot: false,
    });

    expect(result.snapshot.hitElement?.label).toBe("Save");
    const socket = mockState.sockets.at(-1);
    const methods = socket!.sent.map((payload) => JSON.parse(payload) as { method: string }).map((message) => message.method);
    expect(methods).toContain("DOM.getNodeForLocation");
    expect(methods).toContain("Runtime.callFunctionOn");
  });

  it("returns coordinate fallback context for point inspection when CDP misses the DOM", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);
    mockState.cdpResults.push({ method: "DOM.getNodeForLocation", result: {} });
    mockState.runtimeValues.push({
      url: "app://test",
      title: "Test app",
      viewport: { width: 100, height: 80, devicePixelRatio: 2 },
      elements: [],
    });

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const result = await service.inspectPoint({
      x: 20,
      y: 40,
      coordinateSpace: "viewport",
      includeScreenshot: false,
    });

    expect(result.source).toBe("coordinate-fallback");
    expect(result.item).toEqual(expect.objectContaining({
      provider: "coordinate-fallback",
      componentId: "App coordinate",
      frame: expect.objectContaining({ width: 1, height: 1 }),
    }));
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

  it("clears the bounded capture timeout after successful screenshots", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const timerCountBeforeCapture = vi.getTimerCount();

    const screenshotPromise = service.screenshot();
    await vi.advanceTimersByTimeAsync(100);
    const screenshot = await screenshotPromise;

    expect(screenshot.width).toBe(1);
    expect(screenshot.height).toBe(1);
    expect(vi.getTimerCount()).toBe(timerCountBeforeCapture);
  });

  it("raises and minimizes the controlled window only through explicit window controls", async () => {
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

    await service.focusWindow();
    await service.minimizeWindow();

    const messages = socket!.sent.map((payload) => JSON.parse(payload) as { method: string; params?: { bounds?: { windowState?: string } } });
    expect(messages.filter((message) => message.method === "Browser.setWindowBounds").map((message) => message.params?.bounds?.windowState)).toEqual([
      "normal",
      "minimized",
    ]);
    expect(messages.filter((message) => message.method === "Page.bringToFront")).toHaveLength(1);
  });

  it("fails closed when explicit CDP window controls are unavailable", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);
    mockState.cdpResults.push({ method: "Browser.getWindowForTarget", result: {} });

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const socket = mockState.sockets.at(-1);
    expect(socket).toBeTruthy();
    socket!.sent.length = 0;

    await expect(service.focusWindow()).rejects.toThrow("Could not show the controlled app window");
    const messages = socket!.sent.map((payload) => JSON.parse(payload) as { method: string });
    expect(messages.map((message) => message.method)).toEqual(["Browser.getWindowForTarget"]);
  });

  it("wraps non-macOS CDP window-control failures with action context", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const targetA = target("a");
      mockState.httpResponses.push([targetA]);
      mockState.cdpResults.push({ method: "Browser.getWindowForTarget", result: {} });

      const service = createAppControlService({
        projectRoot: "/tmp/project",
        logger: createLogger(),
      });

      await service.connect({ cdpPort: 12345, force: true });
      await expect(service.minimizeWindow()).rejects.toThrow(
        "Could not minimize the controlled app window: The active CDP target does not expose a browser window id.",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
