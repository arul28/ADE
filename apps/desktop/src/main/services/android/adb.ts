import { execFile, spawn, type ChildProcess } from "node:child_process";

/*
 * The one way the Android services run `adb`. Node built-ins only, so the
 * Android backend also runs on its own under `tsx` on a machine with no
 * `node_modules`.
 *
 * Arguments go to the binary as an array (never through a shell), so a serial
 * or a path with spaces needs no quoting on Windows or POSIX.
 */

export type AdbRunResult = {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
};

export class AdbError extends Error {
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

/** Runs one adb command to completion. stdout stays binary (`exec-out screencap`). */
export function runAdb(adbPath: string, args: readonly string[], options: AdbRunOptions = {}): Promise<AdbRunResult> {
  const fullArgs = withSerial(options.serial, args);
  return new Promise((resolve, reject) => {
    execFile(
      adbPath,
      fullArgs,
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const stderrText = stderr.toString("utf8");
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        if (error && !(options.allowFailure && exitCode !== null)) {
          const what = `adb ${fullArgs.join(" ")}`;
          const reason = options.signal?.aborted
            ? "was cancelled"
            : error.killed ? "timed out" : `failed (${exitCode ?? error.code ?? "no exit code"})`;
          reject(new AdbError(`${what} ${reason}: ${stderrText.trim() || error.message}`, exitCode, stderrText));
          return;
        }
        resolve({ stdout, stderr: stderrText, exitCode: exitCode ?? 0 });
      },
    );
  });
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
