import fs from "node:fs/promises";
import path from "node:path";
import {
  DEMO_RAW_FILE_EXTENSION,
  DEMO_RAW_FLAG_KEYFRAME,
  DEMO_RAW_KIND_H264_ACCESS_UNIT,
  DEMO_RAW_KIND_H264_CONFIG,
  DEMO_RAW_KIND_JPEG,
} from "../../../shared/demoVideo/demoContract";
import type { BuiltInBrowserRecordingFormat } from "../../../shared/types";
import { createDemoRawWriter, type DemoRawRecordKind, type DemoRawWriter } from "../demoVideo/demoRawFormat";

/**
 * Screen recording for browser tabs.
 *
 * ## Capture
 *
 * A hidden, trusted capture page calls `getDisplayMedia()`; Electron's
 * `session.setDisplayMediaRequestHandler` answers that request with the
 * *target tab's* `mainFrame`, so the compositor hands us the tab's own frames —
 * no `desktopCapturer` (it would capture ADE's own UI and need a macOS
 * screen-recording grant), no ffmpeg (not guaranteed to be installed), and no
 * native dependency on macOS, Windows or Linux.
 *
 * The page reads the track with `MediaStreamTrackProcessor` and encodes it
 * with `VideoEncoder` (H.264, Annex-B, high quality). The access units are the
 * recording: main drains them into an `.aderaw` capture (kind 2 config, kind 3
 * access units) that the Chromium demo engine renders into the demo at stop.
 * Where this Chromium has no H.264 encoder the page sends JPEG frames (kind 1)
 * at up to 15 a second instead. WebCodecs needs a secure context, so the
 * capture page is served over https by the caller (`capturePageUrl`), not
 * `about:blank`.
 *
 * Rejected alternatives: CDP `Page.startScreencast` (the debugger cannot be
 * attached while DevTools is open) and `MediaRecorder` (it encodes for
 * playback, with no per-frame times and no control of quality; the demo is
 * rendered from the capture anyway).
 *
 * Two details make this work for agents as well as humans:
 *
 * - **Arming.** `getDisplayMedia` is only answered while main has explicitly
 *   armed a `{requesterFrameNodeId → targetWebContents}` pair, for ~10s. Every
 *   other request — including any page in the browser partition trying to
 *   capture itself — is denied with `callback({})`.
 * - **Transient activation.** `getDisplayMedia` requires a user gesture, which
 *   an agent has no way to produce. `webContents.executeJavaScript(code, true)`
 *   supplies it, and because the capture page is ADE's own page in a
 *   throwaway in-memory partition, that gesture is never granted to a site.
 *
 * **Trade-off:** the capture page holds encoded chunks in renderer memory
 * between polls (half a second). Main appends them straight to disk, so peak
 * memory is a fraction of a second of video — but a wedged capture renderer
 * still loses whatever it had not yet handed over. A renderer that main stops
 * draining drops frames past 64 MB rather than growing without bound.
 */

export type BuiltInBrowserRecorderResult = {
  filePath: string;
  frameCount: number;
  manifestPath: string | null;
  /** Wall-clock ms of the capture's time 0 (its first frame), when known. */
  firstFrameAtMs?: number | null;
  /** Source seconds the capture covers, when known. */
  sourceSeconds?: number | null;
};

