import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncHostStorageWait } from "../../../../desktop/src/shared/types/sync";
import { setUnansweringRoots } from "../../../../desktop/src/main/services/state/unansweringRoots";
import { isStallCapablePath } from "../runtime/syncFsCallTracker";

/**
 * Watches, off the main thread, whether each open project folder still answers.
 *
 * `assertProjectRootReadable` guards opening a project. A brain that is already
 * running reads its projects synchronously from timers all day, and macOS can
 * start asking again at any time whether ADE may use a drive (Mac Studio,
 * 2026-11-02: a timer's `open()` waited on the prompt and the watchdog killed
 * the brain after 42 s). So every few seconds this lists a folder on each drive
 * that can stall with an asynchronous call, which waits on a libuv pool thread
 * rather than the event loop. A listing that does not finish in time marks the
 * drive's project folders as not answering:
 *
 * - synchronous calls under them fail at once instead of freezing the brain
 *   (`unansweringRoots`, read by the sync-fs tracker and the SQLite openers);
 * - every connected device is told, in plain words, that macOS may be asking
 *   on this computer's screen;
 * - when the listing finishes, the folders are readable again and all of it
 *   clears.
 *
 * One probe per drive, never more: a probe that hangs holds its pool thread
 * until the prompt is answered, and the pool has four. The prompt gates the
 * whole drive, so one answer speaks for every project on it.
 *
 * A refused listing (the person chose Don't Allow) is reported too; it never
 * freezes anything, so it does not engage the guard.
 */

/**
 * How often each drive that can stall is listed. One async listing costs
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
  volume: string;
  /** Runtimes that have it open; 0 when only waited on after a failed open or a wedge. */
  openCount: number;
  wait: { reason: SyncHostStorageWait["reason"]; sinceMs: number; source: string } | null;
};

type VolumeState = {
  probeInFlight: boolean;
  /**
   * A file on the drive that is known to have hung (the previous brain died
   * opening it). Probed before the folder until it answers: a drive the system
   * gates hangs on any of its files, and one stuck file is still stuck.
   */
  probePath: string | null;
};

const roots = new Map<string, RootState>();
const volumes = new Map<string, VolumeState>();
const listeners = new Set<() => void>();
let logger: Logger | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function normalizeRoot(root: string): string {
  return path.resolve(root).replace(/[\\/]+$/, "") || root;
}

/**
 * The drive (or gated folder) a root lives on: what one permission prompt or
 * one hung mount covers. Falls back to the root itself.
 */
export function volumeOf(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return path.win32.parse(root).root || root;
  const parts = root.split("/");
  if (platform === "darwin") {
    if (parts[1] === "Volumes" || parts[1] === "Network") return parts.slice(0, 3).join("/");
    const home = os.homedir();
    if (root.startsWith(`${home}/`)) {
      const rest = root.slice(home.length + 1).split("/");
      const depth = rest[0] === "Library" ? 3 : 1;
      return [home, ...rest.slice(0, depth)].join("/");
    }
    return root;
  }
  if (parts[1] === "mnt" || parts[1] === "net") return parts.slice(0, 3).join("/");
  if (parts[1] === "media") return parts.slice(0, 4).join("/");
  if (parts[1] === "run" && parts[2] === "media") return parts.slice(0, 5).join("/");
  return root;
}

function membersOf(volume: string): RootState[] {
  return [...roots.values()].filter((state) => state.volume === volume);
}

