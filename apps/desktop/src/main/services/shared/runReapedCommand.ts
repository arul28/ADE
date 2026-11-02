import { spawn, type ChildProcess } from "node:child_process";
import { execFileOffThread, offThreadSpawnEnabled } from "./offThreadSpawn";
import { terminateProcessTree } from "./processExecution";
import { signalProcessGroup } from "./utils";

export type ReapedCommandResult = {
  /** The exit code, or null when the command never ran, timed out, or overran maxBuffer. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the command could not start, timed out, or overran maxBuffer. */
  error: Error | null;
};

/**
 * Run a short CLI and make sure nothing it started outlives it.
 *
 * `gh` reads its token through `/usr/bin/security`. When the keychain does not
 * answer (a locked keychain waiting on a password dialog), gh gives up after
 * 3 s and exits, but the `security` it started keeps waiting, and a timeout
 * that kills only gh leaves it too. Every poll then adds one stuck process;
 * on 2026-11-01 that filled the Mac's per-user process limit and nothing,
 * not even SSH, could start.
 *
 * On POSIX the command leads its own process group, and the group is killed
 * when the command exits or times out, so a helper it left behind goes with
 * it. On Windows a timeout kills the tree with taskkill; gh reads Credential
 * Manager in-process there, so a normal exit leaves nothing behind.
 */
export function runReapedCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number },
): Promise<ReapedCommandResult> {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  if (offThreadSpawnEnabled()) {
    return execFileOffThread(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs,
      maxBuffer,
    }).then((result) => ({
      ...result,
      timedOut: Boolean(result.error && /timed out/.test(result.error.message)),
    }));
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group, so the group kill below reaches its helpers.
        // Never on Windows: there it would start the command with no console.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | null = null;
    let timedOut = false;
    let settled = false;
    let reaped = false;

    const reap = () => {
      if (reaped) return;
      reaped = true;
      if (process.platform === "win32") {
        terminateProcessTree(child, "SIGKILL");
        return;
      }
      // Right at exit, before the pid can be handed out again: a group with a
      // live member keeps its id reserved, and an empty one answers ESRCH.
      if (typeof child.pid === "number") {
        try {
          signalProcessGroup(child.pid, "SIGKILL");
        } catch {
          // The group is already empty.
        }
      }
    };
    const finish = (exitCode: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        error,
      });
    };
    const fail = (error: Error) => {
      failure ??= error;
      reap();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      fail(new Error(`${command} timed out after ${options.timeoutMs} ms`));
      // Settle now: a helper that moved to another group could hold the pipes
      // open, and the caller's deadline is the deadline.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, failure);
    }, options.timeoutMs);
    timer.unref?.();

    // Per stream, as execFile counts maxBuffer.
    const collect = (sink: Buffer[]) => {
      let bytes = 0;
      return (data: Buffer) => {
        if (failure) return;
        bytes += data.length;
        if (bytes > maxBuffer) {
          fail(new Error(`${command} output exceeded maxBuffer (${maxBuffer} bytes)`));
          return;
        }
        sink.push(data);
      };
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("exit", reap);
    child.on("error", (error: Error) => finish(null, error));
    child.on("close", (code: number | null) => finish(failure ? null : code, failure));
  });
}
