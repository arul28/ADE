import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderScenePreview } from "./scenePreviewRenderer";

/**
 * `ade scene preview` draws agent-authored code in a hidden Chromium window.
 * The two safety contracts that matter operationally are that a scene stuck in
 * an endless loop cannot pin the renderer forever, and that the preview session
 * refuses every network request the scene tries to make.
 */

type RequestListener = (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void;

const hoisted = vi.hoisted(() => {
  const state = {
    webRequestListeners: [] as RequestListener[],
    windows: [] as Array<Record<string, unknown>>,
    webContents: [] as Array<Record<string, unknown>>,
    // Flipped by the endless-loop test so every renderer hangs on load.
    stuck: false,
  };

  class FakeWebContents {
    setWindowOpenHandler = vi.fn();
    on = vi.fn();
    loadURL = vi.fn(async () => {
      if (state.stuck) return await new Promise(() => {});
    });
    executeJavaScript = vi.fn(async () => ({ readyMs: 1, settledMs: 2, height: 120, errors: [] }));
    capturePage = vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") }));
    forcefullyCrashRenderer = vi.fn();
  }

  class FakeBrowserWindow {
    webContents = new FakeWebContents();
    destroyed = false;
    isDestroyed = vi.fn(() => this.destroyed);
    destroy = vi.fn(() => { this.destroyed = true; });
    setContentSize = vi.fn();
    constructor() {
      state.windows.push(this as unknown as Record<string, unknown>);
      state.webContents.push(this.webContents as unknown as Record<string, unknown>);
    }
  }

  const fakeSession = {
    webRequest: { onBeforeRequest: vi.fn((listener: RequestListener) => { state.webRequestListeners.push(listener); }) },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };

  return { state, FakeBrowserWindow, fakeSession };
});

vi.mock("electron", () => ({
  BrowserWindow: hoisted.FakeBrowserWindow,
  session: { fromPartition: vi.fn(() => hoisted.fakeSession) },
}));

function deps() {
  const rendererDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-prev-"));
  return { appPath: rendererDir, rendererDir };
}

afterEach(() => {
  vi.useRealTimers();
  hoisted.state.stuck = false;
});

describe("renderScenePreview", () => {
  it("renders a scene and answers with a picture", async () => {
    const result = await renderScenePreview(
      { source: '<!-- @scene title="Chart" data="lanes" -->\n<p>3</p>' },
      deps(),
    );

    expect(result.readyMs).toBe(1);
    expect(result.settledMs).toBe(2);
    expect(result.screenshotBase64).toBeTruthy();
  });

  it("refuses every network request at the preview session, and allows data URLs", async () => {
    await renderScenePreview({ source: "<p>x</p>" }, deps());

    const listeners = hoisted.state.webRequestListeners;
    expect(listeners.length).toBeGreaterThan(0);
    const listener = listeners[listeners.length - 1]!;

    const refused = vi.fn();
    listener({ url: "https://cdn.example/steal.png" }, refused);
    expect(refused).toHaveBeenCalledWith({ cancel: true });

    const allowed = vi.fn();
    listener({ url: "data:image/png;base64,AAAA" }, allowed);
    expect(allowed).toHaveBeenCalledWith({ cancel: false });
  });

  it("stops a scene stuck in an endless loop at the hard deadline", async () => {
    vi.useFakeTimers();
    hoisted.state.stuck = true;

    const promise = renderScenePreview({ source: "<p>x</p>" }, deps());
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await promise;

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.kind).toBe("timeout");
    expect(result.problems[0]!.message).toMatch(/endless loop/i);
    expect(result.screenshotBase64).toBeNull();
    const stuckContents = hoisted.state.webContents[hoisted.state.webContents.length - 1]!;
    expect(stuckContents.forcefullyCrashRenderer).toHaveBeenCalled();
  });
});
