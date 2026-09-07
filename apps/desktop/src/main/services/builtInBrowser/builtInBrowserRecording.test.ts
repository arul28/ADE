import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_BROWSER_RECORDING_MIME_TYPES,
  createBuiltInBrowserRecordingSession,
  createDisplayMediaRecorderFactory,
  type BuiltInBrowserTabRecorder,
  type CaptureWindowLike,
} from "./builtInBrowserRecording";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-rec-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function stubRecorder(overrides: Partial<BuiltInBrowserTabRecorder> = {}): BuiltInBrowserTabRecorder {
  return {
    format: "webm",
    mimeType: "video/webm",
    start: vi.fn(async () => undefined),
    stop: vi.fn(async ({ durationMs }) => ({
      filePath: "/tmp/rec.webm",
      frameCount: Math.round((durationMs / 1_000) * 30),
      manifestPath: null,
    })),
    abort: vi.fn(),
    ...overrides,
  };
}

/** Minimal stand-in for the hidden capture BrowserWindow. */
function fakeCaptureWindow(options: {
  onStart?: () => unknown;
  chunks?: string[][];
  finalChunks?: string[];
} = {}) {
  const takeQueue = [...(options.chunks ?? [])];
  const calls: Array<{ code: string; userGesture?: boolean }> = [];
  let destroyed = false;
  const win: CaptureWindowLike & { calls: typeof calls; isDestroyedFlag: () => boolean } = {
    calls,
    isDestroyedFlag: () => destroyed,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      mainFrame: { frameTreeNodeId: 4242 },
      loadURL: vi.fn(async () => undefined),
      executeJavaScript: vi.fn(async (code: string, userGesture?: boolean) => {
        calls.push({ code, userGesture });
        if (code.includes("getDisplayMedia")) {
          return options.onStart?.() ?? { mimeType: "video/mp4;codecs=avc1", frameRate: 60 };
        }
        if (code.includes("__adeCaptureTake")) return takeQueue.shift() ?? [];
        if (code.includes("__adeCaptureStop")) return options.finalChunks ?? [];
        return null;
      }),
    },
  };
  return win;
}

