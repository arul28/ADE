import fs from "node:fs";
import path from "node:path";
import type { SyncHostStorageWait } from "../../../../desktop/src/shared/types/sync";
import { isStallCapablePath, setUnansweringSyncFsRoots } from "../runtime/syncFsCallTracker";

/**
 * Watches, off the main thread, whether each open project folder still answers.
 *
 * `assertProjectRootReadable` guards opening a project. A brain that is already
 * running reads its projects synchronously from timers all day, and macOS can
 * start asking again at any time whether ADE may use a drive (Mac Studio,
 * 2026-11-02: a timer's `open()` waited on the prompt and the watchdog killed
 * the brain after 42 s). So every few seconds this lists each folder with an
 * asynchronous call, which waits on a libuv pool thread rather than the event
 * loop. A listing that does not finish in time marks the folder as not
 * answering:
 *
 * - synchronous calls under it fail at once instead of freezing the brain
 *   (the sync-fs tracker's guard);
 * - every connected device is told, in plain words, that macOS may be asking
 *   on this computer's screen;
 * - when the listing finishes, the folder is readable again and all of it
 *   clears.
 *
 * A refused listing (the person chose Don't Allow) is reported too; it never
 * freezes anything, so it does not engage the guard.
 */

/**
 * How often each folder that can stall is listed. One async listing costs
 * microseconds; the sooner a prompt is seen, the less likely a timer's
 * synchronous call walks into it first.
 */
export const PROJECT_ROOT_PROBE_INTERVAL_MS = 5_000;
/** A healthy folder answers in milliseconds; a waiting one never does. */
export const PROJECT_ROOT_PROBE_TIMEOUT_MS = 3_000;

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

type RootState = {
  root: string;
  /** Runtimes that have it open; 0 when only waited on after a failed open or a wedge. */
  openCount: number;
  wait: { reason: SyncHostStorageWait["reason"]; sinceMs: number; source: string } | null;
  /**
   * A file under the root that is known to have hung (the previous brain died
   * opening it). Probed instead of the folder until it answers: a drive the
   * system gates hangs on any of its files, and one stuck file is still stuck.
   */
  probePath: string | null;
  probeInFlight: boolean;
};

const roots = new Map<string, RootState>();
const listeners = new Set<() => void>();
let logger: Logger | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function normalizeRoot(root: string): string {
  return path.resolve(root).replace(/[\\/]+$/, "") || root;
}

function notify(): void {
  setUnansweringSyncFsRoots(
    [...roots.values()].filter((state) => state.wait?.reason === "not_answering").map((state) => state.root),
  );
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener's failure must not stop the others hearing.
    }
  }
}

function startWait(state: RootState, reason: SyncHostStorageWait["reason"], source: string, extra: Record<string, unknown> = {}): void {
  if (state.wait?.reason === reason) return;
  const previous = state.wait;
  state.wait = { reason, sinceMs: previous?.sinceMs ?? Date.now(), source };
  if (previous?.reason === "not_answering") {
    // Answered, with a refusal: the person chose Don't Allow.
    logger?.info("project_root.permission_wait_ended", {
      root: state.root,
      waitedMs: Date.now() - previous.sinceMs,
      outcome: reason,
    });
  }
  if (reason === "not_answering") {
    logger?.warn("project_root.not_answering", { root: state.root, source, ...extra });
    logger?.warn("project_root.permission_wait_started", {
      root: state.root,
      source,
      platform: process.platform,
    });
  } else {
    logger?.warn("project_root.access_denied", { root: state.root, source, ...extra });
  }
  notify();
}

function endWait(state: RootState, outcome: string): void {
  if (!state.wait) return;
  const waitedMs = Date.now() - state.wait.sinceMs;
  const reason = state.wait.reason;
  state.wait = null;
  if (reason === "not_answering") {
    logger?.info("project_root.permission_wait_ended", { root: state.root, waitedMs, outcome });
  }
  logger?.info("project_root.recovered", { root: state.root, waitedMs, previous: reason });
  if (state.openCount === 0) roots.delete(state.root);
  notify();
}

