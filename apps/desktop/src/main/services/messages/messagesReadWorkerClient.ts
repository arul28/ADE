/**
 * Runs one Messages read request in a child process.
 *
 * The reader touches `~/Library/Messages/chat.db`, which macOS TCC attributes to
 * the process that opens it. Running this as a child of ADE.app (`process.execPath`
 * with `ELECTRON_RUN_AS_NODE=1`) means the Full Disk Access grant belongs to
 * ADE.app, and the synchronous SQLite work cannot stall a window, an IPC
 * handler, or an agent's tool call. The `.ts` entry is used under tsx in dev and
 * the bundled `.cjs` in a release, mirroring `loginImportReadWorkerClient`.
 *
 * Unlike login import there is no OS consent modal behind the read, so a stuck
 * child is a bug rather than a person deciding: every call has a 20 s timeout,
 * every settle path kills the child, and {@link terminateMessagesReadWorkers}
 * kills anything left at app quit. Request options and responses carry message
 * text, phone numbers and codes, so this module never logs any of them.
 *
 * @module messages/messagesReadWorkerClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { terminateProcessTree } from "../shared/processExecution";
import type { ChatRecord, MessageRecord, ReadRecentMessagesOptions } from "./messagesDatabase";

export const MESSAGES_READ_WORKER_TIMEOUT_MS = 20_000;

export type MessagesReadRequest =
  | ({ readonly op: "recent" } & ReadRecentMessagesOptions)
  | { readonly op: "chats"; readonly limit?: number }
  | { readonly op: "access" };

export type MessagesReadFailureCode =
  | "needs_full_disk_access"
  | "no_database"
  | "unsupported_platform"
  | "error";

export type MessagesReadResponse =
  | { readonly ok: true; readonly op: "recent"; readonly messages: MessageRecord[] }
  | { readonly ok: true; readonly op: "chats"; readonly chats: ChatRecord[] }
  | { readonly ok: true; readonly op: "access"; readonly path: string }
  | { readonly ok: false; readonly code: MessagesReadFailureCode; readonly message: string };

export type MessagesReadWorkerOptions = {
  /** Injected for tests. */
  spawnWorker?: typeof spawn;
  workerPath?: string;
  /** Overrides {@link MESSAGES_READ_WORKER_TIMEOUT_MS}; injected for tests. */
  timeoutMs?: number;
};

/**
 * Every child this module has spawned and not yet reaped. Module-level because
 * app quit has no handle on an individual call's promise.
 */
const liveWorkers = new Set<ChildProcessWithoutNullStreams>();

/**
 * Kills every in-flight Messages read. Called from the app's shutdown path.
 *
 * `terminateProcessTree` rather than `child.kill()`: on win32 it runs
 * `taskkill /T` as well, reaching any descendant the worker started. The
 * Messages worker can only run on macOS, but the shutdown path is shared.
 */
export function terminateMessagesReadWorkers(): number {
  const children = [...liveWorkers];
  liveWorkers.clear();
  for (const child of children) {
    try {
      terminateProcessTree(child);
    } catch {
      // Best effort — an already-exited child is the good outcome.
    }
  }
  return children.length;
}

function resolveMessagesReadWorkerPath(baseDir = __dirname): string {
  const configured = process.env.ADE_MESSAGES_READ_WORKER_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(baseDir, "messagesReadWorker.cjs"),
    path.join(baseDir, "messagesReadWorkerEntry.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function failed(code: MessagesReadFailureCode, message: string): MessagesReadResponse {
  return { ok: false, code, message };
}

function isFailureCode(value: unknown): value is MessagesReadFailureCode {
  return value === "needs_full_disk_access"
    || value === "no_database"
    || value === "unsupported_platform"
    || value === "error";
}

/**
 * Parses a worker answer without trusting its shape. A missing array would
 * otherwise reach the renderer as `undefined` and paint an empty result.
 */
function parseWorkerAnswer(stdout: string): MessagesReadResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const answer = parsed as Record<string, unknown>;

  if (answer.ok === false) {
    return failed(
      isFailureCode(answer.code) ? answer.code : "error",
      typeof answer.message === "string" && answer.message !== ""
        ? answer.message
        : "Messages could not be read.",
    );
  }
  if (answer.ok !== true) return null;
  if (answer.op === "recent" && Array.isArray(answer.messages)) {
    return { ok: true, op: "recent", messages: answer.messages as MessageRecord[] };
  }
  if (answer.op === "chats" && Array.isArray(answer.chats)) {
    return { ok: true, op: "chats", chats: answer.chats as ChatRecord[] };
  }
  if (answer.op === "access" && typeof answer.path === "string") {
    return { ok: true, op: "access", path: answer.path };
  }
  return null;
}

/**
 * Sends one request to the Messages read worker and resolves its answer.
 *
 * Never rejects: every failure is a typed `{ ok: false }` response, so the
 * service above it has one error shape to handle. Off macOS it answers
 * `unsupported_platform` without spawning anything.
 */
export function readMessagesInWorker(
  request: MessagesReadRequest,
  options: MessagesReadWorkerOptions = {},
): Promise<MessagesReadResponse> {
  if (process.platform !== "darwin") {
    return Promise.resolve(failed("unsupported_platform", "Messages is available on Macs only."));
  }

  const workerPath = options.workerPath ?? resolveMessagesReadWorkerPath();
  if (!options.spawnWorker && !fs.existsSync(workerPath)) {
    return Promise.resolve(failed("error", "ADE's Messages helper is missing from this build."));
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
      resolve(failed("error", error instanceof Error ? error.message : "The Messages helper could not start."));
      return;
    }

    liveWorkers.add(child);
    let stdout = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? MESSAGES_READ_WORKER_TIMEOUT_MS;

    const finish = (response: MessagesReadResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (liveWorkers.delete(child)) {
        try {
          terminateProcessTree(child);
        } catch {
          // Already gone — the ordinary case on the `close` path.
        }
      }
      resolve(response);
    };

    const timer = setTimeout(() => {
      finish(failed("error", "The Messages helper did not answer in time."));
    }, timeoutMs);
    // Do not hold the process open on the account of a child being slow; app
    // quit reaches it through `terminateMessagesReadWorkers` anyway.
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // Never read or echo: stderr can quote a database path or, worse, a row.
    child.stderr.resume();
    child.on("error", (error) => {
      finish(failed("error", error instanceof Error ? error.message : "The Messages helper failed to run."));
    });
    child.on("close", () => {
      const answer = stdout.trim() === "" ? null : parseWorkerAnswer(stdout);
      finish(
        answer
          ?? failed("error", "The Messages helper returned an unreadable answer."),
      );
    });

    try {
      child.stdin.end(JSON.stringify(request));
    } catch (error) {
      finish(failed("error", error instanceof Error ? error.message : "The Messages helper could not be reached."));
    }
  });
}
