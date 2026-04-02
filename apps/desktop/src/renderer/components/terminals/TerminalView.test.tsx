/* @vitest-environment jsdom */

import React from "react";
import { act, render, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  terminalInstances: [] as Array<Record<string, unknown>>,
  nextFitDims: { cols: 120, rows: 40 },
  shouldThrowWebglAddon: false,
  lastContextLossHandler: null as (() => void) | null,
}));

const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
}

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(_callback: IntersectionObserverCallback) {}
}

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: { theme: "dark" }) => unknown) => selector({ theme: "dark" })),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: Record<string, unknown>;
    focus = vi.fn();
    blur = vi.fn();
    write = vi.fn();
    refresh = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    scrollToBottom = vi.fn();
    dispose = vi.fn();
    clearTextureAtlas = vi.fn();
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn((addon: { activate?: (term: unknown) => void }) => {
      addon.activate?.(this);
    });

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mockState.terminalInstances.push(this as unknown as Record<string, unknown>);
    }

    open(host: HTMLElement) {
      this.element = host;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    private terminal: { cols: number; rows: number } | null = null;

    activate(term: { cols: number; rows: number }) {
      this.terminal = term;
    }

    fit() {
      if (!this.terminal) throw new Error("fit called before activate");
      this.terminal.cols = mockState.nextFitDims.cols;
      this.terminal.rows = mockState.nextFitDims.rows;
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    dispose = vi.fn();

    constructor() {
      if (mockState.shouldThrowWebglAddon) {
        throw new Error("webgl unavailable");
      }
    }

    onContextLoss(cb: () => void) {
      mockState.lastContextLossHandler = cb;
    }
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalView, getTerminalRuntimeSnapshot } from "./TerminalView";

function installWindowAde() {
  (window as any).ade = {
    pty: {
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    },
    sessions: {
      readTranscriptTail: vi.fn().mockResolvedValue(""),
    },
  };
}

async function flushAllTimers() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function triggerResizeObserver() {
  const latest = resizeObservers.at(-1);
  if (!latest) throw new Error("ResizeObserver not installed");
  latest.callback([], latest as unknown as ResizeObserver);
}

function terminalWidthFor(element: HTMLElement): number {
  if (element.getAttribute("data-ade-terminal-parking") === "true") return 0;
  if (element.classList.contains("ade-terminal-host")) return 640;
  if (element.parentElement?.classList.contains("ade-terminal-host")) return 640;
  return 320;
}

function terminalHeightFor(element: HTMLElement): number {
  if (element.getAttribute("data-ade-terminal-parking") === "true") return 0;
  if (element.classList.contains("ade-terminal-host")) return 360;
  if (element.parentElement?.classList.contains("ade-terminal-host")) return 360;
  return 180;
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  vi.stubGlobal("visualViewport", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return terminalWidthFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return terminalHeightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return terminalWidthFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return terminalHeightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const width = terminalWidthFor(this as HTMLElement);
      const height = terminalHeightFor(this as HTMLElement);
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      };
    },
  });
});

describe("TerminalView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    cleanup();
    installWindowAde();
    resizeObservers.length = 0;
    mockState.terminalInstances.length = 0;
    mockState.nextFitDims = { cols: 120, rows: 40 };
    mockState.shouldThrowWebglAddon = false;
    mockState.lastContextLossHandler = null;
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.useRealTimers();
  });

  it("fits to the container and resizes the PTY when the fit result is valid", async () => {
    render(<TerminalView ptyId="pty-valid" sessionId="session-valid" isActive />);
    await flushAllTimers();

    const runtime = getTerminalRuntimeSnapshot("session-valid");
    expect(runtime?.renderer).toBe("webgl");
    expect(runtime?.health.fitRecoveries).toBe(0);
    expect((window as any).ade.pty.resize).toHaveBeenCalledWith({
      ptyId: "pty-valid",
      cols: 120,
      rows: 40,
    });
  });

  it("rejects implausible fit results, restores the last good size, and skips PTY resize", async () => {
    render(<TerminalView ptyId="pty-recover" sessionId="session-recover" isActive />);
    await flushAllTimers();

    const resizeSpy = (window as any).ade.pty.resize as { mock: { calls: unknown[][] } };
    const resizeCallCount = resizeSpy.mock.calls.length;
    expect(resizeCallCount).toBeGreaterThan(0);

    mockState.nextFitDims = { cols: 1, rows: 1 };
    triggerResizeObserver();
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      resize: ReturnType<typeof vi.fn>;
      cols: number;
      rows: number;
    } | undefined;
    const runtime = getTerminalRuntimeSnapshot("session-recover");
    expect(terminal?.resize).toHaveBeenLastCalledWith(120, 40);
    expect(terminal?.cols).toBe(120);
    expect(terminal?.rows).toBe(40);
    expect(resizeSpy.mock.calls).toHaveLength(resizeCallCount);
    expect(runtime?.health.fitRecoveries).toBe(1);
  });

  it("stays unfocused while inactive and only focuses once the terminal becomes active", async () => {
    const view = render(<TerminalView ptyId="pty-inactive" sessionId="session-inactive" isActive={false} />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      focus: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal?.focus).not.toHaveBeenCalled();

    view.rerender(<TerminalView ptyId="pty-inactive" sessionId="session-inactive" isActive />);
    await flushAllTimers();

    expect(terminal?.focus).toHaveBeenCalled();
  });

  it("keeps fitting visible inactive terminals without focusing them", async () => {
    render(<TerminalView ptyId="pty-visible" sessionId="session-visible" isActive={false} isVisible />);
    await flushAllTimers();

    const resizeSpy = (window as any).ade.pty.resize as ReturnType<typeof vi.fn>;
    const terminal = mockState.terminalInstances.at(-1) as {
      focus: ReturnType<typeof vi.fn>;
    } | undefined;

    expect(resizeSpy).toHaveBeenCalledWith({
      ptyId: "pty-visible",
      cols: 120,
      rows: 40,
    });
    expect(terminal?.focus).not.toHaveBeenCalled();

    mockState.nextFitDims = { cols: 140, rows: 44 };
    triggerResizeObserver();
    await flushAnimationFrame();

    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-visible",
      cols: 140,
      rows: 44,
    });
    expect(terminal?.focus).not.toHaveBeenCalled();
  });

  it("falls back to the DOM renderer when webgl initialization fails", async () => {
    mockState.shouldThrowWebglAddon = true;

    render(<TerminalView ptyId="pty-dom" sessionId="session-dom" isActive />);
    await flushAllTimers();

    const runtime = getTerminalRuntimeSnapshot("session-dom");
    expect(runtime?.renderer).toBe("dom");
    expect(runtime?.health.rendererFallbacks).toBeGreaterThanOrEqual(0);
  });
});
