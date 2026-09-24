/**
 * The App Control recorder for Windows and Linux, hosted by the ADE desktop app.
 *
 * macOS records the app's window with the desktop helper. Windows and Linux
 * have no such helper and the runtime has no encoder (no ffmpeg), so the CDP
 * screencast frames App Control already receives are encoded here, in a
 * hidden renderer: each JPEG frame is drawn on a canvas, and MediaRecorder
 * encodes the canvas stream (mp4/H.264 when Chromium offers it, else webm).
 *
 * Electron main process only: it imports `electron`. The runtime daemon does
 * not load this module; it reaches the host through whatever the desktop
 * wires as `getScreencastRecorder` (in-process, or the desktop bridge).
 *
 * Idle handling matches the window recorder's idle cut: the screencast sends
 * a frame only when the page repaints, so when frames stop for
 * `IDLE_PAUSE_MS` the recorder pauses, and the next frame resumes it. The
 * paused time is `idleCutMs`. With `keepIdle` the recorder never pauses and
 * the last frame is re-sent once a second, so the video keeps real time.
 */

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import type { AppControlScreencastFrame } from "../../../shared/types/appControl";
import type { Logger } from "../logging/logger";
import type {
  AppControlRecordingFinish,
  AppControlScreencastRecorderBackend,
} from "./appControlRecording";

/** Frames stop for this long → the recording pauses (the idle cut). */
const IDLE_PAUSE_MS = 1_500;
/** How often encoded bytes are pulled out of the renderer and appended to the file. */
const DRAIN_INTERVAL_MS = 1_000;
/** Bounds every call into the hidden renderer; a wedged one must not wedge a stop. */
const RENDERER_CALL_TIMEOUT_MS = 10_000;

/**
 * Runs inside the hidden renderer. Plain script, no imports: it is evaluated
 * with `executeJavaScript` into a data: page.
 */
const RECORDER_SOURCE = String.raw`
(() => {
  if (window.__adeAppControlRecorder) return true;
  const state = {
    mime: "",
    keepIdle: false,
    idleMs: 1500,
    canvas: document.getElementById("c"),
    ctx: null,
    track: null,
    recorder: null,
    chunks: [],
    startedAt: 0,
    pausedAt: 0,
    pausedTotal: 0,
    lastFrameAt: 0,
    frames: 0,
    ticker: null,
    stopped: false,
  };
  const pickMime = () => {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    return candidates.find((mime) => window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) || "";
  };
  const begin = (width, height) => {
    const w = Math.max(2, width - (width % 2));
    const h = Math.max(2, height - (height % 2));
    state.canvas.width = w;
    state.canvas.height = h;
    state.ctx = state.canvas.getContext("2d");
    const stream = state.canvas.captureStream(0);
    state.track = stream.getVideoTracks()[0];
    state.recorder = new MediaRecorder(stream, state.mime ? { mimeType: state.mime, videoBitsPerSecond: 4000000 } : {});
    state.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) state.chunks.push(event.data);
    };
    state.recorder.start(1000);
    state.startedAt = performance.now();
    state.ticker = setInterval(() => {
      if (!state.recorder || state.stopped) return;
      if (state.keepIdle) {
        if (state.recorder.state === "recording" && performance.now() - state.lastFrameAt >= 1000) {
          state.track.requestFrame();
        }
        return;
      }
      if (state.recorder.state === "recording" && performance.now() - state.lastFrameAt > state.idleMs) {
        state.recorder.pause();
        state.pausedAt = performance.now();
      }
    }, 250);
  };
  const decode = (base64, mime) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: mime }));
  };
  const encode = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  window.__adeAppControlRecorder = {
    pickMime,
    configure(options) {
      state.mime = options.mime || "";
      state.keepIdle = Boolean(options.keepIdle);
      state.idleMs = Number(options.idleMs) || 1500;
      return true;
    },
    async frame(base64, mime) {
      if (state.stopped) return false;
      const bitmap = await decode(base64, mime);
      try {
        if (!state.recorder) begin(bitmap.width, bitmap.height);
        if (state.recorder.state === "paused") {
          state.pausedTotal += performance.now() - state.pausedAt;
          state.pausedAt = 0;
          state.recorder.resume();
        }
        const W = state.canvas.width;
        const H = state.canvas.height;
        const scale = Math.min(W / bitmap.width, H / bitmap.height);
        const dw = bitmap.width * scale;
        const dh = bitmap.height * scale;
        state.ctx.fillStyle = "#000";
        state.ctx.fillRect(0, 0, W, H);
        state.ctx.drawImage(bitmap, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } finally {
        bitmap.close();
      }
      state.lastFrameAt = performance.now();
      state.frames += 1;
      state.track.requestFrame();
      return true;
    },
    async drain() {
      if (!state.chunks.length) return "";
      const parts = state.chunks.splice(0);
      return encode(await new Blob(parts).arrayBuffer());
    },
    stop() {
      state.stopped = true;
      if (state.ticker) clearInterval(state.ticker);
      if (!state.recorder) return Promise.resolve({ frames: 0, durationMs: 0, wallDurationMs: 0, idleCutMs: 0 });
      const now = performance.now();
      if (state.recorder.state === "paused" && state.pausedAt) state.pausedTotal += now - state.pausedAt;
      const wall = Math.max(0, now - state.startedAt);
      const idle = Math.min(wall, state.pausedTotal);
      return new Promise((resolve) => {
        state.recorder.onstop = () => resolve({
          frames: state.frames,
          durationMs: Math.round(wall - idle),
          wallDurationMs: Math.round(wall),
          idleCutMs: Math.round(idle),
        });
        state.recorder.stop();
      });
    },
  };
  return true;
})()
`;