function notify(): void {
  setUnansweringRoots(
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

function startWait(state: RootState, reason: SyncHostStorageWait["reason"], source: string, extra: Record<string, unknown> = {}): boolean {
  if (state.wait?.reason === reason) return false;
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
  return true;
}

function endWait(state: RootState, outcome: string): boolean {
  if (!state.wait) return false;
  const waitedMs = Date.now() - state.wait.sinceMs;
  const reason = state.wait.reason;
  state.wait = null;
  if (reason === "not_answering") {
    logger?.info("project_root.permission_wait_ended", { root: state.root, waitedMs, outcome });
  }
  logger?.info("project_root.recovered", { root: state.root, waitedMs, previous: reason });
  if (state.openCount === 0) roots.delete(state.root);
  return true;
}

/** Applies one verdict to every project folder on the drive, then tells listeners once. */
function settleVolume(volume: string, apply: (state: RootState) => boolean): void {
  let changed = false;
  for (const state of membersOf(volume)) changed = apply(state) || changed;
  if (changed) notify();
  if (membersOf(volume).length === 0) volumes.delete(volume);
}

function probe(volume: string): void {
  const members = membersOf(volume);
  const volumeState = volumes.get(volume);
  if (!volumeState || members.length === 0 || volumeState.probeInFlight) return;
  volumeState.probeInFlight = true;
  const startedAt = Date.now();
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    const waitedMs = Date.now() - startedAt;
    settleVolume(volume, (state) => startWait(state, "not_answering", "probe", { waitedMs }));
  }, PROJECT_ROOT_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  const finish = (error: NodeJS.ErrnoException | null): void => {
    settled = true;
    clearTimeout(timeout);
    volumeState.probeInFlight = false;
    const code = error?.code;
    if (code === "EPERM" || code === "EACCES") {
      settleVolume(volume, (state) => startWait(state, "denied", "probe", { code }));
      return;
    }
    if (volumeState.probePath) {
      // The file that hung answered (or is gone). The folder itself must
      // answer too before synchronous calls are let back in.
      volumeState.probePath = null;
      probe(volume);
      return;
    }
    // Anything else (gone, unmounted) is not a wait: nothing would freeze on it.
    settleVolume(volume, (state) => endWait(state, error ? `error:${code ?? "unknown"}` : "answered"));
  };
  const answered = volumeState.probePath
    ? fs.promises.open(volumeState.probePath, "r").then((handle) => handle.close())
    // Listed, not stat-ed: macOS gates reading a folder, and a listing is what
    // the per-program prompt holds. The first entry is enough.
    : fs.promises.opendir(members[0]!.root).then(async (dir) => {
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
 * busy. A drive with a marked folder keeps being probed until it answers.
 */
function needsProbe(volume: string): boolean {
  return isStallCapablePath(volume) || membersOf(volume).some((state) => state.wait !== null);
}

function ensureTimer(): void {
  if (timer || ![...volumes.keys()].some(needsProbe)) return;
  timer = setInterval(() => {
    let probed = false;
    for (const volume of [...volumes.keys()]) {
      if (!needsProbe(volume)) continue;
      probed = true;
      probe(volume);
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
    state = { root: key, volume: volumeOf(key), openCount: 0, wait: null };
    roots.set(key, state);
  }
  if (!volumes.has(state.volume)) volumes.set(state.volume, { probeInFlight: false, probePath: null });
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
  if (state.openCount > 0 || state.wait) return;
  roots.delete(state.root);
  if (membersOf(state.volume).length === 0) volumes.delete(state.volume);
}

/**
 * A folder found not answering by something other than the probe: a project
 * open that timed out, or the wedge the last brain died in (`path` is then the
 * file it hung on). Every project folder on that drive stays marked, and the
 * drive probed, until it answers.
 */
export function reportProjectRootNotAnswering(
  root: string,
  source: string,
  extra: Record<string, unknown> & { path?: string } = {},
): void {
  const state = stateFor(root);
  if (typeof extra.path === "string" && extra.path) volumes.get(state.volume)!.probePath = extra.path;
  settleVolume(state.volume, (member) => startWait(member, "not_answering", source, extra));
  ensureTimer();
  probe(state.volume);
}

/** The folder of {@link candidates} that contains `target`, or the target's own drive. */
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
  const volume = volumeOf(normalized);
  return volume === normalized ? path.dirname(normalized) : volume;
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
