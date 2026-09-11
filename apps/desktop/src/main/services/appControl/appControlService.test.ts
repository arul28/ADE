import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import { gitBashPath, shellQuote } from "./appControlLaunchCommand";

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
import type { AppControlEventPayload } from "../../../shared/types";

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

  // Fake timers are installed per test here, so they have to be handed back per
  // test. Leaving them installed freezes `Date.now()` for everything that runs
  // afterwards, and the agent-actions block below mints observation ids from
  // it — four captures at one frozen millisecond leave the pruner nothing to
  // order by.
  afterEach(() => {
    vi.useRealTimers();
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
      // `projectRoot` is a host-native temp dir, so its shape differs per runner:
      // a drive-letter path on windows-latest, a plain POSIX path on ubuntu.
      // Derive the expected MSYS `cd` target from the fixture rather than hard
      // coding a drive-letter root; appControlLaunchCommand.test.ts pins the
      // drive-letter -> MSYS rewrite itself with literal inputs on every host.
      const expectedGitBashCd = `cd -- ${shellQuote(gitBashPath(projectRoot))} && `;
      expect(createArgs.windowsStartupCommands["git-bash"].slice(0, expectedGitBashCd.length))
        .toBe(expectedGitBashCd);
      expect(createArgs.windowsStartupCommands["git-bash"]).not.toContain(String.fromCharCode(92));
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

  // The target of App Control is an app under active debugging, so an error
  // loop used to produce one IPC event per console.error to every window. The
  // tally is coalesced on a trailing edge; a reset publishes immediately.
  it("coalesces diagnostics events across a burst of console errors and failed requests", async () => {
    const targetA = target("a");
    mockState.httpResponses.push([targetA]);
    const events: AppControlEventPayload[] = [];

    const service = createAppControlService({
      projectRoot: "/tmp/project",
      logger: createLogger(),
      onEvent: (payload) => events.push(payload),
    });

    await service.connect({ cdpPort: 12345, force: true });
    const socket = mockState.sockets.at(-1)!;
    const sessionId = service.getStatus().activeSession?.id;
    expect(sessionId).toBeTruthy();

    socket.emitMessage({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ value: "boom" }] },
    });
    socket.emitMessage({
      method: "Network.requestWillBeSent",
      params: { requestId: "r1", request: { url: "http://app.test/api", method: "GET" } },
    });
    socket.emitMessage({
      method: "Network.responseReceived",
      params: { requestId: "r1", response: { url: "http://app.test/api", status: 500 } },
    });

    // Nothing published yet: the burst is still inside the coalescing window.
    expect(events.filter((event) => event.type === "diagnostics")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);

    const diagnostics = events.filter((event) => event.type === "diagnostics");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics.at(-1)).toMatchObject({
      type: "diagnostics",
      sessionId,
      consoleErrorCount: 1,
      failedRequestCount: 1,
    });

    // A healthy response is not an error: nothing new is published for it.
    const before = diagnostics.length;
    socket.emitMessage({
      method: "Network.requestWillBeSent",
      params: { requestId: "r2", request: { url: "http://app.test/ok", method: "GET" } },
    });
    socket.emitMessage({
      method: "Network.responseReceived",
      params: { requestId: "r2", response: { url: "http://app.test/ok", status: 200 } },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter((event) => event.type === "diagnostics")).toHaveLength(before);

    // A main-frame navigation is a fresh page, so its predecessor's errors stop
    // counting and the tools pane's red dot goes out.
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "f1", url: "app://test/?view=a" } },
    });
    expect(events.filter((event) => event.type === "diagnostics").at(-1)).toMatchObject({
      consoleErrorCount: 0,
      failedRequestCount: 0,
    });
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

/* ── agent actions ─────────────────────────────────────────────────────── */
// Merged from appControlAgentActions.test.ts: it re-declared FakeCdpTarget,
// mockState, createLogger and target, and its CDP harness was a subset of the
// one above. One service, one harness.

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