describe("browser recording session state machine", () => {
  it("starts the recorder and reports fps, caption and a start timestamp", async () => {
    const recorder = stubRecorder();
    let clock = 1_000;
    const session = await createBuiltInBrowserRecordingSession({
      id: "rec-1",
      directory: scratchDir(),
      fps: 60,
      caption: "Checkout flow",
      createRecorder: async () => recorder,
      now: () => clock,
    });

    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(session.fps).toBe(60);
    expect(session.caption).toBe("Checkout flow");
    expect(session.startedAt).toBe(new Date(1_000).toISOString());

    clock = 4_000;
    const result = await session.stop();
    expect(result.durationMs).toBe(3_000);
    expect(result.format).toBe("webm");
    expect(result.mimeType).toBe("video/webm");
    expect(result.frameCount).toBe(90);
  });

  it("refuses a second stop", async () => {
    const session = await createBuiltInBrowserRecordingSession({
      id: "rec-2",
      directory: scratchDir(),
      fps: 30,
      caption: null,
      createRecorder: async () => stubRecorder(),
    });
    await session.stop();
    await expect(session.stop()).rejects.toThrow(/already stopped/);
  });

  it("aborts the recorder when the session is abandoned, and stays stopped", async () => {
    const recorder = stubRecorder();
    const session = await createBuiltInBrowserRecordingSession({
      id: "rec-3",
      directory: scratchDir(),
      fps: 30,
      caption: null,
      createRecorder: async () => recorder,
    });
    session.abort();
    expect(recorder.abort).toHaveBeenCalledTimes(1);
    await expect(session.stop()).rejects.toThrow(/already stopped/);
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it("aborts the recorder and surfaces the error when start fails", async () => {
    const recorder = stubRecorder({
      start: vi.fn(async () => {
        throw new Error("Permission denied by the display media handler.");
      }),
    });
    await expect(createBuiltInBrowserRecordingSession({
      id: "rec-4",
      directory: scratchDir(),
      fps: 30,
      caption: null,
      createRecorder: async () => recorder,
    })).rejects.toThrow(/Permission denied/);
    expect(recorder.abort).toHaveBeenCalledTimes(1);
  });

  it("creates the recording directory up front", async () => {
    const directory = path.join(scratchDir(), "nested", "rec-5");
    await createBuiltInBrowserRecordingSession({
      id: "rec-5",
      directory,
      fps: 30,
      caption: null,
      createRecorder: async () => stubRecorder(),
    });
    expect(fs.existsSync(directory)).toBe(true);
  });
});

describe("display-media recorder", () => {
  it("arms the capture frame, starts with a synthetic user gesture, and writes chunks", async () => {
    const directory = scratchDir();
    const win = fakeCaptureWindow({
      finalChunks: [Buffer.from("hello ").toString("base64"), Buffer.from("world").toString("base64")],
    });
    const armed: number[] = [];
    let disarmed = 0;
    const factory = createDisplayMediaRecorderFactory({
      createCaptureWindow: () => win,
      armDisplayMedia: (frameTreeNodeId) => {
        armed.push(frameTreeNodeId);
        return () => {
          disarmed += 1;
        };
      },
      pollIntervalMs: 10_000,
    });

    const recorder = await factory({ id: "rec-a", directory, fps: 60 });
    await recorder.start();

    expect(armed).toEqual([4242]);
    const startCall = win.calls.find((call) => call.code.includes("getDisplayMedia"));
    expect(startCall?.userGesture).toBe(true);
    // The negotiated mime type decides both the container and the file name.
    expect(recorder.mimeType).toBe("video/mp4;codecs=avc1");
    expect(recorder.format).toBe("mp4");

    const result = await recorder.stop({ durationMs: 2_000 });
    expect(result.filePath).toBe(path.join(directory, "rec-a.mp4"));
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("hello world");
    // 2s at the negotiated 60fps.
    expect(result.frameCount).toBe(120);
    expect(result.manifestPath).toBeNull();
    expect(disarmed).toBe(1);
    expect(win.isDestroyedFlag()).toBe(true);
  });

  it("falls back to webm when the page negotiates a webm profile", async () => {
    const directory = scratchDir();
    const win = fakeCaptureWindow({
      onStart: () => ({ mimeType: "video/webm;codecs=vp9", frameRate: 30 }),
      finalChunks: [Buffer.from("webm").toString("base64")],
    });
    const factory = createDisplayMediaRecorderFactory({
      createCaptureWindow: () => win,
      armDisplayMedia: () => () => undefined,
      pollIntervalMs: 10_000,
    });
    const recorder = await factory({ id: "rec-b", directory, fps: 30 });
    await recorder.start();
    expect(recorder.format).toBe("webm");
    const result = await recorder.stop({ durationMs: 1_000 });
    expect(result.filePath).toBe(path.join(directory, "rec-b.webm"));
    expect(result.frameCount).toBe(30);
  });

  it("prefers mp4/avc1 before webm in its codec preference list", () => {
    expect(BUILT_IN_BROWSER_RECORDING_MIME_TYPES[0]).toBe("video/mp4;codecs=avc1");
    const firstWebm = BUILT_IN_BROWSER_RECORDING_MIME_TYPES.findIndex((mime) => mime.startsWith("video/webm"));
    const lastMp4 = BUILT_IN_BROWSER_RECORDING_MIME_TYPES
      .map((mime, index) => ({ mime, index }))
      .filter(({ mime }) => mime.startsWith("video/mp4"))
      .at(-1)?.index ?? -1;
    expect(lastMp4).toBeLessThan(firstWebm);
  });

  it("tears down the capture window and disarms when aborted before stop", async () => {
    const win = fakeCaptureWindow();
    let disarmed = 0;
    const factory = createDisplayMediaRecorderFactory({
      createCaptureWindow: () => win,
      armDisplayMedia: () => () => {
        disarmed += 1;
      },
      pollIntervalMs: 10_000,
    });
    const recorder = await factory({ id: "rec-c", directory: scratchDir(), fps: 30 });
    await recorder.start();
    recorder.abort();
    expect(disarmed).toBe(1);
    expect(win.isDestroyedFlag()).toBe(true);
    await expect(recorder.stop({ durationMs: 10 })).rejects.toThrow(/already torn down/);
  });
});
