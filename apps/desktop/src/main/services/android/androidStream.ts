/**
 * An emulator's live picture and input: one scrcpy run per emulator, served
 * to any number of viewers.
 *
 * `startStream` pushes and starts the pinned scrcpy server (`scrcpyServer.ts`),
 * turns its packets into video records (`scrcpyVideo.ts`), and serves them on
 * the loopback stream server (`androidStreamServer.ts`). Touch, keys and text
 * go back through the same run's control socket (`scrcpyControl.ts`).
 *
 * Streams are keyed by adb serial (`emulator-5554`). The owning service maps a
 * lane to its emulator's serial and passes the lane id through for `status`.
 *
 * A run that ends on its own (the server crashed, the emulator restarted its
 * system UI) is restarted on the same transport, so a viewer keeps its URL and
 * picks up the new run's keyframe. After `MAX_RESTARTS` inside
 * `RESTART_WINDOW_MS` it stays down and `status` reports why.
 */

import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import type {
  AndroidEmulatorErrorCode,
  AndroidHardwareKey,
  AndroidStreamStatus,
  AndroidStreamTransport,
  AndroidTouchEvent,
} from "../../../shared/types/androidEmulator";
import { runAdbText } from "./adb";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { createAndroidStreamServer, type AndroidStreamMetrics, type AndroidStreamServer } from "./androidStreamServer";
import {
  encodeHardwareKeyPress,
  encodeInjectText,
  encodeInjectTouch,
  encodeResetVideo,
  SCRCPY_POINTER_ID_GENERIC_FINGER,
} from "./scrcpyControl";
import { startScrcpySession, type ScrcpySession, type ScrcpySessionEnd } from "./scrcpyServer";
import { createScrcpyRecordBuilder } from "./scrcpyVideo";

/*
 * Encoder defaults, measured on the Windows emulator (API 36, 4 vCPUs). The
 * emulator has only a software H.264 encoder, so the picture's size and bit
 * rate set the frame rate while the screen moves: 720x1600 at 8 Mbps gave
 * 15-27 fps, 576x1280 at 4 Mbps 29-52 fps, 464x1024 35-55. With scrcpy
 * v5.0.1, 1024 averaged 39 fps (52 max) against 23-36 at 1280. One setting
 * serves every view, so the panel and the larger view never restart the
 * encoder. The server sets real-time priority and one-frame latency itself
 * (scrcpy 4.0 and later).
 */
const ANDROID_STREAM_DEFAULTS = {
  /** Longest side of the encoded picture (464x1024 for a 1080x2400 phone). */
  maxSize: 1024,
  bitRate: 4_000_000,
  maxFps: 60,
} as const;
/** How long a start waits for the first config record. */
const FIRST_CONFIG_TIMEOUT_MS = 20_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const RESTART_BACKOFF_MS = 500;

class AndroidStreamError extends Error {
  constructor(
    readonly code: AndroidEmulatorErrorCode,
    message: string,
    readonly serverLog: string[] = [],
  ) {
    super(message);
    this.name = "AndroidStreamError";
  }
}

/** Rethrows a stream's refusal as the service's coded one; anything else as it is. */
export function asStreamFailure(error: unknown): never {
  if (error instanceof AndroidStreamError) throw new AndroidEmulatorFailure(error.code, error.message);
  throw error;
}

export type AndroidStreamStartArgs = {
  adbPath: string;
  serial: string;
  /** The bundled jar; `resolveScrcpyServerJarPath` gives it. */
  serverJarPath: string;
  laneId?: string | null;
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  /** scrcpy `video_codec_options` (`key[:type]=value,…`); none by default. */
  codecOptions?: string | null;
  videoEncoder?: string | null;
  logger?: Logger | null;
};

type DeviceStream = {
  args: AndroidStreamStartArgs;
  session: ScrcpySession | null;
  builder: ReturnType<typeof createScrcpyRecordBuilder>;
  /** The display's size in its natural orientation, from `wm size`. */
  displaySize: { width: number; height: number } | null;
  starting: Promise<AndroidStreamTransport> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restarts: number[];
  stopped: boolean;
  /** Set when the run is down for good. */
  failure: AndroidStreamError | null;
  firstConfig: { promise: Promise<void>; resolve: () => void };
  lastEnd: ScrcpySessionEnd | null;
  /** Config packets from the encoder: one per encoder start, reset or rotation. */
  configPackets: number;
  /** Capture sessions the server announced; one per start, rotation or reset. */
  sessions: number;
};

