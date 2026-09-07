import fs from "node:fs/promises";
import path from "node:path";
import type { BuiltInBrowserRecordingFormat } from "../../../shared/types";

/**
 * Screen recording for browser tabs.
 *
 * ## Encoder decision
 *
 * The recording is produced by Chromium itself: a hidden, trusted capture page
 * calls `getDisplayMedia()` and pipes the resulting `MediaStreamTrack` into a
 * `MediaRecorder`. Electron's `session.setDisplayMediaRequestHandler` answers
 * that request with the *target tab's* `mainFrame`, so the compositor hands us
 * an already-encoded video stream — no per-frame shuttling, no muxing, and zero
 * new native dependencies on macOS, Windows and Linux.
 *
 * Rejected alternatives: CDP `Page.startScreencast` (JPEG frames still need a
 * muxer, and the debugger cannot be attached while DevTools is open),
 * `desktopCapturer` (captures the whole window/screen including ADE's own UI
 * and needs a macOS screen-recording TCC grant), and shelling out to `ffmpeg`
 * (not guaranteed to be installed, so recording would silently differ per
 * machine).
 *
 * Two details make this work for agents as well as humans:
 *
 * - **Arming.** `getDisplayMedia` is only answered while main has explicitly
 *   armed a `{requesterFrameNodeId → targetWebContents}` pair, for ~10s. Every
 *   other request — including any page in the browser partition trying to
 *   capture itself — is denied with `callback({})`.
 * - **Transient activation.** `getDisplayMedia` requires a user gesture, which
 *   an agent has no way to produce. `webContents.executeJavaScript(code, true)`
 *   supplies it, and because the capture page is ADE's own `about:blank` in a
 *   throwaway in-memory partition, that gesture is never granted to a site.
 *
 * **Trade-off:** the capture page holds encoded chunks in renderer memory
 * between polls. We drain it on the `MediaRecorder` timeslice (1s) and append
 * straight to disk, so peak memory is roughly one second of video rather than
 * the whole recording — but a wedged capture renderer still loses whatever it
 * had not yet handed over.
 */

export type BuiltInBrowserRecorderResult = {
  filePath: string;
  frameCount: number;
  manifestPath: string | null;
};

export type BuiltInBrowserTabRecorder = {
  format: BuiltInBrowserRecordingFormat;
  mimeType: string;
  /** Resolves once the stream is negotiated and `MediaRecorder` is running. */
  start: () => Promise<void>;
  stop: (args: { durationMs: number }) => Promise<BuiltInBrowserRecorderResult>;
  abort: () => void;
};

export type BuiltInBrowserRecorderFactory = (args: {
  id: string;
  directory: string;
  fps: number;
}) => Promise<BuiltInBrowserTabRecorder>;

export type BuiltInBrowserRecordingSession = {
  id: string;
  fps: number;
  caption: string | null;
  startedAt: string;
  startedAtMs: number;
  stop: () => Promise<BuiltInBrowserRecorderResult & {
    durationMs: number;
    format: BuiltInBrowserRecordingFormat;
    mimeType: string;
  }>;
  abort: () => void;
};

