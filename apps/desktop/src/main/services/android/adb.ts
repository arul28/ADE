import { execFile, spawn, type ChildProcess } from "node:child_process";
import { offThreadSpawnEnabled, spawnOffThread } from "../shared/offThreadSpawn";

/*
 * The one way the Android services run `adb`.
 *
 * Arguments go to the binary as an array (never through a shell), so a serial
 * or a path with spaces needs no quoting on Windows or POSIX. On Windows a
 * short command is spawned off the event loop (`CreateProcess` blocks the
 * calling thread there; see windows-quirks "An async spawn blocks the event
 * loop"), because the brain runs one per tap and one per emulator per status read.
 */

export type AdbRunResult = {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
};

class AdbError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "AdbError";
  }
}

export type AdbRunOptions = {
  /** `-s <serial>`; omitted for server-wide commands (`devices`, `start-server`). */
  serial?: string | null;
  timeoutMs?: number;
  /** Do not throw on a non-zero exit; the caller reads `exitCode`. */
  allowFailure?: boolean;
  /** Ends the adb process early (a stop during a start, a service dispose). */
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function withSerial(serial: string | null | undefined, args: readonly string[]): string[] {
  return serial ? ["-s", serial, ...args] : [...args];
}

/** What one finished adb process left, from either way of running it. */
type AdbCapture = {
  stdout: Buffer;
  stderr: string;
  /** The exit code; null when it was killed, timed out or never ran. */
  exitCode: number | null;
  /** Set when it failed: a non-zero exit, a timeout, a cancel, no binary. */
  error: Error | null;
  timedOut: boolean;
};

function captureWithExecFile(adbPath: string, args: string[], options: AdbRunOptions): Promise<AdbCapture> {
  return new Promise((resolve) => {
    execFile(
      adbPath,
      args,
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr: stderr.toString("utf8"),
          exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
          error,
          timedOut: Boolean(error?.killed) && !options.signal?.aborted,
        });
      },
    );
  });
}

/** The same capture with `CreateProcess` on a worker thread; stdout stays binary. */
function captureOffThread(adbPath: string, args: string[], options: AdbRunOptions): Promise<AdbCapture> {
  return new Promise((resolve) => {
    const child = spawnOffThread(adbPath, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let timedOut = false;
    let settled = false;
    const end = (error: Error) => {
      failure ??= error;
      child.killTree("SIGTERM");
    };
    const onAbort = () => end(new Error("cancelled"));
    const timer = setTimeout(() => {
      timedOut = failure === null;
      end(new Error(`timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const finish = (exitCode: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const failed = error ?? (exitCode !== 0 ? new Error(`exit code ${exitCode ?? "none"}`) : null);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), exitCode, error: failed, timedOut });
    };
    const collect = (sink: Buffer[]) => (data: Buffer) => {
      if (failure) return;
      bytes += data.length;
      if (bytes > MAX_BUFFER_BYTES) {
        end(new Error(`output exceeded ${MAX_BUFFER_BYTES} bytes`));
        return;
      }
      sink.push(data);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error: Error) => finish(null, error));
    child.on("close", (code: number | null) => finish(failure ? null : code, failure));
    child.stdin.end("");
  });
}

/** Runs one adb command to completion. stdout stays binary (`exec-out screencap`). */
export async function runAdb(adbPath: string, args: readonly string[], options: AdbRunOptions = {}): Promise<AdbRunResult> {
  const fullArgs = withSerial(options.serial, args);
  const result = offThreadSpawnEnabled()
    ? await captureOffThread(adbPath, fullArgs, options)
    : await captureWithExecFile(adbPath, fullArgs, options);
  const { error, exitCode } = result;
  if (error && !(options.allowFailure && exitCode !== null)) {
    const what = `adb ${fullArgs.join(" ")}`;
    const reason = options.signal?.aborted
      ? "was cancelled"
      : result.timedOut ? "timed out" : `failed (${exitCode ?? (error as NodeJS.ErrnoException).code ?? "no exit code"})`;
    throw new AdbError(`${what} ${reason}: ${result.stderr.trim() || error.message}`, exitCode, result.stderr);
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: exitCode ?? 0 };
}

/** Runs one adb command and returns its stdout as trimmed text. */
export async function runAdbText(adbPath: string, args: readonly string[], options: AdbRunOptions = {}): Promise<string> {
  const result = await runAdb(adbPath, args, options);
  return result.stdout.toString("utf8").trim();
}

/** Starts a long-running adb command (a server process, `logcat`) the caller owns. */
export function spawnAdb(adbPath: string, args: readonly string[], options: { serial?: string | null } = {}): ChildProcess {
  return spawn(adbPath, withSerial(options.serial, args), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
