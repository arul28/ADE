import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Names the synchronous file call the brain's main thread is stuck in.
 *
 * macOS holds an `open()` inside the kernel while it asks the person at the
 * screen whether ADE may use a drive or folder, and a hung network drive does
 * the same anywhere. A synchronous call made then freezes the whole brain, and
 * the native sample of that freeze shows only JIT addresses above `open()`, so
 * the call and its caller went unnamed (Mac Studio, 2026-11-02, 42 s, then a
 * restart). This wraps the synchronous `fs` calls that take a path, once, at
 * brain start:
 *
 * - Every call writes its path and method into shared memory before it runs
 *   (about 50 ns). The watchdog's worker thread keeps running while the main
 *   thread is stuck, reads that memory, and names the path in the wedge record.
 * - Calls on a path that can stall (an external or network drive, or a folder
 *   macOS gates per program) also record the calling function. Taking a stack
 *   costs about a microsecond, so a per-second budget bounds it.
 * - A path under a folder that has stopped answering fails at once instead of
 *   joining the wait (see {@link setUnansweringSyncFsRoots}). Callers already
 *   handle a refused read; none of them handles a frozen brain.
 * - A call that took a second or more is logged with its caller once it ends.
 */

/** Byte offsets in the shared buffer. The worker's reader inlines the same numbers. */
const STATE_INT32 = 0; // > 0 while the main thread is inside a tracked call
const METHOD_INT32 = 1;
const PATH_LENGTH_INT32 = 2;
const CALLER_LENGTH_INT32 = 3;
const SEQUENCE_INT32 = 4;
const STARTED_AT_FLOAT64_BYTE = 32;
const PATH_BYTE = 64;
const PATH_CAPACITY = 1_024;
const CALLER_BYTE = PATH_BYTE + PATH_CAPACITY;
const CALLER_CAPACITY = 384;
export const SYNC_FS_CALL_BUFFER_BYTES = CALLER_BYTE + CALLER_CAPACITY;

export const SYNC_FS_TRACKED_METHODS = [
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "lstatSync",
  "mkdirSync",
  "mkdtempSync",
  "openSync",
  "opendirSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "statfsSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
] as const;
type TrackedMethod = (typeof SYNC_FS_TRACKED_METHODS)[number];

/** Calls that take two paths; both are checked against an unanswering folder. */
const TWO_PATH_METHODS = new Set<TrackedMethod>(["copyFileSync", "cpSync", "renameSync", "symlinkSync"]);

/** A call that ran this long is logged once it returns. */
export const SLOW_SYNC_FS_CALL_MS = 1_000;
/** Stacks taken per second at most; past it a call records its path only. */
const CALLER_CAPTURES_PER_SECOND = 2_000;
const SLOW_CALL_REPEAT_MS = 10 * 60_000;
const MAX_SLOW_CALL_SITES = 200;
const CALLER_FRAMES = 3;

export type SyncFsCallSnapshot = {
  method: string;
  path: string;
  caller: string | null;
  /** Epoch ms (high resolution) the call started. */
  startedAtMs: number;
};

/**
 * Read what the main thread is inside, or null when it is not in a tracked
 * call. Self-contained so the watchdog worker can inline it with `toString()`.
 */
export function readSyncFsCall(buffer: SharedArrayBuffer, methods: readonly string[]): SyncFsCallSnapshot | null {
  const ints = new Int32Array(buffer, 0, 8);
  const before = Atomics.load(ints, 4);
  if (Atomics.load(ints, 0) <= 0) return null;
  const decoder = new TextDecoder();
  const pathLength = Math.min(Atomics.load(ints, 2), 1_024);
  const callerLength = Math.min(Atomics.load(ints, 3), 384);
  const snapshot = {
    method: methods[Atomics.load(ints, 1)] ?? "unknown",
    // Copied out first: TextDecoder refuses a view of shared memory.
    path: decoder.decode(new Uint8Array(buffer, 64, pathLength).slice()),
    caller: callerLength > 0 ? decoder.decode(new Uint8Array(buffer, 64 + 1_024, callerLength).slice()) : null,
    startedAtMs: new Float64Array(buffer, 32, 1)[0] ?? 0,
  };
  // The main thread started another call while this one was read.
  if (Atomics.load(ints, 4) !== before) return null;
  return snapshot;
}