type Logger = {
  debug: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

/* ── Hidden capture page ──────────────────────────────────────────────────── */

export type CaptureWebContentsLike = {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  mainFrame: { frameTreeNodeId: number };
};

export type CaptureWindowLike = {
  isDestroyed: () => boolean;
  destroy: () => void;
  webContents: CaptureWebContentsLike & {
    loadURL: (url: string) => Promise<void>;
  };
};

/** Ordered best-to-worst; the first supported profile wins. */
export const BUILT_IN_BROWSER_RECORDING_MIME_TYPES = [
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42e01e",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

const CAPTURE_TIMESLICE_MS = 1_000;

function captureStartScript(fps: number): string {
  return String.raw`
(async () => {
  const state = { chunks: [], recorder: null, stream: null, stopped: false };
  window.__adeCapture = state;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: ${fps}, max: ${fps} } },
    audio: false,
  });
  state.stream = stream;
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("getDisplayMedia returned no video track.");
  const settings = (track.getSettings && track.getSettings()) || {};
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const frameRate = settings.frameRate || ${fps};
  const bitrate = Math.min(50000000, Math.max(2500000, Math.round(width * height * frameRate * 0.05)));
  const candidates = ${JSON.stringify(BUILT_IN_BROWSER_RECORDING_MIME_TYPES)};
  const mimeType = candidates.find((candidate) => {
    try {
      return window.MediaRecorder && window.MediaRecorder.isTypeSupported(candidate);
    } catch (error) {
      return false;
    }
  }) || "";
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bitrate,
  });
  state.recorder = recorder;
  const toBase64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
    }
    return btoa(binary);
  };
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    state.chunks.push(toBase64(event.data));
  };
  window.__adeCaptureTake = async () => {
    const pending = state.chunks.splice(0, state.chunks.length);
    return Promise.all(pending);
  };
  window.__adeCaptureStop = () => new Promise((resolve, reject) => {
    if (state.stopped) { resolve([]); return; }
    state.stopped = true;
    recorder.onstop = async () => {
      try {
        const pending = state.chunks.splice(0, state.chunks.length);
        const encoded = await Promise.all(pending);
        for (const streamTrack of stream.getTracks()) streamTrack.stop();
        resolve(encoded);
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error));
      }
    };
    try {
      recorder.requestData();
      recorder.stop();
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error));
    }
  });
  recorder.start(${CAPTURE_TIMESLICE_MS});
  return { mimeType: recorder.mimeType || mimeType || "video/webm", width, height, frameRate };
})()
`;
}

function fileExtensionForMimeType(mimeType: string): string {
  return mimeType.toLowerCase().startsWith("video/mp4") ? "mp4" : "webm";
}

/**
 * Builds the recorder factory used in the real app.
 *
 * `createCaptureWindow` makes the hidden trusted page, and `armDisplayMedia`
 * whitelists exactly one `getDisplayMedia` answer for that page's main frame.
 */
export function createDisplayMediaRecorderFactory(args: {
  createCaptureWindow: () => CaptureWindowLike;
  armDisplayMedia: (frameTreeNodeId: number) => () => void;
  logger?: Logger | null;
  pollIntervalMs?: number;
}): BuiltInBrowserRecorderFactory {
  return async ({ id, directory, fps }) => {
    const win = args.createCaptureWindow();
    let disarm: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let handle: import("node:fs/promises").FileHandle | null = null;
    let mimeType = "video/webm";
    let frameRate = fps;
    let disposed = false;
    let filePath = "";

    const teardown = (): void => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      disarm?.();
      disarm = null;
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch (error) {
        args.logger?.debug("built_in_browser.recording_window_destroy_failed", {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const writeChunks = async (chunks: unknown): Promise<void> => {
      if (!handle || !Array.isArray(chunks)) return;
      for (const chunk of chunks) {
        if (typeof chunk !== "string" || !chunk) continue;
        await handle.write(Buffer.from(chunk, "base64"));
      }
    };

    return {
      get format(): BuiltInBrowserRecordingFormat {
        return fileExtensionForMimeType(mimeType) === "mp4" ? "mp4" : "webm";
      },
      get mimeType(): string {
        return mimeType;
      },
      async start() {
        await win.webContents.loadURL("about:blank");
        disarm = args.armDisplayMedia(win.webContents.mainFrame.frameTreeNodeId);
        // `userGesture: true` is what supplies the transient activation
        // getDisplayMedia demands; the page is ADE's own about:blank.
        const started = await win.webContents.executeJavaScript(captureStartScript(fps), true);
        if (started && typeof started === "object") {
          const record = started as { mimeType?: unknown; frameRate?: unknown };
          if (typeof record.mimeType === "string" && record.mimeType) mimeType = record.mimeType;
          if (typeof record.frameRate === "number" && Number.isFinite(record.frameRate)) {
            frameRate = record.frameRate;
          }
        }
        await fs.mkdir(directory, { recursive: true });
        filePath = path.join(directory, `${id}.${fileExtensionForMimeType(mimeType)}`);
        handle = await fs.open(filePath, "w");
        poll = setInterval(() => {
          if (disposed || win.isDestroyed()) return;
          void win.webContents
            .executeJavaScript("window.__adeCaptureTake()")
            .then(writeChunks)
            .catch((error) => {
              args.logger?.debug("built_in_browser.recording_chunk_failed", {
                err: error instanceof Error ? error.message : String(error),
              });
            });
        }, args.pollIntervalMs ?? CAPTURE_TIMESLICE_MS);
      },
      async stop({ durationMs }) {
        if (disposed) throw new Error("Browser recording was already torn down.");
        disposed = true;
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        try {
          if (win.isDestroyed()) throw new Error("Browser recording capture page closed early.");
          const finalChunks = await win.webContents.executeJavaScript("window.__adeCaptureStop()");
          await writeChunks(finalChunks);
        } finally {
          await handle?.close().catch(() => {});
          handle = null;
          teardown();
        }
        return {
          filePath,
          // MediaRecorder does not expose a frame counter; derive it from the
          // negotiated frame rate so callers get a useful magnitude.
          frameCount: Math.max(0, Math.round((durationMs / 1_000) * frameRate)),
          manifestPath: null,
        };
      },
      abort() {
        if (disposed) return;
        disposed = true;
        void handle?.close().catch(() => {});
        handle = null;
        teardown();
      },
    };
  };
}

/* ── Session state machine ────────────────────────────────────────────────── */

export async function createBuiltInBrowserRecordingSession(args: {
  id: string;
  directory: string;
  fps: number;
  caption: string | null;
  createRecorder: BuiltInBrowserRecorderFactory;
  now?: () => number;
  logger?: Logger | null;
}): Promise<BuiltInBrowserRecordingSession> {
  const now = args.now ?? (() => Date.now());
  await fs.mkdir(args.directory, { recursive: true });
  const recorder = await args.createRecorder({
    id: args.id,
    directory: args.directory,
    fps: args.fps,
  });
  try {
    await recorder.start();
  } catch (error) {
    recorder.abort();
    throw error instanceof Error ? error : new Error(String(error));
  }
  const startedAtMs = now();
  let stopped = false;

  return {
    id: args.id,
    fps: args.fps,
    caption: args.caption,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    async stop() {
      if (stopped) throw new Error("Browser recording already stopped.");
      stopped = true;
      const durationMs = Math.max(0, now() - startedAtMs);
      const result = await recorder.stop({ durationMs });
      return {
        ...result,
        durationMs,
        format: recorder.format,
        mimeType: recorder.mimeType,
      };
    },
    abort() {
      if (stopped) return;
      stopped = true;
      recorder.abort();
    },
  };
}
