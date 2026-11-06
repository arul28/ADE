import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExclusiveFileLockTimeoutError, withExclusiveFileLockSync } from "../../../../../ade-cli/src/lib/exclusiveFileLock";
import { deviceIdleMsFromEnv } from "../device/deviceMaintenance";
import { PROCESS_START_TIME_TOLERANCE_MS } from "../processes/processStartTime";
import { pathsEqual } from "../shared/pathCompare";
import { writeFileAtomic } from "../state/durableFile";
import { sameAvdName } from "./androidAvds";

/*
 * Who owns each emulator ADE started on this machine, in one file every
 * brain reads: the installed one, a dev brain and a test brain on a
 * throwaway ADE home alike. That is what lets an emulator outlive its brain
 * only as long as something is still going to use it. Each project's own
 * `started-emulators.json` (`androidEmulatorProcess.ts`) cannot: it lives
 * in one project on one ADE home, so an emulator a test brain handed off to
 * a "next brain" that never came ran on unseen. This file sees it, so:
 *
 * - an emulator whose brain is gone is adopted by a live brain on the same
 *   ADE home (a restart or an update), or stopped after a grace when no
 *   brain on that home can adopt it (a test or dev home never adopts); a
 *   pinned one on a home that adopts waits for its adopter however long;
 * - an emulator nobody used for `ANDROID_EMULATOR_IDLE_MS` is stopped,
 *   unless the person pinned it ("Keep running");
 * - an emulator with no record here is never stopped: it is the user's, or
 *   an older ADE's, and it is only counted against the memory guard.
 *
 * It lives under the user's default ADE home (`~/.ade/android`), never under
 * `ADE_HOME`: a brain on `/tmp/x` must find the same file as the installed
 * one. Writes are read-modify-write under a lock file, renamed into place.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** An unpinned emulator nobody used for this long is stopped. `ADE_ANDROID_IDLE_STOP_MINUTES` overrides; 0 turns it off. */
export const ANDROID_EMULATOR_IDLE_MS = 20 * 60_000;
/**
 * How long an emulator whose brain is gone waits to be adopted before it is
 * stopped. A brain on an ADE home that adopts (the installed app's) gets the
 * longer grace: its service restarts it after an update or a crash, with a
 * start-up backoff that can run to minutes. A throwaway home never adopts,
 * so its grace only covers a slow liveness read.
 */
export const ANDROID_OWNER_GONE_GRACE_MS = 2 * 60_000;
export const ANDROID_ADOPTABLE_OWNER_GONE_GRACE_MS = 10 * 60_000;
/** A record still without a qemu pid after this long is a start that died: boots end within the 180 s boot timeout. */
const BOOTING_RECORD_MAX_AGE_MS = 10 * 60_000;
/** A stop claimed by another brain that has not finished in this long is taken over. */
const STOP_CLAIM_MAX_AGE_MS = 2 * 60_000;
/** A boot reservation older than this is a start that never released it. */
const RESERVATION_MAX_AGE_MS = 10 * 60_000;

/** The idle limit, from `ADE_ANDROID_IDLE_STOP_MINUTES` when set; 0 = never. */
export function androidEmulatorIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  return deviceIdleMsFromEnv(env, "ADE_ANDROID_IDLE_STOP_MINUTES", ANDROID_EMULATOR_IDLE_MS);
}

/** The machine's owner file: under the user's default ADE home, whatever `ADE_HOME` says. */
export function machineAndroidEmulatorOwnersPath(home = os.homedir()): string {
  return path.join(home, ".ade", "android", "emulator-owners.json");
}

/** The brain that owns an emulator. */
export type AndroidEmulatorOwner = {
  brainPid: number;
  /** The OS start time of `brainPid` (POSIX), so a reused pid never passes for the brain. Null on Windows. */
  brainStartedAtMs: number | null;
  adeHome: string;
  /** A brain on this home adopts what another brain on it left (`isAdoptableAdeHome`, `machineLayout.ts`). */
  adoptable: boolean;
};