/** Whether a path is somewhere an `open()` can wait on a person or a network. */
export function isStallCapablePath(
  target: string,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): boolean {
  if (platform === "darwin") {
    if (target.startsWith("/Volumes/") || target.startsWith("/Network/")) return true;
    if (!target.startsWith(home)) return false;
    const rest = target.slice(home.length);
    return rest.startsWith("/Desktop")
      || rest.startsWith("/Documents")
      || rest.startsWith("/Downloads")
      || rest.startsWith("/Library/Mobile Documents")
      || rest.startsWith("/Library/CloudStorage");
  }
  if (platform === "win32") {
    if (target.startsWith("\\\\") || target.startsWith("//")) return true;
    const drive = /^([a-zA-Z]):/.exec(target)?.[1];
    if (!drive) return false;
    const systemDrive = (process.env.SystemDrive ?? "C:").charAt(0);
    return drive.toUpperCase() !== systemDrive.toUpperCase();
  }
  return target.startsWith("/mnt/")
    || target.startsWith("/media/")
    || target.startsWith("/run/media/")
    || target.startsWith("/net/");
}

/**
 * The error a call on an unanswering folder gets instead of waiting. Coded
 * `storage_read_failed`, ADE's "unreadable, not corrupt" verdict, so callers
 * and devices show the reason; deliberately no errno or syscall, which would
 * read as an internal fault and be hidden behind a reference.
 */
export class SyncFsRootNotAnsweringError extends Error {
  readonly code = "storage_read_failed";
  readonly path: string;
  constructor(target: string, root: string) {
    super(`ADE can't read ${root} on this computer right now: it is not answering. If macOS is asking on this computer's screen whether ADE may use this drive or folder, allow it; if the drive is not responding, reconnect it.`);
    this.path = target;
  }
}

let buffer: SharedArrayBuffer | null = null;
let unansweringRoots: string[] = [];

/** The shared buffer the watchdog worker reads, or null before install. */
export function syncFsCallBuffer(): SharedArrayBuffer | null {
  return buffer;
}

/**
 * Folders whose synchronous calls fail at once instead of waiting. Set by the
 * project-root monitor, which asks off the main thread; empty clears it.
 */
export function setUnansweringSyncFsRoots(roots: readonly string[]): void {
  unansweringRoots = roots.map((root) => root.replace(/[\\/]+$/, ""));
}

function unansweringRootOf(target: string): string | null {
  for (const root of unansweringRoots) {
    if (target === root) return root;
    if (target.startsWith(root)) {
      const next = target.charAt(root.length);
      if (next === "/" || next === "\\") return root;
    }
  }
  return null;
}

function pathOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** "fnName (cli.cjs:123)", without this module's frames. */
function callerOf(frames: NodeJS.CallSite[]): string {
  const parts: string[] = [];
  for (const frame of frames) {
    if (parts.length >= CALLER_FRAMES) break;
    const name = frame.getFunctionName() ?? frame.getMethodName() ?? "<anonymous>";
    const file = frame.getFileName() ?? "";
    const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
    parts.push(`${name} (${base}:${frame.getLineNumber() ?? 0})`);
  }
  return parts.join(" < ");
}

type Warn = (event: string, meta: Record<string, unknown>) => void;
type SlowSite = { lastLoggedAt: number; slowSinceLog: number; maxMsSinceLog: number };

let installed = false;

