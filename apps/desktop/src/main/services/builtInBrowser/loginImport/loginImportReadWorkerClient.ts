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
 * @module loginImport/loginImportReadWorkerClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { LoginImportReadRequest, LoginImportReadResponse } from "./loginImportRead";

export type LoginImportReadWorkerOptions = {
  /** Injected for tests. */
  spawnWorker?: typeof spawn;
  workerPath?: string;
};

export function resolveLoginImportReadWorkerPath(baseDir = __dirname): string {
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

    let stdout = "";
    let settled = false;
    const finish = (response: LoginImportReadResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

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