export type AndroidEmulatorStopReason =
  /** `ade android stop`, the pane's Power off. */
  | "user"
  /** `device-detach`, or a switch to another device. */
  | "released"
  /** The lane was archived or deleted, or a chat's work copy went. */
  | "lane_released"
  /** Nobody used it for `ANDROID_EMULATOR_IDLE_MS`. */
  | "idle"
  /** Its brain is gone and no brain on that ADE home adopted it. */
  | "owner_gone"
  /** ADE started it and no lane holds it (the service's start-up cleanup). */
  | "orphan"
  /** The project's service closed without handing it off. */
  | "project_closed";

export type AndroidEmulatorOwnerRecord = {
  avdName: string;
  consolePort: number;
  /** qemu's pid, once its discovery file showed up; null while booting. */
  pid: number | null;
  /** The OS start time of `pid` (POSIX), so a reused pid is never taken for it. */
  pidStartedAtMs: number | null;
  /** The process ADE spawned (`emulator`). On macOS and Linux it is qemu. */
  launcherPid: number;
  /** The adb that started it, so any brain can stop it without reading the SDK. */
  adbPath: string | null;
  owner: AndroidEmulatorOwner;
  laneId: string;
  projectRoot: string | null;
  chatSessionId: string | null;
  machineId: string | null;
  guestRamMb: number | null;
  /** What the memory guard counted for it at start. */
  costMb: number;
  startedAt: string;
  lastUsedAt: string;
  /** "Keep running": the idle stop leaves it alone. */
  pinned: boolean;
  /** When a sweep first found the owner brain gone; cleared when a brain adopts it. */
  ownerGoneAt: string | null;
  /** A brain is stopping it now, so a second brain does not (`canClaimStop`). */
  stopping: { brainPid: number; at: string } | null;
};

/** A boot that passed the memory guard and has not taken its memory yet. */
export type AndroidBootReservationRecord = { id: string; pid: number; mb: number; at: string };

/** What an AVD's emulator measured beyond its guest RAM, once warm. */
export type AndroidAvdOverheadRecord = { overheadMb: number; guestRamMb: number; measuredAt: string };

export type AndroidEmulatorOwnersData = {
  version: 1;
  emulators: AndroidEmulatorOwnerRecord[];
  reservations: AndroidBootReservationRecord[];
  /** By lower-cased AVD name. */
  overheadByAvd: Record<string, AndroidAvdOverheadRecord>;
};

function emptyData(): AndroidEmulatorOwnersData {
  return { version: 1, emulators: [], reservations: [], overheadByAvd: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOwnerRecord(value: unknown): value is AndroidEmulatorOwnerRecord {
  if (!isRecord(value) || !isRecord(value.owner)) return false;
  return typeof value.avdName === "string"
    && typeof value.consolePort === "number"
    && typeof value.launcherPid === "number"
    && typeof value.laneId === "string"
    && typeof value.lastUsedAt === "string"
    && typeof value.owner.brainPid === "number"
    && typeof value.owner.adeHome === "string";
}

/** Parses the file; anything unreadable is dropped, never thrown. */
export function parseAndroidEmulatorOwners(text: string): AndroidEmulatorOwnersData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyData();
  }
  if (!isRecord(parsed)) return emptyData();
  const overheadByAvd: Record<string, AndroidAvdOverheadRecord> = {};
  if (isRecord(parsed.overheadByAvd)) {
    for (const [key, value] of Object.entries(parsed.overheadByAvd)) {
      if (isRecord(value) && typeof value.overheadMb === "number" && typeof value.guestRamMb === "number") {
        overheadByAvd[key] = { overheadMb: value.overheadMb, guestRamMb: value.guestRamMb, measuredAt: String(value.measuredAt ?? "") };
      }
    }
  }
  return {
    version: 1,
    emulators: Array.isArray(parsed.emulators)
      ? parsed.emulators.filter(isOwnerRecord).map((record) => ({
        ...record,
        pid: typeof record.pid === "number" ? record.pid : null,
        pidStartedAtMs: typeof record.pidStartedAtMs === "number" ? record.pidStartedAtMs : null,
        pinned: record.pinned === true,
        ownerGoneAt: typeof record.ownerGoneAt === "string" ? record.ownerGoneAt : null,
        stopping: isRecord(record.stopping) && typeof record.stopping.brainPid === "number" ? record.stopping : null,
      }))
      : [],
    reservations: Array.isArray(parsed.reservations)
      ? parsed.reservations.filter((entry): entry is AndroidBootReservationRecord =>
        isRecord(entry) && typeof entry.id === "string" && typeof entry.pid === "number" && typeof entry.mb === "number")
      : [],
    overheadByAvd,
  };
}