export function installSyncFsCallTracker(args: { warn: Warn }): void {
  if (installed) return;
  installed = true;
  buffer = new SharedArrayBuffer(SYNC_FS_CALL_BUFFER_BYTES);
  const ints = new Int32Array(buffer, 0, 8);
  const startedAt = new Float64Array(buffer, STARTED_AT_FLOAT64_BYTE, 1);
  const pathBytes = new Uint8Array(buffer, PATH_BYTE, PATH_CAPACITY);
  const callerBytes = new Uint8Array(buffer, CALLER_BYTE, CALLER_CAPACITY);
  const encoder = new TextEncoder();
  const clockOrigin = performance.timeOrigin;
  let depth = 0;
  let captureWindowStartedAt = 0;
  let capturesInWindow = 0;
  const slowSites = new Map<string, SlowSite>();

  const captureCaller = (wrapper: Function): string | null => {
    const now = performance.now();
    if (now - captureWindowStartedAt >= 1_000) {
      captureWindowStartedAt = now;
      capturesInWindow = 0;
    }
    if (capturesInWindow >= CALLER_CAPTURES_PER_SECOND) return null;
    capturesInWindow += 1;
    const previousPrepare = Error.prepareStackTrace;
    const previousLimit = Error.stackTraceLimit;
    try {
      Error.prepareStackTrace = (_error, frames) => frames;
      Error.stackTraceLimit = CALLER_FRAMES;
      const holder: { stack?: NodeJS.CallSite[] } = {};
      // Frames above the wrapper only: the first one is the caller.
      Error.captureStackTrace(holder, wrapper);
      return Array.isArray(holder.stack) ? callerOf(holder.stack) : null;
    } catch {
      return null;
    } finally {
      Error.prepareStackTrace = previousPrepare;
      Error.stackTraceLimit = previousLimit;
    }
  };

  const reportSlow = (method: string, target: string, caller: string | null, durationMs: number): void => {
    const key = `${method}\u0000${caller ?? target}`;
    const at = Date.now();
    let site = slowSites.get(key);
    if (!site) {
      if (slowSites.size >= MAX_SLOW_CALL_SITES) slowSites.clear();
      site = { lastLoggedAt: 0, slowSinceLog: 0, maxMsSinceLog: 0 };
      slowSites.set(key, site);
    }
    site.slowSinceLog += 1;
    site.maxMsSinceLog = Math.max(site.maxMsSinceLog, durationMs);
    if (site.lastLoggedAt > 0 && at - site.lastLoggedAt < SLOW_CALL_REPEAT_MS) return;
    args.warn("brain.sync_fs_call_slow", {
      method,
      path: target,
      caller,
      durationMs,
      occurrences: site.slowSinceLog,
      maxMs: site.maxMsSinceLog,
    });
    site.lastLoggedAt = at;
    site.slowSinceLog = 0;
    site.maxMsSinceLog = 0;
  };

  const wrap = (method: TrackedMethod, methodIndex: number): void => {
    const original = (fs as unknown as Record<string, unknown>)[method];
    if (typeof original !== "function") return;
    const call = original as (...callArgs: unknown[]) => unknown;
    const twoPaths = TWO_PATH_METHODS.has(method);
    const wrapped = function syncFsCallTracker(this: unknown, ...callArgs: unknown[]): unknown {
      // Nested calls (cpSync walks with its own calls) keep the outer record.
      if (depth > 0) return call.apply(this, callArgs);
      const target = pathOf(callArgs[0]);
      if (target === null) return call.apply(this, callArgs);
      if (unansweringRoots.length > 0) {
        const root = unansweringRootOf(target)
          ?? (twoPaths ? (() => { const second = pathOf(callArgs[1]); return second ? unansweringRootOf(second) : null; })() : null);
        if (root !== null) {
          if (method === "existsSync") return false;
          throw new SyncFsRootNotAnsweringError(target, root);
        }
      }
      const caller = isStallCapablePath(target) ? captureCaller(wrapped) : null;
      Atomics.add(ints, SEQUENCE_INT32, 1);
      ints[METHOD_INT32] = methodIndex;
      ints[PATH_LENGTH_INT32] = encoder.encodeInto(target, pathBytes).written ?? 0;
      ints[CALLER_LENGTH_INT32] = caller ? encoder.encodeInto(caller, callerBytes).written ?? 0 : 0;
      const started = performance.now();
      startedAt[0] = clockOrigin + started;
      depth += 1;
      Atomics.store(ints, STATE_INT32, 1);
      try {
        return call.apply(this, callArgs);
      } finally {
        Atomics.store(ints, STATE_INT32, 0);
        depth -= 1;
        const durationMs = performance.now() - started;
        if (durationMs >= SLOW_SYNC_FS_CALL_MS) {
          try {
            reportSlow(method, target, caller ?? captureCaller(wrapped), Math.round(durationMs));
          } catch {
            // A diagnostic must never change what the call returned or threw.
          }
        }
      }
    };
    // realpathSync.native and the like hang off the function itself.
    for (const key of Object.keys(call)) {
      (wrapped as unknown as Record<string, unknown>)[key] = (call as unknown as Record<string, unknown>)[key];
    }
    (fs as unknown as Record<string, unknown>)[method] = wrapped;
  };

  SYNC_FS_TRACKED_METHODS.forEach((method, index) => wrap(method, index));
  // ESM importers of `node:fs` read named exports from a copy; refresh it.
  syncBuiltinESMExports();
}