const RECORDER_PAGE = "data:text/html;charset=utf-8,"
  + encodeURIComponent("<!doctype html><meta charset=utf-8><title>ADE App Control recorder</title><canvas id=c></canvas>");

type Entry = {
  window: BrowserWindow;
  filePath: string;
  file: fs.promises.FileHandle;
  drainTimer: ReturnType<typeof setInterval> | null;
  /** Serialises every renderer call and file append for this recording. */
  queue: Promise<unknown>;
  busy: boolean;
  pendingFrame: AppControlScreencastFrame | null;
  stopping: boolean;
};

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), RENDERER_CALL_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createAppControlScreencastRecorderHost(deps: { logger: Logger }): AppControlScreencastRecorderBackend & {
  dispose(): void;
} {
  const entries = new Map<string, Entry>();

  const call = <T,>(entry: Entry, source: string, label: string): Promise<T> =>
    withTimeout(entry.window.webContents.executeJavaScript(source, true) as Promise<T>, label);

  const drainOnce = async (entry: Entry): Promise<number> => {
    const base64 = await call<string>(entry, "window.__adeAppControlRecorder.drain()", "recorder drain");
    if (!base64) return 0;
    const bytes = Buffer.from(base64, "base64");
    await entry.file.write(bytes);
    return bytes.length;
  };

  const enqueue = <T,>(entry: Entry, task: () => Promise<T>): Promise<T> => {
    const run = entry.queue.then(task, task);
    entry.queue = run.catch(() => {});
    return run;
  };

  const teardown = async (key: string, entry: Entry, removeFile: boolean): Promise<void> => {
    entries.delete(key);
    if (entry.drainTimer) clearInterval(entry.drainTimer);
    entry.drainTimer = null;
    await entry.file.close().catch(() => {});
    if (!entry.window.isDestroyed()) entry.window.destroy();
    if (removeFile) await fs.promises.rm(entry.filePath, { force: true }).catch(() => {});
  };

  const sendFrame = (key: string, entry: Entry, frame: AppControlScreencastFrame): void => {
    entry.busy = true;
    void enqueue(entry, () => call(
      entry,
      `window.__adeAppControlRecorder.frame(${JSON.stringify(frame.data)}, ${JSON.stringify(frame.mimeType)})`,
      "recorder frame",
    ))
      .catch((error: unknown) => {
        deps.logger.debug("app_control.screencast_recorder.frame_failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        entry.busy = false;
        const next = entry.pendingFrame;
        entry.pendingFrame = null;
        if (next && !entry.stopping && entries.get(key) === entry) sendFrame(key, entry, next);
      });
  };

  return {
    async start(args) {
      if (entries.has(args.key)) throw new Error(`A recording for ${args.key} is already running.`);
      const window = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        skipTaskbar: true,
        webPreferences: {
          // Hidden and must keep its timers: the idle ticker and MediaRecorder's
          // timeslice both stall under background throttling.
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await window.loadURL(RECORDER_PAGE);
        await withTimeout(window.webContents.executeJavaScript(RECORDER_SOURCE, true), "recorder setup");
        const mime = String(await withTimeout(
          window.webContents.executeJavaScript("window.__adeAppControlRecorder.pickMime()", true),
          "recorder codec probe",
        ) ?? "");
        if (!mime) throw new Error("This machine's Chromium has no MediaRecorder video codec.");
        await withTimeout(window.webContents.executeJavaScript(
          `window.__adeAppControlRecorder.configure(${JSON.stringify({ mime, keepIdle: args.keepIdle, idleMs: IDLE_PAUSE_MS })})`,
          true,
        ), "recorder configure");
        const extension = mime.startsWith("video/mp4") ? ".mp4" : ".webm";
        const filePath = `${args.filePath.slice(0, args.filePath.length - path.extname(args.filePath).length)}${extension}`;
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const file = await fs.promises.open(filePath, "w");
        const entry: Entry = {
          window,
          filePath,
          file,
          drainTimer: null,
          queue: Promise.resolve(),
          busy: false,
          pendingFrame: null,
          stopping: false,
        };
        entry.drainTimer = setInterval(() => {
          void enqueue(entry, () => drainOnce(entry)).catch((error: unknown) => {
            deps.logger.debug("app_control.screencast_recorder.drain_failed", {
              key: args.key,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, DRAIN_INTERVAL_MS);
        entries.set(args.key, entry);
        // A closed renderer (crash, GPU loss) ends the recording's source;
        // the stop that follows reports what was written.
        window.webContents.once("render-process-gone", () => {
          deps.logger.warn("app_control.screencast_recorder.renderer_gone", { key: args.key });
        });
        deps.logger.info("app_control.screencast_recorder.started", { key: args.key, mime, keepIdle: args.keepIdle });
        return { filePath };
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    },

    pushFrame(key, frame) {
      const entry = entries.get(key);
      if (!entry || entry.stopping || !frame.data) return;
      // Latest wins: a frame that arrives while one is still being drawn
      // replaces the waiting one, so a burst never builds a backlog.
      if (entry.busy) {
        entry.pendingFrame = frame;
        return;
      }
      sendFrame(key, entry, frame);
    },

    async stop(key): Promise<AppControlRecordingFinish> {
      const entry = entries.get(key);
      if (!entry) throw new Error(`No App Control recording is running for ${key}.`);
      entry.stopping = true;
      entry.pendingFrame = null;
      if (entry.drainTimer) clearInterval(entry.drainTimer);
      entry.drainTimer = null;
      try {
        const lengths = await enqueue(entry, () => call<{
          frames: number;
          durationMs: number;
          wallDurationMs: number;
          idleCutMs: number;
        }>(entry, "window.__adeAppControlRecorder.stop()", "recorder stop"));
        // MediaRecorder hands its last chunk over on stop; drain until empty.
        for (let i = 0; i < 10; i += 1) {
          if ((await enqueue(entry, () => drainOnce(entry))) === 0) break;
        }
        if (!lengths || lengths.frames <= 0) {
          await teardown(key, entry, true);
          throw new Error("The recording captured no frames: the app did not paint while it was running.");
        }
        await teardown(key, entry, false);
        return {
          filePath: entry.filePath,
          durationMs: Math.max(0, lengths.durationMs),
          wallDurationMs: Math.max(0, lengths.wallDurationMs),
          idleCutMs: Math.max(0, lengths.idleCutMs),
        };
      } catch (error) {
        if (entries.get(key) === entry) await teardown(key, entry, false);
        throw error;
      }
    },

    cancel(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.stopping = true;
      void teardown(key, entry, true);
    },

    dispose() {
      for (const [key, entry] of [...entries]) {
        entry.stopping = true;
        void teardown(key, entry, false);
      }
    },
  };
}
