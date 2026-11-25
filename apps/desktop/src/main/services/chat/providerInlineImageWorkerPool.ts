import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isPackagedRuntime } from "../../../shared/accountDirectory";
import { captureError, captureProblem } from "../../../shared/sentry/capture";
import { isEmbeddedAdeRuntime } from "../shared/processExecution";
import type { CodecDisplayResult, CodecFitResult } from "./providerInlineImageCodec";

/**
 * Runs image decode, downscale and re-encode on worker threads, so fitting
 * four pasted Retina screenshots no longer holds the brain's event loop for
 * seconds (`brain.stall_profile` once saw 2.9 s in one run).
 *
 * - **Where the code comes from.** The worker is the bundle
 *   `providerInlineImageWorker.cjs`, beside the bundle that loads this module
 *   (the brain's `cli.cjs`, Electron main's `main.cjs`, the SDK workers). The
 *   standalone runtime (one Node SEA executable, no files beside it) carries
 *   it as an SEA asset of the same name. The source is read once and started
 *   with `eval`, so a worker inside `app.asar` never has to load a file.
 * - **Fallback.** When no bundle is found (tests, `tsx` dev) or a worker cannot
 *   start, the caller runs the same codec in-process, as before. A failed
 *   start is reported once and retried after a minute; a packaged build or
 *   the standalone runtime with no bundle is reported once
 *   (`inline_image_worker.source_missing`).
 * - **Bounds.** At most two workers (one on a two-core machine), one image
 *   each; the rest wait in order. A worker stops after 15 s idle, and a job
 *   that runs past a minute stops its worker and fails.
 */

export const PROVIDER_INLINE_IMAGE_WORKER_FILE = "providerInlineImageWorker.cjs";

const IDLE_STOP_MS = 15_000;
const JOB_TIMEOUT_MS = 60_000;
const START_RETRY_MS = 60_000;

export type ImageWorkerRequest =
  | { id: number; op: "fit"; bytes: Uint8Array; isPng: boolean }
  | { id: number; op: "display"; bytes: Uint8Array; isPng: boolean; maxEdgePx: number; quality: number };

export type ImageWorkerError = { name: string; message: string; stack?: string };

/** A result as the port carries it: the bytes arrive as a plain Uint8Array, not a Buffer. */
type OverPort<Result> = Result extends { data: Buffer } ? Omit<Result, "data"> & { data: Uint8Array } : Result;

export type ImageWorkerResponse =
  | { id: number; ok: true; op: "fit"; result: OverPort<CodecFitResult> }
  | { id: number; ok: true; op: "display"; result: OverPort<CodecDisplayResult> }
  | { id: number; ok: false; error: ImageWorkerError };

/** What a worker answered; a codec failure arrives as `ok: false` with the codec's error. */
export type ImageWorkerOutcome<Result> = { ok: true; result: Result } | { ok: false; error: Error };

type Job = {
  request: ImageWorkerRequest;
  resolve: (response: ImageWorkerResponse | null) => void;
};

type Slot = {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  jobTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
};

const moduleDir = typeof __dirname === "string" ? __dirname : null;
const slots = new Set<Slot>();
const queue: Job[] = [];
let nextId = 1;
let sourceRead: Promise<string | null> | null = null;
let workerSource: string | null = null;
let startBlockedUntil = 0;
let startFailureReported = false;
let workerLimit: number | null = null;

function maxWorkers(): number {
  if (workerLimit === null) {
    const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    workerLimit = Math.max(1, Math.min(2, cores - 1));
  }
  return workerLimit;
}

/**
 * The worker bundle's source: the SEA asset in the standalone runtime, else
 * the file beside this bundle. Read once per process (`sourceRead`).
 */
async function readWorkerSource(): Promise<string | null> {
  const embedded = isEmbeddedAdeRuntime();
  const source = embedded ? readSeaWorkerAsset() : await readWorkerFile();
  // Tests and `tsx` dev have no bundle and fit in-process by design. A
  // packaged app and the standalone runtime are built with it
  // (`packaged-ade-cli-resources.cjs`, `build-static.mjs`), so there a missing
  // one is a build defect that puts every image back on the event loop.
  if (!source && (embedded || isPackagedRuntime(process.env))) {
    captureProblem("inline_image_worker.source_missing", {
      fingerprint: ["inline-image-worker", "source-missing"],
      tags: { runtime: embedded ? "sea" : "packaged" },
    });
  }
  return source;
}

function readSeaWorkerAsset(): string | null {
  try {
    const sea = process.getBuiltinModule?.("node:sea") as { getAsset?(key: string, encoding: string): string } | undefined;
    return sea?.getAsset?.(PROVIDER_INLINE_IMAGE_WORKER_FILE, "utf8") ?? null;
  } catch {
    // A runtime built without the asset.
    return null;
  }
}