export type BuiltInBrowserTabRecorder = {
  format: BuiltInBrowserRecordingFormat;
  mimeType: string;
  /** Resolves once the stream is negotiated and the encoder is running. */
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

const CAPTURE_POLL_MS = 500;
/** JPEG fallback: at most this many frames a second. */
const JPEG_FALLBACK_MAX_FPS = 15;

/**
 * Runs in the capture page. Plain script, no template literals inside (the
 * two `${…}` below are this module's values).
 */
function captureStartScript(fps: number): string {
  return String.raw`
(async () => {
  var FPS = ${JSON.stringify(fps)};
  var JPEG_MAX_FPS = ${JSON.stringify(JPEG_FALLBACK_MAX_FPS)};
  var OUTBOX_LIMIT = 64 * 1024 * 1024;
  var KEY_INTERVAL_S = 2;
  var state = {
    out: [], outBytes: 0, stopped: false, error: null, dropped: 0,
    firstTs: null, firstFrameAtMs: null, lastT: 0, lastKeyT: -Infinity, lastJpegT: -Infinity,
    frames: 0, mode: "", codec: "", encoder: null, encW: 0, encH: 0, forceKey: true,
    last: null, lastJpeg: null, loop: null, reader: null, stream: null,
  };
  window.__adeCapture = state;
  if (typeof MediaStreamTrackProcessor !== "function") throw new Error("This Chromium has no MediaStreamTrackProcessor; the tab cannot be recorded.");
  var stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: FPS, max: FPS } },
    audio: false,
  });
  state.stream = stream;
  var track = stream.getVideoTracks()[0];
  if (!track) throw new Error("getDisplayMedia returned no video track.");
  var settings = (track.getSettings && track.getSettings()) || {};
  var width = settings.width || 1280;
  var height = settings.height || 720;
  var frameRate = settings.frameRate || FPS;

  function push(kind, flags, t, data) {
    if (state.outBytes + data.byteLength > OUTBOX_LIMIT) {
      state.dropped += 1;
      return;
    }
    state.out.push({ kind: kind, flags: flags, t: t, data: data });
    state.outBytes += data.byteLength;
  }
  function avcCodecs(w, h) {
    var mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    var rate = mbs * FPS;
    var level = mbs <= 8704 && rate <= 522240 ? "2a" : mbs <= 36864 && rate <= 983040 ? "33" : "34";
    return ["avc1.6400" + level, "avc1.4d00" + level, "avc1.4200" + level];
  }
  async function encoderConfig(w, h) {
    // About 0.1 bit per pixel per frame, 4 to 20 Mbps: the capture is a master, not the filed video.
    var bitrate = Math.min(20000000, Math.max(4000000, Math.round(w * h * FPS * 0.1)));
    var codecs = avcCodecs(w, h);
    for (var i = 0; i < codecs.length; i += 1) {
      var config = {
        codec: codecs[i], width: w, height: h, bitrate: bitrate, framerate: FPS,
        bitrateMode: "variable", latencyMode: "realtime", hardwareAcceleration: "no-preference",
        avc: { format: "annexb" },
      };
      try {
        if (typeof VideoEncoder === "function" && (await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch (error) { /* try the next profile */ }
    }
    return null;
  }
  function sourceTime(timestampUs) {
    var t = Math.max(state.lastT, (timestampUs - state.firstTs) / 1e6);
    state.lastT = t;
    return t;
  }
  async function configure(w, h, t) {
    if (state.encoder) {
      await state.encoder.flush();
      state.encoder.close();
      state.encoder = null;
    }
    var config = await encoderConfig(w, h);
    if (!config) return false;
    var encoder = new VideoEncoder({
      output: function (chunk) {
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        var at = Math.max(0, (chunk.timestamp - state.firstTs) / 1e6);
        push(3, chunk.type === "key" ? 1 : 0, at, data);
      },
      error: function (error) { state.error = error && error.message ? error.message : String(error); },
    });
    encoder.configure(config);
    state.encoder = encoder;
    state.encW = w;
    state.encH = h;
    state.codec = config.codec;
    state.forceKey = true;
    push(2, 0, t, new TextEncoder().encode(JSON.stringify({ codec: config.codec, width: w, height: h })));
    return true;
  }
  async function encodeH264(frame, t) {
    var w = frame.displayWidth - (frame.displayWidth % 2);
    var h = frame.displayHeight - (frame.displayHeight % 2);
    if (w < 2 || h < 2) return;
    if (!state.encoder || w !== state.encW || h !== state.encH) {
      if (!(await configure(w, h, t))) throw new Error("The H.264 encoder refused " + w + "x" + h + ".");
    }
    // Stay real time: a busy encoder drops this frame rather than queueing it.
    if (state.encoder.encodeQueueSize > 3) return;
    var key = state.forceKey || t - state.lastKeyT >= KEY_INTERVAL_S;
    var cropped = w !== frame.displayWidth || h !== frame.displayHeight
      ? new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: w, height: h } })
      : null;
    try {
      state.encoder.encode(cropped || frame, { keyFrame: key });
    } finally {
      if (cropped) cropped.close();
    }
    if (key) state.lastKeyT = t;
    state.forceKey = false;
    state.frames += 1;
  }
  var jpegCanvas = null;
  async function encodeJpeg(frame, t) {
    if (t - state.lastJpegT < 1 / JPEG_MAX_FPS) return;
    var w = frame.displayWidth, h = frame.displayHeight;
    if (!jpegCanvas || jpegCanvas.width !== w || jpegCanvas.height !== h) jpegCanvas = new OffscreenCanvas(w, h);
    jpegCanvas.getContext("2d").drawImage(frame, 0, 0, w, h);
    var blob = await jpegCanvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    var data = new Uint8Array(await blob.arrayBuffer());
    push(1, 0, t, data);
    state.lastJpeg = data;
    state.lastJpegT = t;
    state.frames += 1;
  }
  async function handle(frame) {
    if (state.firstTs === null) {
      state.firstTs = frame.timestamp;
      state.firstFrameAtMs = performance.timeOrigin + performance.now();
    }
    var t = sourceTime(frame.timestamp);
    if (state.mode === "h264") {
      await encodeH264(frame, t);
      // Kept for stop: a still tab sends no frames, and the capture must last until then.
      if (state.last) state.last.close();
      state.last = frame.clone();
    } else {
      await encodeJpeg(frame, t);
    }
  }

  state.mode = (await encoderConfig(width - (width % 2), height - (height % 2))) ? "h264" : "jpeg";
  var processor = new MediaStreamTrackProcessor({ track: track });
  var reader = processor.readable.getReader();
  state.reader = reader;
  state.loop = (async function () {
    for (;;) {
      var step;
      try {
        step = await reader.read();
      } catch (error) {
        break;
      }
      if (step.done) break;
      var frame = step.value;
      if (state.stopped) {
        frame.close();
        break;
      }
      try {
        await handle(frame);
      } catch (error) {
        state.error = error && error.message ? error.message : String(error);
      } finally {
        frame.close();
      }
      if (state.error) break;
    }
  })();

  window.__adeCaptureTake = function () {
    var out = state.out.splice(0);
    state.outBytes = 0;
    return out;
  };
  window.__adeCaptureStop = async function () {
    if (state.stopped) return { records: [], frames: state.frames, firstFrameAtMs: state.firstFrameAtMs, error: state.error };
    state.stopped = true;
    try { await state.reader.cancel(); } catch (error) { /* already closed */ }
    await state.loop;
    var endT = state.firstFrameAtMs === null ? 0 : Math.max(state.lastT, (performance.timeOrigin + performance.now() - state.firstFrameAtMs) / 1000);
    if (state.mode === "h264" && state.encoder && state.last && !state.error) {
      // The last picture once more at the stop time, so a still ending is kept.
      var closing = new VideoFrame(state.last, { timestamp: Math.round(state.firstTs + endT * 1e6) });
      try {
        state.encoder.encode(closing, { keyFrame: false });
      } catch (error) { /* the capture still ends at the last frame */ }
      closing.close();
    }
    if (state.last) state.last.close();
    state.last = null;
    if (state.encoder) {
      try { await state.encoder.flush(); } catch (error) { /* reported below */ }
      try { state.encoder.close(); } catch (error) { /* already closed */ }
    }
    if (state.mode === "jpeg" && state.lastJpeg && endT > state.lastJpegT) {
      push(1, 0, endT, state.lastJpeg);
      state.frames += 1;
    }
    for (var streamTrack of stream.getTracks()) streamTrack.stop();
    return {
      records: window.__adeCaptureTake(),
      frames: state.frames,
      firstFrameAtMs: state.firstFrameAtMs,
      error: state.error,
      dropped: state.dropped,
    };
  };
  return { mode: state.mode, width: width, height: height, frameRate: frameRate };
})()
`;
}

type CaptureRecord = { kind: number; flags: number; t: number; data: Uint8Array };

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.kind === DEMO_RAW_KIND_JPEG || record.kind === DEMO_RAW_KIND_H264_CONFIG || record.kind === DEMO_RAW_KIND_H264_ACCESS_UNIT)
    && typeof record.t === "number"
    && record.data instanceof Uint8Array;
}

