import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

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

const claudeConfigDir = path.join(os.tmpdir(), "ade-vitest-claude-config");

fs.mkdirSync(path.join(claudeConfigDir, "debug"), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

// jsdom doesn't implement scrollTo on elements; stub it globally for tests.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

// jsdom doesn't implement matchMedia; stub it for components that read
// `prefers-color-scheme` or `prefers-reduced-motion` (e.g. border-beam).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

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