async function readWorkerFile(): Promise<string | null> {
  if (!moduleDir) return null;
  try {
    return await fs.readFile(path.join(moduleDir, PROVIDER_INLINE_IMAGE_WORKER_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Fits a decodable PNG or JPEG on a worker. Null when no worker can take it,
 * so the caller runs the codec in-process.
 */
export async function fitDecodableImageOffThread(
  bytes: Buffer,
  isPng: boolean,
): Promise<ImageWorkerOutcome<CodecFitResult> | null> {
  const response = await run((id, copy) => ({ id, op: "fit", bytes: copy, isPng }), bytes);
  if (!response) return null;
  if (!response.ok) return { ok: false, error: toError(response.error) };
  if (response.op !== "fit") return { ok: false, error: new Error("image worker answered the wrong request") };
  const { result } = response;
  return { ok: true, result: result.kind === "fitted" ? { ...result, data: asBuffer(result.data) } : result };
}

/** A display copy made on a worker. Null when no worker can take it. */
export async function encodeDisplayCopyOffThread(
  bytes: Buffer,
  isPng: boolean,
  maxEdgePx: number,
  quality: number,
): Promise<ImageWorkerOutcome<CodecDisplayResult> | null> {
  const response = await run((id, copy) => ({ id, op: "display", bytes: copy, isPng, maxEdgePx, quality }), bytes);
  if (!response) return null;
  if (!response.ok) return { ok: false, error: toError(response.error) };
  if (response.op !== "display") return { ok: false, error: new Error("image worker answered the wrong request") };
  const { result } = response;
  return { ok: true, result: result ? { ...result, data: asBuffer(result.data) } : null };
}

/** The port hands back a plain Uint8Array; callers get a Buffer over the same memory. */
function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function toError(payload: ImageWorkerError): Error {
  const error = new Error(payload.message);
  error.name = payload.name;
  if (payload.stack) error.stack = payload.stack;
  return error;
}

async function run(
  build: (id: number, bytes: Uint8Array) => ImageWorkerRequest,
  bytes: Buffer,
): Promise<ImageWorkerResponse | null> {
  if (Date.now() < startBlockedUntil) return null;
  workerSource = await (sourceRead ??= readWorkerSource());
  if (!workerSource) return null;
  // A copy the port can transfer: the caller keeps its own buffer, and a
  // pooled Buffer never sends its neighbours' bytes along.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Promise((resolve) => {
    queue.push({ request: build(nextId++, copy), resolve });
    pump();
  });
}

function pump(): void {
  const source = workerSource;
  if (!source) return;
  while (queue.length > 0) {
    if (Date.now() < startBlockedUntil) {
      for (const job of queue.splice(0)) job.resolve(null);
      return;
    }
    let slot: Slot | null = null;
    for (const candidate of slots) {
      if (!candidate.job) {
        slot = candidate;
        break;
      }
    }
    if (!slot && slots.size < maxWorkers()) {
      slot = startSlot(source);
      // A start that threw blocked further starts: going round again hands
      // every waiting image to the in-process path instead of leaving it
      // queued with no worker that will ever pick it up.
      if (!slot) continue;
    }
    if (!slot) return;
    assign(slot, queue.shift()!);
  }
}

function startSlot(source: string): Slot | null {
  let worker: Worker;
  try {
    worker = new Worker(source, { eval: true });
  } catch (error) {
    blockStarts(error);
    return null;
  }
  const slot: Slot = { worker, ready: false, job: null, jobTimer: null, idleTimer: null };
  worker.on("message", (message: ImageWorkerResponse | { type: "ready" }) => {
    if ("type" in message) {
      slot.ready = true;
      return;
    }
    const job = slot.job;
    if (!job || message.id !== job.request.id) return;
    release(slot);
    job.resolve(message);
    pump();
  });
  worker.on("error", (error) => gone(slot, error));
  worker.on("exit", (code) => gone(slot, new Error(`exit code ${code}`)));
  slots.add(slot);
  return slot;
}

function assign(slot: Slot, job: Job): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = null;
  slot.job = job;
  // Held while it works, so a short-lived CLI process waits for its image.
  slot.worker.ref();
  slot.jobTimer = setTimeout(() => {
    slot.jobTimer = null;
    slots.delete(slot);
    slot.job = null;
    void slot.worker.terminate();
    if (!slot.ready) {
      // It never loaded: the image runs in-process like any failed start.
      blockStarts(new Error(`image worker did not start within ${JOB_TIMEOUT_MS / 1000} s`));
      job.resolve(null);
    } else {
      job.resolve({ id: job.request.id, ok: false, error: { name: "Error", message: `image worker timed out after ${JOB_TIMEOUT_MS / 1000} s` } });
    }
    pump();
  }, JOB_TIMEOUT_MS);
  slot.jobTimer.unref();
  const { request } = job;
  try {
    slot.worker.postMessage(request, [request.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    release(slot);
    const message = error instanceof Error ? error.message : String(error);
    job.resolve({ id: request.id, ok: false, error: { name: "Error", message } });
  }
}

/** Ends a job on a live slot: unref'd, and stopped after a quiet spell. */
function release(slot: Slot): void {
  if (slot.jobTimer) clearTimeout(slot.jobTimer);
  slot.jobTimer = null;
  slot.job = null;
  slot.worker.unref();
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    slot.idleTimer = null;
    if (slot.job || !slots.delete(slot)) return;
    void slot.worker.terminate();
  }, IDLE_STOP_MS);
  slot.idleTimer.unref();
}

function gone(slot: Slot, error: Error): void {
  // `error` is followed by `exit`; an idle stop or a timeout removed it already.
  if (!slots.delete(slot)) return;
  if (slot.jobTimer) clearTimeout(slot.jobTimer);
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const job = slot.job;
  slot.job = null;
  if (!slot.ready) {
    // It never loaded, so it never ran the job: that image and the queue run
    // in-process, and so does everything for the next minute.
    blockStarts(error);
    job?.resolve(null);
    for (const queued of queue.splice(0)) queued.resolve(null);
    return;
  }
  job?.resolve({ id: job.request.id, ok: false, error: { name: error.name, message: `the image worker stopped (${error.message})` } });
  pump();
}

function blockStarts(error: unknown): void {
  startBlockedUntil = Date.now() + START_RETRY_MS;
  if (startFailureReported) return;
  startFailureReported = true;
  captureError(error, { fingerprint: ["inline-image-worker", "start"] });
}