function probe(state: RootState): void {
  if (state.probeInFlight) return;
  state.probeInFlight = true;
  const startedAt = Date.now();
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    startWait(state, "not_answering", "probe", { waitedMs: Date.now() - startedAt });
  }, PROJECT_ROOT_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  const finish = (error: NodeJS.ErrnoException | null): void => {
    settled = true;
    clearTimeout(timeout);
    state.probeInFlight = false;
    // The folder may have been closed while the listing waited.
    if (roots.get(state.root) !== state) return;
    const code = error?.code;
    if (code === "EPERM" || code === "EACCES") {
      startWait(state, "denied", "probe", { code });
      return;
    }
    if (state.probePath) {
      // The file that hung answered (or is gone). The folder itself must
      // answer too before synchronous calls are let back in.
      state.probePath = null;
      probe(state);
      return;
    }
    // Anything else (gone, unmounted) is not a wait: nothing would freeze on it.
    endWait(state, error ? `error:${code ?? "unknown"}` : "answered");
  };
  const probePath = state.probePath;
  const answered = probePath
    ? fs.promises.open(probePath, "r").then((handle) => handle.close())
    // Listed, not stat-ed: macOS gates reading a folder, and a listing is what
    // the per-program prompt holds. The first entry is enough.
    : fs.promises.opendir(state.root).then(async (dir) => {
      try {
        await dir.read();
      } finally {
        await dir.close().catch(() => {});
      }
    });
  answered.then(() => finish(null), (error: NodeJS.ErrnoException) => finish(error));
}

/**
 * A folder on the internal disk outside the gated folders cannot wait on a
 * person or a network; listing it would only add false alarms when the pool is
 * busy. One already marked keeps being probed until it answers.
 */
function needsProbe(state: RootState): boolean {
  return state.wait !== null || isStallCapablePath(state.root);
}

function ensureTimer(): void {
  if (timer || ![...roots.values()].some(needsProbe)) return;
  timer = setInterval(() => {
    let probed = false;
    for (const state of roots.values()) {
      if (!needsProbe(state)) continue;
      probed = true;
      probe(state);
    }
    if (!probed && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, PROJECT_ROOT_PROBE_INTERVAL_MS);
  timer.unref?.();
}

function stateFor(root: string): RootState {
  const key = normalizeRoot(root);
  let state = roots.get(key);
  if (!state) {
    state = { root: key, openCount: 0, wait: null, probePath: null, probeInFlight: false };
    roots.set(key, state);
  }
  return state;
}

export function configureProjectRootAccessMonitor(args: { logger: Logger }): void {
  logger = args.logger;
}

/** An open project: watched until each {@link watchProjectRoot} has its {@link unwatchProjectRoot}. */
export function watchProjectRoot(root: string): void {
  stateFor(root).openCount += 1;
  ensureTimer();
}

export function unwatchProjectRoot(root: string): void {
  const state = roots.get(normalizeRoot(root));
  if (!state) return;
  state.openCount = Math.max(0, state.openCount - 1);
  // A waiting folder stays watched (and its notice stays up) until it answers.
  if (state.openCount === 0 && !state.wait) roots.delete(state.root);
}

/**
 * A folder found not answering by something other than the probe: a project
 * open that timed out, or the wedge the last brain died in. It stays marked,
 * and probed, until a listing finishes.
 */
export function reportProjectRootNotAnswering(
  root: string,
  source: string,
  extra: Record<string, unknown> & { path?: string } = {},
): void {
  const state = stateFor(root);
  if (typeof extra.path === "string" && extra.path) state.probePath = extra.path;
  startWait(state, "not_answering", source, extra);
  ensureTimer();
  probe(state);
}

/** The folder of {@link candidates} that contains `target`, or the target's own volume root. */
export function projectRootForPath(target: string, candidates: readonly string[]): string {
  const normalized = normalizeRoot(target);
  let best: string | null = null;
  for (const candidate of candidates) {
    const root = normalizeRoot(candidate);
    if ((normalized === root || normalized.startsWith(`${root}${path.sep}`)) && (!best || root.length > best.length)) {
      best = root;
    }
  }
  if (best) return best;
  // Not under a known project: the drive itself is what stopped answering.
  const volume = /^(\/Volumes\/[^/]+)/.exec(normalized)?.[1];
  return volume ?? path.dirname(normalized);
}

/** What every device is told, or null while every folder answers. Longest wait first. */
export function readProjectRootStorageWait(nowMs = Date.now()): SyncHostStorageWait | null {
  let oldest: RootState | null = null;
  for (const state of roots.values()) {
    if (!state.wait) continue;
    if (!oldest || state.wait.sinceMs < oldest.wait!.sinceMs) oldest = state;
  }
  if (!oldest?.wait) return null;
  return {
    path: oldest.root,
    reason: oldest.wait.reason,
    sinceAgoMs: Math.max(0, nowMs - oldest.wait.sinceMs),
    platform: process.platform,
  };
}

export function onProjectRootStorageWaitChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
