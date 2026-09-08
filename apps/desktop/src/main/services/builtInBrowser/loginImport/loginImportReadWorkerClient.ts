/**
 * Runs one {@link LoginImportReadRequest} in a child process.
 *
 * Mirrors `usageLedgerWorkerClient`'s shape — `process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1`, the bundled `.cjs` in a build and the `.ts` entry
 * under `tsx` in dev — because the reader only needs Node built-ins
 * (`node:sqlite`, `node:crypto`, `child_process`) and never Electron.
 *
 * Deliberately NO timeout on the wait: on macOS the child is sitting behind a
 * Keychain consent modal, and a timeout racing the human means the prompt can
 * be approved while nothing is left listening. That was safe to state and unsafe
 * to *do* on the main thread; in a child process it costs nothing but one idle
 * pid, and the caller can still walk away because the UI never blocked.
 *
 * "No timeout" is only defensible with an answer to "then how does it end", so:
 * every live child is tracked here, the promise's own settle path terminates it,
 * an `AbortSignal` cancels it, and {@link terminateLoginImportReadWorkers} kills
 * whatever is left at app quit. Without that last one, quitting ADE while a
 * Keychain modal is up leaves an orphaned `Electron (ELECTRON_RUN_AS_NODE)`
 * process still holding an OS credential prompt — Node does not reap
 * non-detached children when the parent exits on macOS.
 *
 * @module loginImport/loginImportReadWorkerClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { terminateProcessTree } from "../../shared/processExecution";
import type { LoginImportReadRequest, LoginImportReadResponse } from "./loginImportRead";

export type LoginImportReadWorkerOptions = {
  /** Injected for tests. */
  spawnWorker?: typeof spawn;
  workerPath?: string;
  /** Cancels the read and kills the child; the promise resolves as a failure. */
  signal?: AbortSignal;
};

/**
 * Every child this module has spawned and not yet reaped.
 *
 * Module-level rather than per-call because the thing that has to reach them —
 * app quit — has no handle on any individual promise.
 */
const liveWorkers = new Set<ChildProcessWithoutNullStreams>();

/**
 * Kill every in-flight login-import read. Called from the app's shutdown path.
 *
 * `terminateProcessTree`, not `child.kill()`: on Windows the child is reached
 * through a shim and only the tree kill actually ends it.
 */
export function terminateLoginImportReadWorkers(): number {
  const children = [...liveWorkers];
  liveWorkers.clear();
  for (const child of children) {
    try {
      terminateProcessTree(child);
    } catch {
      // Best effort — a child that already exited is the good outcome.
    }
  }
  return children.length;
}

function resolveLoginImportReadWorkerPath(baseDir = __dirname): string {
  const configured = process.env.ADE_LOGIN_IMPORT_WORKER_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(baseDir, "loginImportReadWorker.cjs"),
    path.join(baseDir, "loginImportReadWorkerEntry.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function failed(reason: string): LoginImportReadResponse {
  return { ok: false, status: "read_failed", reason };
}

export function readLoginImportSourceInWorker(
  request: LoginImportReadRequest,
  options: LoginImportReadWorkerOptions = {},
): Promise<LoginImportReadResponse> {
  const workerPath = options.workerPath ?? resolveLoginImportReadWorkerPath();
  if (!options.spawnWorker && !fs.existsSync(workerPath)) {
    return Promise.resolve(failed("ADE's login import helper is missing from this build."));
  }
  if (options.signal?.aborted) {
    return Promise.resolve(failed("The login import read was cancelled."));
  }
  return new Promise((resolve) => {
    const spawnWorker = options.spawnWorker ?? spawn;
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnWorker(
        process.execPath,
        [...(workerPath.endsWith(".ts") ? process.execArgv : []), workerPath],
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolve(failed(error instanceof Error ? error.message : "The login import helper could not start."));
      return;
    }

    liveWorkers.add(child);
    let stdout = "";
    let settled = false;
    const finish = (response: LoginImportReadResponse): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      // Every settle path ends the child, not just the clean `close`. The
      // spawn-error, unreadable-answer and stdin-write-failure paths used to
      // resolve while leaving a live process behind a Keychain modal.
      if (liveWorkers.delete(child)) {
        try {
          terminateProcessTree(child);
        } catch {
          // Already gone — the ordinary case on the `close` path.
        }
      }
      resolve(response);
    };
    const onAbort = (): void => {
      finish(failed("The login import read was cancelled."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // Never echoed anywhere: a reader's stderr can quote a database path, and
    // this whole module exists to keep jar contents out of the parent's logs.
    child.stderr.resume();
    child.on("error", (error) => {
      finish(failed(error instanceof Error ? error.message : "The login import helper failed to run."));
    });
    child.on("close", () => {
      if (!stdout.trim()) {
        finish(failed("The login import helper exited without answering."));
        return;
      }
      try {
        finish(JSON.parse(stdout) as LoginImportReadResponse);
      } catch {
        finish(failed("The login import helper returned an unreadable answer."));
      }
    });

    try {
      child.stdin.end(JSON.stringify(request));
    } catch (error) {
      finish(failed(error instanceof Error ? error.message : "The login import helper could not be reached."));
    }
  });
}