export type AndroidStreamDiagnostics = {
  serial: string;
  running: boolean;
  deviceName: string | null;
  /** The server's process id on the device. */
  devicePid: number | null;
  displaySize: { width: number; height: number } | null;
  timings: ScrcpySession["timings"] | null;
  restarts: number;
  lastEnd: ScrcpySessionEnd | null;
  failure: string | null;
  configPackets: number;
  sessions: number;
  serverLog: string[];
  metrics: AndroidStreamMetrics | null;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Parses `wm size`; the override size wins because it is what the screen shows. */
function parseWmSize(text: string): { width: number; height: number } | null {
  const pick = (label: string) => {
    const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`).exec(text);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  };
  return pick("Override") ?? pick("Physical");
}

function serverLogOf(error: unknown): string[] {
  return error instanceof Error && "serverLog" in error ? (error as { serverLog: string[] }).serverLog : [];
}

/**
 * Every emulator stream of one process, and the one loopback server they
 * share. Each process builds one (`main.ts`, `bootstrap.ts`) and gives it to
 * every emulator service it builds. A service holds it with `retain`; when the
 * last holder lets go, every stream and the server stop.
 */
export function createAndroidStreamHub() {
  const devices = new Map<string, DeviceStream>();
  let streamServer: AndroidStreamServer | null = null;
  let serverLogger: Logger | null = null;
  let holders = 0;

  const ensureStreamServer = (logger: Logger | null): AndroidStreamServer => {
    serverLogger ??= logger;
    streamServer ??= createAndroidStreamServer({
      logger: serverLogger,
      requestKeyframe: (serial) => {
        const control = devices.get(serial)?.session?.control;
        if (!control?.isOpen()) return;
        void control.send([encodeResetVideo()]).catch(() => undefined);
      },
    });
    return streamServer;
  };

  const transportOf = (device: DeviceStream): AndroidStreamTransport | null => {
    const transport = streamServer?.getTransport(device.args.serial);
    const config = device.builder.currentConfig();
    if (!transport || !config) return null;
    return { url: transport.url, token: transport.token, codec: config.codec, width: config.width, height: config.height };
  };

  const openSession = async (device: DeviceStream): Promise<void> => {
    const { args } = device;
    const server = ensureStreamServer(args.logger ?? null);
    const session = await startScrcpySession(
      {
        adbPath: args.adbPath,
        serial: args.serial,
        serverJarPath: args.serverJarPath,
        maxSize: args.maxSize ?? ANDROID_STREAM_DEFAULTS.maxSize,
        videoBitRate: args.bitRate ?? ANDROID_STREAM_DEFAULTS.bitRate,
        maxFps: args.maxFps ?? ANDROID_STREAM_DEFAULTS.maxFps,
        codecOptions: args.codecOptions ?? null,
        videoEncoder: args.videoEncoder ?? null,
        logger: args.logger ?? null,
      },
      {
        onPacket: (packet) => {
          if (devices.get(args.serial) !== device) return;
          if (packet.config) device.configPackets += 1;
          let outputs;
          try {
            outputs = device.builder.push(packet);
          } catch (error) {
            server.recordError(args.serial, getErrorMessage(error));
            return;
          }
          for (const output of outputs) {
            server.publish(args.serial, output);
            if (output.kind === "config") device.firstConfig.resolve();
          }
        },
        onSession: () => {
          if (devices.get(args.serial) === device) device.sessions += 1;
        },
        onEnd: (end) => handleSessionEnd(device, end),
      },
    );
    if (device.stopped || devices.get(args.serial) !== device) {
      await session.stop();
      return;
    }
    device.session = session;
  };

  const handleSessionEnd = (device: DeviceStream, end: ScrcpySessionEnd): void => {
    device.lastEnd = end;
    device.session = null;
    if (end.reason === "stopped" || device.stopped || devices.get(device.args.serial) !== device) return;
    const server = streamServer;
    server?.recordError(device.args.serial, end.message ?? end.reason);
    const at = Date.now();
    device.restarts = device.restarts.filter((when) => at - when < RESTART_WINDOW_MS);
    if (device.restarts.length >= MAX_RESTARTS) {
      device.failure = new AndroidStreamError(
        "ANDROID_STREAM_FAILED",
        `The emulator's video stopped ${MAX_RESTARTS + 1} times in a minute: ${end.message ?? end.reason}`,
        end.serverLog,
      );
      device.args.logger?.warn("android.stream_gave_up", { serial: device.args.serial, reason: end.reason, message: end.message });
      server?.stop(device.args.serial);
      return;
    }
    device.restarts.push(at);
    const backoff = RESTART_BACKOFF_MS * device.restarts.length;
    device.args.logger?.info("android.stream_restarting", { serial: device.args.serial, reason: end.reason, backoffMs: backoff });
    device.restartTimer = setTimeout(() => {
      device.restartTimer = null;
      if (device.stopped) return;
      openSession(device).catch((error: unknown) => {
        handleSessionEnd(device, {
          reason: "server-exited",
          message: getErrorMessage(error),
          serverLog: serverLogOf(error),
        });
      });
    }, backoff);
  };

  /** Stops the emulator's stream: ends the server, removes the forward, closes every viewer. */
  const stopStream = async (serial: string): Promise<void> => {
    const device = devices.get(serial);
    if (!device) return;
    devices.delete(serial);
    device.stopped = true;
    // A start still waiting for its first picture fails now, not at its timeout.
    device.firstConfig.resolve();
    if (device.restartTimer) clearTimeout(device.restartTimer);
    device.restartTimer = null;
    streamServer?.stop(serial);
    const session = device.session;
    device.session = null;
    await session?.stop();
  };

  /** Stops every stream and the loopback server. */
  const stopAllStreams = async (): Promise<void> => {
    await Promise.all([...devices.keys()].map((serial) => stopStream(serial)));
    streamServer?.dispose();
    streamServer = null;
    serverLogger = null;
  };

  const runningDevice = (serial: string): { device: DeviceStream; session: ScrcpySession } => {
    const device = devices.get(serial);
    if (device?.failure) throw device.failure;
    const session = device?.session;
    if (!device || !session || !session.control.isOpen()) {
      const restarting = Boolean(device && !device.stopped && (device.restartTimer || device.lastEnd));
      throw new AndroidStreamError(
        "ANDROID_NOT_RUNNING",
        restarting
          ? `The stream for ${serial} is restarting (${device?.lastEnd?.message ?? "the server stopped"}).`
          : `No stream is running for ${serial}.`,
      );
    }
    return { device, session };
  };

  return {
    /**
     * Holds the hub for one service. The returned call lets go; the last one
     * to let go stops every stream and the loopback server.
     */
    retain(): () => Promise<void> {
      holders += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0) await stopAllStreams();
      };
    },

    /**
     * Starts the emulator's stream, or returns the one already running. Resolves
     * once the first config record exists, so the transport names the codec and
     * the size.
     */
    async startStream(args: AndroidStreamStartArgs): Promise<AndroidStreamTransport> {
      const existing = devices.get(args.serial);
      if (existing && !existing.stopped && !existing.failure) {
        if (existing.starting) return existing.starting;
        const transport = transportOf(existing);
        if (transport) return transport;
      }
      if (existing) await stopStream(args.serial);

      const device: DeviceStream = {
        args,
        session: null,
        builder: createScrcpyRecordBuilder(),
        displaySize: null,
        starting: null,
        restartTimer: null,
        restarts: [],
        stopped: false,
        failure: null,
        firstConfig: deferred(),
        lastEnd: null,
        configPackets: 0,
        sessions: 0,
      };
      devices.set(args.serial, device);
      const server = ensureStreamServer(args.logger ?? null);

      device.starting = (async () => {
        try {
          await server.start(args.serial);
          // The display size scales touches from device to video pixels.
          const sizeText = await runAdbText(args.adbPath, ["shell", "wm", "size"], { serial: args.serial, timeoutMs: 10_000 })
            .catch(() => "");
          device.displaySize = parseWmSize(sizeText);
          await openSession(device);
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), FIRST_CONFIG_TIMEOUT_MS);
          });
          const result = await Promise.race([device.firstConfig.promise.then(() => "config" as const), timedOut]);
          if (timer) clearTimeout(timer);
          if (device.stopped) throw new AndroidStreamError("ANDROID_NOT_RUNNING", "The stream was stopped while it was starting.");
          if (result === "timeout") {
            throw new AndroidStreamError("ANDROID_STREAM_FAILED", `The emulator sent no video within ${FIRST_CONFIG_TIMEOUT_MS / 1000} s.`);
          }
          const transport = transportOf(device);
          if (!transport) throw new AndroidStreamError("ANDROID_STREAM_FAILED", "The emulator's stream stopped while it was starting.");
          return transport;
        } catch (error) {
          if (devices.get(args.serial) === device) await stopStream(args.serial);
          if (error instanceof AndroidStreamError) throw error;
          throw new AndroidStreamError("ANDROID_STREAM_FAILED", getErrorMessage(error), serverLogOf(error));
        } finally {
          device.starting = null;
        }
      })();
      return device.starting;
    },

    stopStream,

    /**
     * Sends one touch event. Coordinates are device pixels in the current
     * orientation; the server wants video pixels with the video size, so they are
     * scaled here. Use one `pointerId` for the whole gesture (down, moves, up).
     */
    async sendTouch(serial: string, event: AndroidTouchEvent): Promise<void> {
      const { device, session } = runningDevice(serial);
      const video = device.builder.currentConfig();
      if (!video) throw new AndroidStreamError("ANDROID_NOT_RUNNING", `The stream for ${serial} has no picture yet.`);
      let scaleX = 1;
      let scaleY = 1;
      if (device.displaySize) {
        // The video follows the display's rotation, so the display's long side
        // lies along the video's long side.
        const long = Math.max(device.displaySize.width, device.displaySize.height);
        const short = Math.min(device.displaySize.width, device.displaySize.height);
        const landscape = video.width > video.height;
        scaleX = video.width / (landscape ? long : short);
        scaleY = video.height / (landscape ? short : long);
      }
      const x = Math.min(video.width - 1, Math.max(0, event.x * scaleX));
      const y = Math.min(video.height - 1, Math.max(0, event.y * scaleY));
      await session.control.send([
        encodeInjectTouch({
          action: event.action,
          pointerId: typeof event.pointerId === "number" && event.pointerId >= 0
            ? BigInt(Math.trunc(event.pointerId))
            : SCRCPY_POINTER_ID_GENERIC_FINGER,
          x,
          y,
          videoWidth: video.width,
          videoHeight: video.height,
        }),
      ]);
    },

    /** Presses and releases one hardware key. Back also wakes a dark screen. */
    async sendKey(serial: string, key: AndroidHardwareKey): Promise<void> {
      const { session } = runningDevice(serial);
      await session.control.send(encodeHardwareKeyPress(key));
    },

    /**
     * Types text into the focused field. The server types it with the virtual
     * keyboard's key map, so characters that map has no keys for (most non-ASCII)
     * are skipped on the device.
     */
    async sendText(serial: string, text: string): Promise<void> {
      if (!text) return;
      const { session } = runningDevice(serial);
      await session.control.send(encodeInjectText(text));
    },

    status(serial: string, laneId?: string | null): AndroidStreamStatus {
      const device = devices.get(serial) ?? null;
      const running = Boolean(device && !device.failure && device.session);
      const metrics = streamServer?.metrics(serial) ?? null;
      return {
        laneId: laneId ?? device?.args.laneId ?? "",
        running,
        backend: running ? "scrcpy" : null,
        transport: running && device ? transportOf(device) : null,
        fps: running ? metrics?.fps ?? null : null,
      };
    },

    /** Everything the status strip, the perf table and a crash report need. */
    diagnostics(serial: string): AndroidStreamDiagnostics | null {
      const device = devices.get(serial);
      if (!device) return null;
      return {
        serial,
        running: Boolean(!device.failure && device.session),
        deviceName: device.session?.header.deviceName ?? null,
        devicePid: device.session?.devicePid ?? null,
        displaySize: device.displaySize,
        timings: device.session?.timings ?? null,
        restarts: device.restarts.length,
        lastEnd: device.lastEnd,
        failure: device.failure?.message ?? null,
        configPackets: device.configPackets,
        sessions: device.sessions,
        serverLog: device.session?.serverLog() ?? device.lastEnd?.serverLog ?? [],
        metrics: streamServer?.metrics(serial) ?? null,
      };
    },
  };
}

export type AndroidStreamHub = ReturnType<typeof createAndroidStreamHub>;
