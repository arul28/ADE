import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

type TestTempTrackerState = {
  installed: boolean;
  trackedDirs: Set<string>;
  originalMkdtempSync?: typeof fs.mkdtempSync;
  originalPromisesMkdtemp?: typeof fs.promises.mkdtemp;
};

const TEST_TEMP_TRACKER_KEY = Symbol.for("ade.desktop.testTempTracker");
const testTempRoot = path.resolve(os.tmpdir());

function getTestTempTrackerState(): TestTempTrackerState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[TEST_TEMP_TRACKER_KEY];
  if (existing) return existing as TestTempTrackerState;
  const created: TestTempTrackerState = {
    installed: false,
    trackedDirs: new Set<string>(),
  };
  (globalThis as Record<PropertyKey, unknown>)[TEST_TEMP_TRACKER_KEY] = created;
  return created;
}

function shouldTrackTempDir(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  const baseName = path.basename(resolved);
  return resolved.startsWith(`${testTempRoot}${path.sep}`) && baseName.startsWith("ade-");
}

function cleanupTrackedTempDirs(): void {
  const state = getTestTempTrackerState();
  const targets = [...state.trackedDirs].sort((left, right) => right.length - left.length);
  for (const target of targets) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      state.trackedDirs.delete(target);
    } catch {
      // Best-effort cleanup only for test temp roots.
    }
  }
}

function installTrackedTempCleanup(): void {
  const state = getTestTempTrackerState();
  if (state.installed) return;
  state.installed = true;
  state.originalMkdtempSync = fs.mkdtempSync.bind(fs);
  state.originalPromisesMkdtemp = fs.promises.mkdtemp.bind(fs.promises);

  fs.mkdtempSync = ((prefix: string, options?: Parameters<typeof fs.mkdtempSync>[1]) => {
    const created = state.originalMkdtempSync!(prefix, options);
    if (shouldTrackTempDir(created)) {
      state.trackedDirs.add(path.resolve(created));
    }
    return created;
  }) as typeof fs.mkdtempSync;

  fs.promises.mkdtemp = (async (prefix: string, options?: Parameters<typeof fs.promises.mkdtemp>[1]) => {
    const created = await state.originalPromisesMkdtemp!(prefix, options);
    if (shouldTrackTempDir(created)) {
      state.trackedDirs.add(path.resolve(created));
    }
    return created;
  }) as typeof fs.promises.mkdtemp;

  process.once("exit", cleanupTrackedTempDirs);
}

installTrackedTempCleanup();
afterAll(() => {
  cleanupTrackedTempDirs();
});

// Run as CI does, with no ADE environment of the shell that started the run.
// An ADE agent's shell carries its identity (`ADE_CHAT_SESSION_ID`,
// `ADE_ACTIVITY_SESSION_ID`, the brain's socket, …), and code under test reads
// it: a brain a test spawns from that shell took the agent role, so the pool
// refused it as incompatible and every such test failed inside an agent. A
// test that needs one of these sets it itself; the ones this file sets follow.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ADE_")) delete process.env[key];
}

const claudeConfigDir = path.join(os.tmpdir(), "ade-vitest-claude-config");

fs.mkdirSync(path.join(claudeConfigDir, "debug"), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
// Desktop sync-host unit tests use bootstrap-token clients and loopback port
// blockers; keep that harness on the explicit local-only sync bind mode.
process.env.ADE_SYNC_BIND_HOST = "127.0.0.1";

// jsdom doesn't implement scrollTo on elements; stub it globally for tests.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

// jsdom doesn't implement matchMedia; stub it for components that read
// `prefers-color-scheme` or `prefers-reduced-motion` (e.g. border-beam).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia,
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
  };
}

function ensureUsableLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    storage.setItem("__ade_vitest_local_storage_probe__", "1");
    storage.removeItem("__ade_vitest_local_storage_probe__");
    return;
  } catch {
    const storage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
}

ensureUsableLocalStorage();

function ensureWritableWindowAde(): void {
  if (typeof window === "undefined") return;
  const descriptor = Object.getOwnPropertyDescriptor(window, "ade");
  if (!descriptor || descriptor.writable !== false || descriptor.configurable !== true) return;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: descriptor.value,
  });
}

// jsdom runs every requestAnimationFrame callback from one setInterval, and
// starts that interval only when its count of waiting frames goes from 0 to 1.
// A test that fakes timers while a frame waits, then restores real timers,
// drops the interval with the frame still counted: no later frame in that file
// ever runs, and motion's frame loop (which keeps jsdom's rAF from import time
// and waits on its one scheduled frame) stops with it. Every later animation in
// the file then never starts or finishes. So each test starts by handing any
// frame still waiting back to jsdom, on the clock that test runs with.
// The handle a caller holds stays the same across that hand-back, so a later
// cancelAnimationFrame of it still cancels the frame.
const waitingFrames = new Map<number, { callback: FrameRequestCallback; scheduled: number }>();
let restartFrame: ((handle: number) => void) | null = null;
if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
  const requestFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  let nextHandle = 0;
  const schedule = (handle: number, callback: FrameRequestCallback): void => {
    const scheduled = requestFrame((now) => {
      waitingFrames.delete(handle);
      callback(now);
    });
    waitingFrames.set(handle, { callback, scheduled });
  };
  const request = (callback: FrameRequestCallback): number => {
    nextHandle += 1;
    schedule(nextHandle, callback);
    return nextHandle;
  };
  const cancel = (handle: number): void => {
    const waiting = waitingFrames.get(handle);
    if (!waiting) return;
    waitingFrames.delete(handle);
    cancelFrame(waiting.scheduled);
  };
  restartFrame = (handle) => {
    const waiting = waitingFrames.get(handle);
    if (!waiting) return;
    cancelFrame(waiting.scheduled);
    schedule(handle, waiting.callback);
  };
  window.requestAnimationFrame = request;
  window.cancelAnimationFrame = cancel;
  globalThis.requestAnimationFrame = request;
  globalThis.cancelAnimationFrame = cancel;
}

function restartWaitingFrames(): void {
  if (waitingFrames.size === 0 || vi.isFakeTimers() || !restartFrame) return;
  for (const handle of [...waitingFrames.keys()]) restartFrame(handle);
}

beforeEach(() => {
  restartWaitingFrames();
  ensureUsableLocalStorage();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may remain unavailable in a few non-jsdom unit tests.
    }
  }
  ensureWritableWindowAde();
});

afterEach(() => {
  ensureWritableWindowAde();
});

// nwsapi (jsdom's CSS selector engine) throws on Tailwind arbitrary-value
// class names like `rounded-[8px]` because `[` opens an attribute selector.
// Patch querySelector/querySelectorAll to swallow the SYNTAX_ERR (code 12)
// so @testing-library queries that walk the DOM don't crash.
if (typeof Element !== "undefined") {
  const origQS = Element.prototype.querySelector;
  Element.prototype.querySelector = function (selectors: string) {
    try {
      return origQS.call(this, selectors);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.code === 12 /* SYNTAX_ERR */) return null;
      throw err;
    }
  };
  const origQSA = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function (selectors: string) {
    try {
      return origQSA.call(this, selectors);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.code === 12 /* SYNTAX_ERR */) {
        return document.createDocumentFragment().querySelectorAll("*");
      }
      throw err;
    }
  };
}