/** One emulator: the same AVD on the same console port. */
export function isSameEmulator(
  record: Pick<AndroidEmulatorOwnerRecord, "avdName" | "consolePort">,
  other: { avdName: string; consolePort: number },
): boolean {
  return record.consolePort === other.consolePort && sameAvdName(record.avdName, other.avdName);
}

/**
 * The machine's owner file. Reads are plain file reads; every write is a
 * read-modify-write under `<file>.lock`, so two brains never lose each
 * other's records.
 */
export class AndroidEmulatorOwnersStore {
  constructor(
    readonly filePath: string,
    /** A read, write or lock failed. A missing file is not a failure. */
    private readonly onError?: (op: "read" | "write" | "lock", error: unknown) => void,
  ) {}

  read(): AndroidEmulatorOwnersData {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.onError?.("read", error);
      return emptyData();
    }
    return parseAndroidEmulatorOwners(text);
  }

  /**
   * Runs `mutate` on the current data and writes it back when it returns
   * anything but `false`. Null when the lock or the write failed; the caller
   * goes on as if nothing was recorded.
   */
  update<T>(mutate: (data: AndroidEmulatorOwnersData) => T): T | null {
    try {
      return withExclusiveFileLockSync(`${this.filePath}.lock`, () => {
        const data = this.read();
        const result = mutate(data);
        if (result !== false) {
          fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
          writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
        }
        return result;
      }, { waitMs: 2_000, label: "the Android emulator owner file", staleAfterMs: 30_000 });
    } catch (error) {
      this.onError?.(error instanceof ExclusiveFileLockTimeoutError ? "lock" : "write", error);
      return null;
    }
  }
}

/* ---------- the sweep's decision, pure ---------- */

export type AndroidEmulatorProcessState =
  /** Its discovery file names the same AVD, port and pid, and the pid is the same process. */
  | "running"
  /**
   * Its pid still runs, but this brain cannot see its discovery file (a
   * brain with another HOME started it). Never stopped from here: without
   * the file, `adb -s emulator-<port>` might reach another emulator.
   */
  | "unverified"
  /** No qemu pid yet, and the launcher still runs. */
  | "booting"
  /** Exited, crashed, or the pid now belongs to another process. */
  | "gone";

export type AndroidSweepFacts = {
  nowMs: number;
  emulator: AndroidEmulatorProcessState;
  /** The owner brain still runs (its pid, and its start time when both are known). */
  ownerAlive: boolean;
  /** This record's owner is the brain running the sweep. */
  ownedBySelf: boolean;
  /** This brain's ADE home, and whether it adopts. */
  self: { adeHome: string; adoptable: boolean };
  /**
   * For a record this brain owns: whether its service uses the emulator now
   * (a stream, a recording, a lease, a call in flight). Null when no service
   * of this brain has the project open.
   */
  busyHere: boolean | null;
  idleMs: number;
};

export type AndroidSweepVerdict =
  | { kind: "keep"; why: "pinned" | "recent" | "booting" | "unverified" | "other_brain" | "stopping_elsewhere" | "grace" | "idle_stop_off" }
  | { kind: "touch" }
  | { kind: "adopt" }
  | { kind: "owner_back" }
  | { kind: "mark_owner_gone" }
  | { kind: "stop"; reason: "idle" | "owner_gone" }
  | { kind: "prune" };

function msSince(iso: string | null, nowMs: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
}

/** Same ADE home, compared as the OS compares paths. */
export function sameAdeHome(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathsEqual(path.resolve(a), path.resolve(b), platform);
}