/**
 * Builds the recorder factory used in the real app.
 *
 * `createCaptureWindow` makes the hidden trusted page, `capturePageUrl` is the
 * secure page it loads (served by the caller on the capture partition), and
 * `armDisplayMedia` whitelists exactly one `getDisplayMedia` answer for that
 * page's main frame.
 */
export function createDisplayMediaRecorderFactory(args: {
  createCaptureWindow: () => CaptureWindowLike;
  armDisplayMedia: (frameTreeNodeId: number) => () => void;
  capturePageUrl?: string;
  logger?: Logger | null;
  pollIntervalMs?: number;
}): BuiltInBrowserRecorderFactory {
  return async ({ id, directory, fps }) => {
    const win = args.createCaptureWindow();
    let disarm: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let writer: DemoRawWriter | null = null;
    let draining: Promise<void> = Promise.resolve();
    let disposed = false;

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

    const writeRecords = (records: unknown): void => {
      if (!writer || !Array.isArray(records)) return;
      for (const record of records) {
        if (!isCaptureRecord(record)) continue;
        writer.append(record.kind as DemoRawRecordKind, record.t, record.data, record.flags & DEMO_RAW_FLAG_KEYFRAME);
      }
    };

    return {
      // What the caller files: the demo rendered from this capture.
      format: "mp4" as BuiltInBrowserRecordingFormat,
      mimeType: "video/mp4",
      async start() {
        await win.webContents.loadURL(args.capturePageUrl ?? "about:blank");
        disarm = args.armDisplayMedia(win.webContents.mainFrame.frameTreeNodeId);
        // `userGesture: true` is what supplies the transient activation
        // getDisplayMedia demands; the page is ADE's own.
        const started = await win.webContents.executeJavaScript(captureStartScript(fps), true);
        await fs.mkdir(directory, { recursive: true });
        writer = await createDemoRawWriter(path.join(directory, `${id}${DEMO_RAW_FILE_EXTENSION}`));
        const mode = started && typeof started === "object" ? (started as { mode?: unknown }).mode : null;
        if (mode !== "h264") {
          args.logger?.warn("built_in_browser.recording_jpeg_fallback", { id, reason: "no H.264 VideoEncoder" });
        }
        poll = setInterval(() => {
          if (disposed || win.isDestroyed()) return;
          draining = draining.then(() => win.webContents
            .executeJavaScript("window.__adeCaptureTake()")
            .then(writeRecords)
            .catch((error) => {
              args.logger?.debug("built_in_browser.recording_chunk_failed", {
                err: error instanceof Error ? error.message : String(error),
              });
            }));
        }, args.pollIntervalMs ?? CAPTURE_POLL_MS);
      },
      async stop() {
        if (disposed) throw new Error("Browser recording was already torn down.");
        disposed = true;
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        let firstFrameAtMs: number | null = null;
        let captureError: string | null = null;
        try {
          await draining;
          if (win.isDestroyed()) throw new Error("Browser recording capture page closed early.");
          const finished = await win.webContents.executeJavaScript("window.__adeCaptureStop()") as {
            records?: unknown;
            firstFrameAtMs?: unknown;
            error?: unknown;
          } | null;
          writeRecords(finished?.records);
          if (typeof finished?.firstFrameAtMs === "number" && Number.isFinite(finished.firstFrameAtMs)) {
            firstFrameAtMs = finished.firstFrameAtMs;
          }
          if (typeof finished?.error === "string" && finished.error) captureError = finished.error;
        } catch (error) {
          await writer?.discard();
          writer = null;
          throw error;
        } finally {
          teardown();
        }
        const summary = await writer!.close();
        writer = null;
        if (summary.frames <= 0) {
          await fs.rm(summary.filePath, { force: true }).catch(() => {});
          throw new Error(captureError
            ? `The browser recording failed: ${captureError}`
            : "The browser recording captured no frames: the tab did not paint while it was running.");
        }
        if (captureError) {
          args.logger?.warn("built_in_browser.recording_capture_error", { id, err: captureError });
        }
        return {
          filePath: summary.filePath,
          frameCount: summary.frames,
          manifestPath: null,
          firstFrameAtMs,
          sourceSeconds: summary.lastTime,
        };
      },
      abort() {
        if (disposed) return;
        disposed = true;
        const pending = writer;
        writer = null;
        void pending?.discard();
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
  /**
   * Hard wall-clock bound. The session owns the timer so the bound holds even
   * if the caller that armed the recording never comes back — which is the
   * case the bound exists for.
   */
  maxDurationMs?: number | null;
  /**
   * Fired once when {@link maxDurationMs} elapses with the recording still
   * running. The session does NOT stop itself: finalizing a recording means
   * emitting events and writing a result the owner has to publish, so the owner
   * calls `stop()` from here.
   */
  onMaxDurationReached?: (() => void) | null;
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

  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  const clearMaxDurationTimer = (): void => {
    if (!maxDurationTimer) return;
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  };
  const maxDurationMs = args.maxDurationMs ?? null;
  if (maxDurationMs != null && maxDurationMs > 0 && args.onMaxDurationReached) {
    maxDurationTimer = setTimeout(() => {
      maxDurationTimer = null;
      if (stopped) return;
      try {
        args.onMaxDurationReached?.();
      } catch (error) {
        args.logger?.warn("built_in_browser.recording_max_duration_handler_failed", {
          id: args.id,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }, maxDurationMs);
    maxDurationTimer.unref?.();
  }

  return {
    id: args.id,
    fps: args.fps,
    caption: args.caption,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    async stop() {
      if (stopped) throw new Error("Browser recording already stopped.");
      stopped = true;
      clearMaxDurationTimer();
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
      clearMaxDurationTimer();
      recorder.abort();
    },
  };
}
