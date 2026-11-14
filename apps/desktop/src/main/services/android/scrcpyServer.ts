/**
 * One run of the scrcpy server on one emulator.
 *
 * The brain pushes the pinned jar, opens an adb forward to the server's
 * abstract socket, starts the server with `app_process`, and connects two
 * sockets through the forward: video first, then control (the order the
 * server accepts them in). Node built-ins only, so it runs the same on Mac,
 * Windows and Linux, and under `tsx` with no `node_modules`.
 *
 * Why a forward and not scrcpy's default reverse tunnel: with a forward ADE
 * opens no listening port of its own, the connection order is ours, and
 * `adb forward tcp:0` hands back a free port from adb itself, so two streams
 * starting together cannot race for one. The cost is a retry loop: the forward
 * accepts a connection before the server listens, so the server sends one
 * dummy byte and a connection that closes without it is retried.
 *
 * The server runs with `cleanup=false`. Clean-up is a second device process
 * that restores settings ADE never changes (show touches, stay awake, display
 * power) and deletes the jar; without it there is exactly one process to stop.
 */

import { createHash, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import type { Logger } from "../logging/logger";
import { getErrorMessage, sleep } from "../shared/utils";
import { runAdb, runAdbText, spawnAdb } from "./adb";
import { markExpected } from "../../../shared/expectedError";
import { createScrcpyControlWriter, type ScrcpyControlWriter } from "./scrcpyControl";
import {
  createScrcpyVideoDemuxer,
  ScrcpyProtocolError,
  type ScrcpyVideoHeader,
  type ScrcpyVideoPacket,
  type ScrcpyVideoSession,
} from "./scrcpyVideo";

/** The bundled server's version. The server refuses a client that names another. */
export const SCRCPY_SERVER_VERSION = "5.0.1";
/** SHA-256 of `resources/android/scrcpy-server` (release asset `scrcpy-server-v5.0.1`). */
export const SCRCPY_SERVER_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
/**
 * Where the jar goes on the device. Versioned, and not scrcpy's own
 * `/data/local/tmp/scrcpy-server.jar`: a user's scrcpy of another version
 * pushes to that path, and overwriting a jar under a running `app_process`
 * can crash it.
 */
const SCRCPY_DEVICE_JAR_PATH = `/data/local/tmp/ade-scrcpy-server-${SCRCPY_SERVER_VERSION}.jar`;

const PID_LINE_PREFIX = "ADE_SCRCPY_PID=";
const CONNECT_RETRY_MS = 100;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** The server exits within one repeated frame (100 ms) of its sockets closing. */
const EXIT_AFTER_CLOSE_WAIT_MS = 1_500;
const SERVER_LOG_TAIL_LINES = 30;

const JAR_RELATIVE_PATH = ["android", "scrcpy-server"] as const;

/**
 * The bundled jar's path, for the Electron main process and for a brain.
 *
 * - `runtimeRoots`: a standalone brain's unpacked runtime archive
 *   (`<root>/android/scrcpy-server`, from package-native-deps.mjs). These
 *   come first: the archive ships the brain's own copy.
 * - `resourcesPath`: a packaged app's resources folder (extraResources).
 * - `startDir`: a folder inside a source checkout. Each folder from it up to
 *   the disk root is tried, `<dir>/resources/android/scrcpy-server` first, so
 *   a dev run from `apps/desktop` finds the checkout's jar.
 *
 * The first candidate that exists wins. When none does, the first candidate is
 * returned, so the stream's error names a real place to look.
 */
export function resolveScrcpyServerJarPath(input: {
  runtimeRoots?: readonly (string | null | undefined)[];
  resourcesPath?: string | null;
  startDir?: string | null;
}): string {
  const candidates: string[] = [];
  for (const root of input.runtimeRoots ?? []) {
    if (root?.trim()) candidates.push(path.join(root.trim(), ...JAR_RELATIVE_PATH));
  }
  if (input.resourcesPath) candidates.push(path.join(input.resourcesPath, ...JAR_RELATIVE_PATH));
  if (input.startDir) {
    let dir = path.resolve(input.startDir);
    for (;;) {
      candidates.push(path.join(dir, "resources", ...JAR_RELATIVE_PATH));
      candidates.push(path.join(dir, "apps", "desktop", "resources", ...JAR_RELATIVE_PATH));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? path.join(...JAR_RELATIVE_PATH);
}

class ScrcpySessionError extends Error {
  constructor(
    message: string,
    /** The server's last output lines, for the log and "Open log". */
    readonly serverLog: string[],
  ) {
    super(message);
    this.name = "ScrcpySessionError";
  }
}

const verifiedJars = new Map<string, Promise<void>>();

/** Checks the jar once per process: a wrong file fails here, not as a version error on the device. */
function verifyServerJar(jarPath: string): Promise<void> {
  let pending = verifiedJars.get(jarPath);
  if (!pending) {
    pending = readFile(jarPath).then(
      (bytes) => {
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== SCRCPY_SERVER_SHA256) {
          throw new ScrcpySessionError(`The bundled scrcpy server at ${jarPath} is not version ${SCRCPY_SERVER_VERSION}.`, []);
        }
      },
      (error: NodeJS.ErrnoException) => {
        throw new ScrcpySessionError(`The bundled scrcpy server is missing (${jarPath}): ${error.message}`, []);
      },
    );
    // A missing file may appear later (a dev build); only success is kept.
    pending.catch(() => verifiedJars.delete(jarPath));
    verifiedJars.set(jarPath, pending);
  }
  return pending;
}

export type ScrcpySessionOptions = {
  adbPath: string;
  serial: string;
  serverJarPath: string;
  /** Longest video side in pixels; 0 keeps the display's size. */
  maxSize: number;
  videoBitRate: number;
  /** 0 leaves the rate to the encoder. */
  maxFps: number;
  /**
   * `MediaFormat` keys for the encoder, in scrcpy's `key[:type]=value,…` form.
   * They go into the device shell command, so only a safe character set is
   * accepted.
   */
  codecOptions?: string | null;
  /** A specific `MediaCodec` encoder name; null lets the device pick. */
  videoEncoder?: string | null;
  logger?: Logger | null;
  connectTimeoutMs?: number;
};

export type ScrcpySessionEnd = {
  reason: "stopped" | "server-exited" | "video-closed" | "protocol-error";
  message: string | null;
  serverLog: string[];
};

export type ScrcpySessionHandlers = {
  /** Every packet after the header, in order. May be called before `startScrcpySession` resolves. */
  onPacket: (packet: ScrcpyVideoPacket) => void;
  /** Each capture session's size (start, rotation, reset), before its config packet. */
  onSession?: (session: ScrcpyVideoSession) => void;
  /** Called once, when the run ends for any reason after it started. */
  onEnd: (end: ScrcpySessionEnd) => void;
};

export type ScrcpySession = {
  scid: string;
  localPort: number;
  /** The server's process id on the device, when its first line arrived. */
  devicePid: number | null;
  header: ScrcpyVideoHeader;
  control: ScrcpyControlWriter;
  /** Milliseconds per start phase, for the status strip and the perf table. */
  timings: { pushMs: number; forwardMs: number; connectMs: number; headerMs: number };
  serverLog(): string[];
  /** Closes the sockets, ends the device process and removes the forward. */
  stop(): Promise<void>;
};

/** Characters a codec option or encoder name may hold: nothing the device shell would read. */
const SAFE_SERVER_VALUE = /^[A-Za-z0-9._:=,-]+$/;

function serverCommand(scid: string, options: ScrcpySessionOptions): string {
  for (const value of [options.codecOptions, options.videoEncoder]) {
    if (value && !SAFE_SERVER_VALUE.test(value)) {
      throw new ScrcpySessionError(`Unsafe scrcpy server option: ${JSON.stringify(value)}`, []);
    }
  }
  const params = [
    `scid=${scid}`,
    "log_level=info",
    "video_codec=h264",
    "audio=false",
    "control=true",
    "tunnel_forward=true",
    `max_size=${Math.max(0, Math.round(options.maxSize))}`,
    `video_bit_rate=${Math.max(1, Math.round(options.videoBitRate))}`,
    ...(options.maxFps > 0 ? [`max_fps=${options.maxFps}`] : []),
    ...(options.codecOptions ? [`video_codec_options=${options.codecOptions}`] : []),
    ...(options.videoEncoder ? [`video_encoder=${options.videoEncoder}`] : []),
    "clipboard_autosync=false",
    "cleanup=false",
    "send_device_meta=true",
    "send_stream_meta=true",
    "send_frame_meta=true",
    "send_dummy_byte=true",
  ];
  // `echo $$` then `exec`: the shell's pid becomes the server's, so stop can
  // end exactly this process. adb joins the arguments into one device shell
  // command, so the `$$` is expanded on the device, never on the host.
  return [
    `echo ${PID_LINE_PREFIX}$$`,
    `export CLASSPATH=${SCRCPY_DEVICE_JAR_PATH}`,
    `exec app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION} ${params.join(" ")}`,
  ].join("; ");
}

/** One connection attempt through the forward: the socket and its first bytes, or null if adb closed it. */
function connectForFirstBytes(port: number): Promise<{ socket: Socket; first: Buffer } | null> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const onData = (chunk: Buffer) => {
      socket.pause();
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
      resolve({ socket, first: chunk });
    };
    const onClose = () => {
      socket.removeListener("data", onData);
      resolve(null);
    };
    // `close` follows every error.
    const onError = () => {};
    socket.once("data", onData);
    socket.once("close", onClose);
    socket.on("error", onError);
  });
}