/**
 * What one sweep does with one record. Never a stop for an emulator that is
 * gone (the record is dropped instead) or one another live brain owns.
 */
export function decideAndroidEmulatorSweep(record: AndroidEmulatorOwnerRecord, facts: AndroidSweepFacts): AndroidSweepVerdict {
  if (facts.emulator === "gone") return { kind: "prune" };
  if (facts.emulator === "unverified") return { kind: "keep", why: "unverified" };
  if (record.stopping && msSince(record.stopping.at, facts.nowMs) < STOP_CLAIM_MAX_AGE_MS) {
    return { kind: "keep", why: "stopping_elsewhere" };
  }
  if (facts.ownedBySelf) {
    if (facts.busyHere === true) return { kind: "touch" };
    if (facts.emulator === "booting") return { kind: "keep", why: "booting" };
    if (record.pinned) return { kind: "keep", why: "pinned" };
    if (facts.idleMs <= 0) return { kind: "keep", why: "idle_stop_off" };
    return msSince(record.lastUsedAt, facts.nowMs) >= facts.idleMs
      ? { kind: "stop", reason: "idle" }
      : { kind: "keep", why: "recent" };
  }
  if (facts.ownerAlive) return record.ownerGoneAt ? { kind: "owner_back" } : { kind: "keep", why: "other_brain" };
  // The owner brain is gone. A brain on its home that adopts takes it over.
  if (facts.self.adoptable && sameAdeHome(record.owner.adeHome, facts.self.adeHome)) return { kind: "adopt" };
  if (!record.ownerGoneAt) return { kind: "mark_owner_gone" };
  // The person asked to keep it, and a brain on its home will come back for it.
  if (record.pinned && record.owner.adoptable) return { kind: "keep", why: "pinned" };
  const grace = record.owner.adoptable ? ANDROID_ADOPTABLE_OWNER_GONE_GRACE_MS : ANDROID_OWNER_GONE_GRACE_MS;
  return msSince(record.ownerGoneAt, facts.nowMs) >= grace ? { kind: "stop", reason: "owner_gone" } : { kind: "keep", why: "grace" };
}

/** Whether a record's process facts still describe it: same pid, same start time when both are known. */
export function sameStartTime(recorded: number | null, actual: number | null | undefined): boolean {
  if (recorded == null || actual == null) return true;
  return Math.abs(actual - recorded) <= PROCESS_START_TIME_TOLERANCE_MS;
}

/**
 * Whether `self` may take the stop of this record now: nobody claimed it,
 * the claim carries this brain's pid, its claimer is gone, or the claim is
 * older than `STOP_CLAIM_MAX_AGE_MS`.
 */
export function canClaimStop(
  record: Pick<AndroidEmulatorOwnerRecord, "stopping">,
  self: Pick<AndroidEmulatorOwner, "brainPid">,
  nowMs: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  const claim = record.stopping;
  if (!claim) return true;
  // This brain's own claim, or (another start time) a dead brain's whose pid
  // this one now holds: either way no other live brain is stopping it.
  if (claim.brainPid === self.brainPid) return true;
  if (msSince(claim.at, nowMs) >= STOP_CLAIM_MAX_AGE_MS) return true;
  return !isPidAlive(claim.brainPid);
}

/** A record without a qemu pid that is too old to still be booting. */
export function isDeadBootingRecord(record: Pick<AndroidEmulatorOwnerRecord, "pid" | "startedAt">, nowMs: number): boolean {
  return record.pid === null && msSince(record.startedAt, nowMs) > BOOTING_RECORD_MAX_AGE_MS;
}

/** Reservations still standing: their process lives and they are not stale. */
export function liveReservations(
  reservations: readonly AndroidBootReservationRecord[],
  nowMs: number,
  isPidAlive: (pid: number) => boolean,
): AndroidBootReservationRecord[] {
  return reservations.filter((entry) => msSince(entry.at, nowMs) <= RESERVATION_MAX_AGE_MS && isPidAlive(entry.pid));
}