function connectPlain(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/**
 * Starts the server and resolves once the video header has arrived. On any
 * failure it has already removed the forward and ended the process.
 */
export async function startScrcpySession(
  options: ScrcpySessionOptions,
  handlers: ScrcpySessionHandlers,
): Promise<ScrcpySession> {
  const { adbPath, serial, logger } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  await verifyServerJar(options.serverJarPath);

  const startedAt = Date.now();
  await runAdb(adbPath, ["push", options.serverJarPath, SCRCPY_DEVICE_JAR_PATH], { serial, timeoutMs: 30_000 });
  const pushMs = Date.now() - startedAt;

  const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
  const forwardStartedAt = Date.now();
  const portText = await runAdbText(adbPath, ["forward", "tcp:0", `localabstract:scrcpy_${scid}`], { serial });
  const localPort = Number.parseInt(portText, 10);
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65_535) {
    throw new ScrcpySessionError(`adb forward returned no port ("${portText}").`, []);
  }
  const forwardMs = Date.now() - forwardStartedAt;

  const logTail: string[] = [];
  let devicePid: number | null = null;
  let video: Socket | null = null;
  let controlSocket: Socket | null = null;
  let stopping = false;
  let ended = false;
  /** Set once the start resolved; before that a failure is the start's throw, not `onEnd`. */
  let started = false;
  let headerResolve: ((header: ScrcpyVideoHeader) => void) | null = null;
  let headerReject: ((error: Error) => void) | null = null;
  // Made first, so a run that ends at any point of the start rejects it.
  const headerPromise = new Promise<ScrcpyVideoHeader>((resolve, reject) => {
    headerResolve = resolve;
    headerReject = reject;
  });
  headerPromise.catch(() => undefined);

  const child = spawnAdb(adbPath, ["shell", serverCommand(scid, options)], { serial });
  const readLines = (stream: NodeJS.ReadableStream | null) => {
    let partial = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (text: string) => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (devicePid === null && line.startsWith(PID_LINE_PREFIX)) {
          const pid = Number.parseInt(line.slice(PID_LINE_PREFIX.length), 10);
          devicePid = Number.isInteger(pid) && pid > 0 ? pid : null;
          continue;
        }
        logTail.push(line);
        if (logTail.length > SERVER_LOG_TAIL_LINES) logTail.shift();
      }
    });
  };
  readLines(child.stdout);
  readLines(child.stderr);

  const end = (reason: ScrcpySessionEnd["reason"], message: string | null) => {
    if (ended) return;
    ended = true;
    headerReject?.(new ScrcpySessionError(message ?? `The scrcpy server stopped (${reason}).`, [...logTail]));
    headerResolve = null;
    headerReject = null;
    if (!started) return;
    logger?.info("android.scrcpy_session_ended", { serial, scid, reason, message });
    handlers.onEnd({ reason, message, serverLog: [...logTail] });
  };

  child.once("exit", (code, signal) => {
    if (stopping) return;
    const last = logTail.at(-1) ?? null;
    fail("server-exited", `The scrcpy server exited (${signal ?? code})${last ? `: ${last}` : "."}`);
  });
  child.once("error", (error) => {
    if (!stopping) fail("server-exited", `adb could not start the scrcpy server: ${error.message}`);
  });

  let stopped: Promise<void> | null = null;
  /** Idempotent; every caller waits for the one clean-up. */
  const stop = (): Promise<void> => {
    stopped ??= stopNow();
    return stopped;
  };
  const stopNow = async (): Promise<void> => {
    stopping = true;
    video?.destroy();
    controlSocket?.destroy();
    // The server exits on its own once its sockets close; a kill is for a
    // server that did not (a wedged encoder), and it checks the pid is still
    // this run's so a reused pid is never hit.
    if (!(await waitForExit(child, EXIT_AFTER_CLOSE_WAIT_MS))) {
      if (devicePid !== null) {
        await runAdb(
          adbPath,
          ["shell", `grep -qa scid=${scid} /proc/${devicePid}/cmdline && kill ${devicePid}`],
          { serial, allowFailure: true, timeoutMs: 5_000 },
        ).catch(() => undefined);
      }
      child.kill();
    }
    await runAdb(adbPath, ["forward", "--remove", `tcp:${localPort}`], { serial, allowFailure: true, timeoutMs: 5_000 })
      .catch(() => undefined);
    end("stopped", null);
  };

  /** Ends the run for `reason` and still cleans up: the forward and the process must not outlive it. */
  function fail(reason: ScrcpySessionEnd["reason"], message: string): void {
    end(reason, message);
    void stop();
  }

  try {
    const connectStartedAt = Date.now();
    const deadline = connectStartedAt + connectTimeoutMs;
    let attempt: { socket: Socket; first: Buffer } | null = null;
    while (!attempt) {
      if (ended) throw new ScrcpySessionError("The scrcpy server exited before it accepted a connection.", [...logTail]);
      attempt = await connectForFirstBytes(localPort);
      if (attempt) break;
      if (Date.now() > deadline) {
        // The device side never opened the socket (a slow or busy device, an
        // adb forward the device dropped): the device's state, and the panel
        // offers a retry. A server that exits early stays reported above.
        throw markExpected(
          new ScrcpySessionError(`The scrcpy server did not accept a connection within ${connectTimeoutMs} ms.`, [...logTail]),
          "environment",
        );
      }
      await sleep(CONNECT_RETRY_MS);
    }
    video = attempt.socket;
    // The server accepts control only after it has sent the dummy byte on video.
    controlSocket = await connectPlain(localPort);
    const connectMs = Date.now() - connectStartedAt;

    if (ended) throw new ScrcpySessionError("The scrcpy server exited while it was connecting.", [...logTail]);
    const headerStartedAt = Date.now();
    const demuxer = createScrcpyVideoDemuxer();
    const consume = (chunk: Buffer) => {
      let events;
      try {
        events = demuxer.push(chunk);
      } catch (error) {
        video?.removeListener("data", consume);
        fail("protocol-error", error instanceof ScrcpyProtocolError ? error.message : String(error));
        return;
      }
      for (const event of events) {
        if (event.kind === "header") {
          headerResolve?.(event);
          headerResolve = null;
          headerReject = null;
        } else if (event.kind === "session") {
          handlers.onSession?.(event);
        } else {
          handlers.onPacket(event);
        }
      }
    };
    video.on("data", consume);
    video.once("close", () => {
      if (!stopping) fail("video-closed", "The emulator's video connection closed.");
    });
    video.on("error", () => {});
    controlSocket.on("error", () => {});
    video.setNoDelay(true);
    // Byte 0 is the forward's dummy byte; the rest is the stream.
    if (attempt.first.byteLength > 1) consume(attempt.first.subarray(1));
    video.resume();

    const headerTimer = setTimeout(() => {
      headerReject?.(new ScrcpySessionError(`The scrcpy server sent no video header within ${connectTimeoutMs} ms.`, [...logTail]));
    }, connectTimeoutMs);
    let header: ScrcpyVideoHeader;
    try {
      header = await headerPromise;
    } finally {
      clearTimeout(headerTimer);
    }
    const headerMs = Date.now() - headerStartedAt;

    logger?.info("android.scrcpy_session_started", {
      serial,
      scid,
      localPort,
      devicePid,
      deviceName: header.deviceName,
      pushMs,
      forwardMs,
      connectMs,
      headerMs,
    });
    started = true;
    return {
      scid,
      localPort,
      get devicePid() {
        return devicePid;
      },
      header,
      control: createScrcpyControlWriter(controlSocket),
      timings: { pushMs, forwardMs, connectMs, headerMs },
      serverLog: () => [...logTail],
      stop,
    };
  } catch (error) {
    // Report the failure through the throw, not through `onEnd`.
    ended = true;
    await stop();
    if (error instanceof ScrcpySessionError) throw error;
    throw new ScrcpySessionError(getErrorMessage(error), [...logTail]);
  }
}
