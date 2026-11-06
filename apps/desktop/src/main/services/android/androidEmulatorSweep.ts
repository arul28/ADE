import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { createPerKeyThrottle, startDeviceMaintenanceTimers } from "../device/deviceMaintenance";
import type { ProcessMemory } from "../machineStats/hostMemorySignals";
import { readProcessStartTimesMs } from "../processes/processStartTime";
import { sameAvdName } from "./androidAvds";
import {
  androidDiscoveryDirs,
  isProcessAlive,
  readAndroidDiscoveryFiles,
  stopAndroidEmulator,
  type AndroidDiscoveredEmulator,
} from "./androidEmulatorProcess";
import { isAndroidEmulatorImage, readWindowsProcessImages } from "./androidEmulatorImage";
import {
  androidEmulatorIdleMs,
  canClaimStop,
  decideAndroidEmulatorSweep,
  isDeadBootingRecord,
  isSameEmulator,
  liveReservations,
  sameAdeHome,
  sameStartTime,
  type AndroidEmulatorOwner,
  type AndroidEmulatorOwnerRecord,
  type AndroidEmulatorOwnersStore,
  type AndroidEmulatorProcessState,
  type AndroidEmulatorStopReason,
  type AndroidSweepFacts,
  type AndroidSweepVerdict,
} from "./androidEmulatorOwners";
import type { AndroidMemoryLedger } from "./androidMemoryGuard";

/*
 * The emulator lifecycle of one brain process, shared by every project's
 * Android service in it: the owner records it writes for the emulators it
 * starts, the "last used" clock, the pin, the boot reservations the memory
 * guard counts across brains, and the sweep.
 *
 * The sweep runs shortly after the first service registers and then every
 * `ANDROID_SWEEP_EVERY_MS`, on unref'd timers (the Apple devices' upkeep
 * shares them, `device/deviceMaintenance.ts`). One sweep reads the owner
 * file and the emulators' discovery folders, and only when there are records
 * runs one `ps` for the start times of the pids it checks (on Windows, which
 * has none, one `tasklist`: a discovery pid counts only while its image is an
 * emulator's). Then, record by record (`decideAndroidEmulatorSweep`):
 *
 * - an emulator this brain owns that its service is using is touched; one
 *   unused for the idle limit and not pinned is stopped, through its
 *   service's lane queue when the project is open here;
 * - an emulator whose brain is gone is adopted by this brain when both sit
 *   on the same ADE home that adopts, else stopped once its grace runs out;
 * - a record whose emulator is gone is dropped.
 *
 * An emulator with no record is never stopped, and nothing is stopped
 * unless its discovery file still names the recorded AVD, port and pid, and
 * the record, read again as the stop is claimed, still decides a stop.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** How often a brain sweeps. A quarter of the idle limit, so an idle emulator stops within 25 minutes. */
export const ANDROID_SWEEP_EVERY_MS = 5 * 60_000;
/** The first sweep after a service registers: soon, so a restarted brain adopts what its last run handed off. */
const ANDROID_SWEEP_FIRST_MS = 30_000;
/** "Last used" is written to the file at most this often per emulator. */
const TOUCH_WRITE_EVERY_MS = 60_000;
/** An overhead is learned only from an emulator that ran this long: a fresh boot has not touched most of its memory. */
const OVERHEAD_LEARN_AFTER_MS = 5 * 60_000;

export type AndroidIdleStopAnswer =
  /** The service stopped it. */
  | "stopped"
  /** The service is using it after all (a call arrived since the sweep looked). */
  | "busy"
  /** The project's lanes do not hold this emulator any more: the sweep stops it itself. */
  | "not_found"
  /** Its record changed since the sweep looked (pinned now): left alone. */
  | "kept";

/** One project's Android service, as the sweep sees it. */
export type AndroidEmulatorLifecycleParticipant = {
  projectRoot: string | null;
  /** The lane's emulator is in use here now: a stream, a recording, a lease, a boot or a call in flight. */
  isBusy: (laneId: string) => boolean;
  /** Stops an idle emulator through the service's own lane queue, after checking it is still idle. */
  stopIdle: (record: AndroidEmulatorOwnerRecord, idleMs: number) => Promise<AndroidIdleStopAnswer>;
  /** One coarse product fact per automatic stop (`emulator_auto_stopped`). */
  onAutoStopped?: () => void;
  /** Where the lifecycle logs while this service is the newest one (a brain logs per project). */
  logger?: Logger | null;
};

export type AndroidSweepReportEntry = {
  avdName: string;
  consolePort: number;
  pid: number | null;
  laneId: string;
  projectRoot: string | null;
  owner: { brainPid: number; adeHome: string; self: boolean; alive: boolean };
  emulator: AndroidEmulatorProcessState;
  pinned: boolean;
  idleMinutes: number | null;
  verdict: AndroidSweepVerdict;
  /** What the sweep did about a stop: left alone in a dry run, stopped, or failed. */
  outcome: "dry_run" | "stopped" | "busy" | "failed" | null;
};

export type AndroidSweepReport = {
  at: string;
  dryRun: boolean;
  durationMs: number;
  /** Processes the sweep started (the `ps` for start times). */
  spawned: number;
  records: AndroidSweepReportEntry[];
  /** Running emulators with no ADE record: listed, counted by the memory guard, never stopped. */
  foreign: Array<{ avdName: string; serial: string; pid: number }>;
};

export type AndroidEmulatorLifecycleConfig = {
  store: AndroidEmulatorOwnersStore;
  self: AndroidEmulatorOwner;
  machineId?: () => string | null;
  logger?: Logger | null;
  discoveryDirs?: readonly string[];
  idleMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  readStartTimes?: (pids: readonly number[]) => Promise<Map<number, number>>;
  /** Windows: the image name by pid (`tasklist`); null when it could not be read. */
  readProcessImages?: (pids: readonly number[]) => Promise<Map<number, string> | null>;
  isPidAlive?: (pid: number) => boolean;
  /** Stops one emulator the sweep verified, with no service (`stopAndroidEmulator` by default). */
  stopEmulator?: (record: AndroidEmulatorOwnerRecord, emulator: AndroidDiscoveredEmulator) => Promise<unknown>;
};

export type AndroidEmulatorLifecycle = ReturnType<typeof createAndroidEmulatorLifecycle>;

function samePath(a: string | null, b: string | null, platform: NodeJS.Platform): boolean {
  if (!a || !b) return a === b;
  return sameAdeHome(a, b, platform);
}

export function createAndroidEmulatorLifecycle(config: AndroidEmulatorLifecycleConfig) {
  const now = config.now ?? Date.now;
  const platform = config.platform ?? process.platform;
  const idleMs = config.idleMs ?? androidEmulatorIdleMs();
  const discoveryDirs = () => config.discoveryDirs ?? androidDiscoveryDirs(platform);
  const isPidAlive = config.isPidAlive ?? isProcessAlive;
  const readStartTimes = config.readStartTimes ?? ((pids: readonly number[]) => readProcessStartTimesMs(pids, platform));
  const readProcessImages = config.readProcessImages ?? readWindowsProcessImages;
  const participants = new Set<AndroidEmulatorLifecycleParticipant>();
  /** The configured logger, else the newest service's: the lifecycle outlives any one project. */
  const log = (): Logger | null => config.logger ?? [...participants].reverse().find((entry) => entry.logger)?.logger ?? null;
  const touchThrottle = createPerKeyThrottle(TOUCH_WRITE_EVERY_MS, now);
  /** Unthrottled "last used" of this process, by lower-cased AVD name, for the idle re-check. */
  const lastTouchMs = new Map<string, number>();
  let stopTimers: (() => void) | null = null;
  let sweeping: Promise<AndroidSweepReport> | null = null;

  const iso = () => new Date(now()).toISOString();
  const isSelf = (owner: AndroidEmulatorOwner) =>
    owner.brainPid === config.self.brainPid && sameStartTime(owner.brainStartedAtMs, config.self.brainStartedAtMs);

  const participantFor = (projectRoot: string | null) =>
    [...participants].find((participant) => samePath(participant.projectRoot, projectRoot, platform)) ?? null;

  /* ---------- records ---------- */

  /**
   * An emulator this brain launched: it owns it from now on. `pid` is set
   * for an emulator ADE started before this file existed (the project's
   * `started-emulators.json` says it is ADE's), taken in as it runs.
   */
  const recordLaunch = (args: {
    avdName: string;
    consolePort: number;
    launcherPid: number;
    pid?: number | null;
    adbPath: string | null;
    laneId: string;
    projectRoot: string | null;
    chatSessionId: string | null;
    guestRamMb: number | null;
    costMb: number;
  }): void => {
    const at = iso();
    config.store.update((data) => {
      data.emulators = data.emulators.filter((record) => !isSameEmulator(record, args));
      data.emulators.push({
        avdName: args.avdName,
        consolePort: args.consolePort,
        pid: args.pid ?? null,
        pidStartedAtMs: null,
        launcherPid: args.launcherPid,
        adbPath: args.adbPath,
        owner: config.self,
        laneId: args.laneId,
        projectRoot: args.projectRoot,
        chatSessionId: args.chatSessionId,
        machineId: config.machineId?.() ?? null,
        guestRamMb: args.guestRamMb,
        costMb: args.costMb,
        startedAt: at,
        lastUsedAt: at,
        pinned: false,
        ownerGoneAt: null,
        stopping: null,
      });
    });
    lastTouchMs.set(args.avdName.toLowerCase(), now());
  };

  /** The boot found qemu's pid. */
  const recordBooted = async (args: { avdName: string; consolePort: number; pid: number }): Promise<void> => {
    const startedAt = (await readStartTimes([args.pid])).get(args.pid) ?? null;
    config.store.update((data) => {
      const record = data.emulators.find((entry) => isSameEmulator(entry, args));
      if (!record) return false;
      record.pid = args.pid;
      record.pidStartedAtMs = startedAt;
      return true;
    });
  };

  /**
   * An emulator ADE started stopped (or exited): its record goes, and the
   * stop is logged once with its reason. A stop that ended no record (an
   * emulator from before this file) is still logged.
   */
  const noteStopped = (args: {
    avdName: string;
    consolePort: number;
    reason: AndroidEmulatorStopReason;
    laneId?: string | null;
    /** The record as the caller read it, for the log when the file no longer has it. */
    known?: AndroidEmulatorOwnerRecord | null;
  }): void => {
    let removed: AndroidEmulatorOwnerRecord | null = null;
    config.store.update((data) => {
      const before = data.emulators.length;
      data.emulators = data.emulators.filter((record) => {
        if (!isSameEmulator(record, args)) return true;
        removed = record;
        return false;
      });
      return data.emulators.length !== before;
    });
    lastTouchMs.delete(args.avdName.toLowerCase());
    touchThrottle.forget(args.avdName.toLowerCase());
    const record = (removed as AndroidEmulatorOwnerRecord | null) ?? args.known ?? null;
    const minutesSince = (value: string | null | undefined) => {
      const at = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(at) ? Math.round((now() - at) / 60_000) : null;
    };
    log()?.info("android.emulator_stopped", {
      reason: args.reason,
      avdName: args.avdName,
      consolePort: args.consolePort,
      laneId: args.laneId ?? record?.laneId ?? null,
      ranMinutes: minutesSince(record?.startedAt),
      idleMinutes: minutesSince(record?.lastUsedAt),
      pinned: record?.pinned ?? null,
      ownerPid: record?.owner.brainPid ?? null,
    });
    if (args.reason === "idle" || args.reason === "owner_gone") {
      const participant = participantFor(record?.projectRoot ?? null) ?? [...participants].find((entry) => entry.onAutoStopped) ?? null;
      participant?.onAutoStopped?.();
    }
  };

  /** A launch that never became a running emulator (a failed or cancelled boot): its record goes, unlogged. */
  const forget = (args: { avdName: string; consolePort: number }): void => {
    config.store.update((data) => {
      const before = data.emulators.length;
      data.emulators = data.emulators.filter((record) => !isSameEmulator(record, args));
      return data.emulators.length !== before;
    });
    lastTouchMs.delete(args.avdName.toLowerCase());
  };

  /** Something used the AVD's emulator now. Cheap: the file is written at most once a minute. */
  const touch = (avdName: string): void => {
    const key = avdName.toLowerCase();
    lastTouchMs.set(key, now());
    if (!touchThrottle.take(key)) return;
    const at = iso();
    config.store.update((data) => {
      const record = data.emulators.find((entry) => sameAvdName(entry.avdName, avdName));
      if (!record) return false;
      record.lastUsedAt = at;
      return true;
    });
  };

  /** When this process last saw the AVD used, or null. */
  const lastUsedHereMs = (avdName: string): number | null => lastTouchMs.get(avdName.toLowerCase()) ?? null;

  const recordFor = (avdName: string): AndroidEmulatorOwnerRecord | null =>
    config.store.read().emulators.find((record) => sameAvdName(record.avdName, avdName)) ?? null;

  /** "Keep running" on or off. False when ADE has no record of that emulator. */
  const setPinned = (avdName: string, pinned: boolean): boolean => {
    const at = iso();
    return config.store.update((data) => {
      const record = data.emulators.find((entry) => sameAvdName(entry.avdName, avdName));
      if (!record) return false;
      record.pinned = pinned;
      // Turning the pin off starts the idle clock from now, not from before the pin.
      if (!pinned) record.lastUsedAt = at;
      return true;
    }) === true;
  };

  /* ---------- the memory guard's ledger ---------- */

  const ledger: AndroidMemoryLedger = {
    overheadFor(avdName) {
      const byAvd = config.store.read().overheadByAvd;
      const values = Object.values(byAvd).map((entry) => entry.overheadMb).filter((mb) => mb > 0);
      return { avdMb: byAvd[avdName.toLowerCase()]?.overheadMb ?? null, machineMb: values.length ? Math.max(...values) : null };
    },
    reserve(mb) {
      const id = randomUUID();
      const at = iso();
      config.store.update((data) => {
        data.reservations = liveReservations(data.reservations, now(), isPidAlive);
        data.reservations.push({ id, pid: process.pid, mb, at });
      });
      return {
        earlierMb: () => {
          // This process's own boots are counted in memory (`bootsInFlight`); only other brains' come from here.
          const others = liveReservations(config.store.read().reservations, now(), isPidAlive)
            .filter((entry) => entry.pid !== process.pid && (entry.at < at || (entry.at === at && entry.id < id)));
          return { mb: others.reduce((sum, entry) => sum + entry.mb, 0), count: others.length };
        },
        release: () => {
          config.store.update((data) => {
            const before = data.reservations.length;
            data.reservations = data.reservations.filter((entry) => entry.id !== id);
            return data.reservations.length !== before;
          });
        },
      };
    },
    observe(emulators: readonly ProcessMemory[]) {
      const at = iso();
      config.store.update((data) => {
        let learned = false;
        for (const emulator of emulators) {
          const record = data.emulators.find((entry) => entry.pid === emulator.pid);
          if (!record || record.guestRamMb == null) continue;
          if (now() - Date.parse(record.startedAt) < OVERHEAD_LEARN_AFTER_MS) continue;
          const overheadMb = emulator.mb - record.guestRamMb;
          if (overheadMb <= 0) continue;
          data.overheadByAvd[record.avdName.toLowerCase()] = { overheadMb, guestRamMb: record.guestRamMb, measuredAt: at };
          learned = true;
        }
        return learned;
      });
    },
  };

  /* ---------- the sweep ---------- */

  const defaultStop = (record: AndroidEmulatorOwnerRecord, emulator: AndroidDiscoveredEmulator) => {
    const adbPath = record.adbPath && fs.existsSync(record.adbPath) ? record.adbPath : null;
    return stopAndroidEmulator({
      adbPath: adbPath ?? "adb",
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      avdName: emulator.avdName,
      pid: emulator.pid,
      launcherPid: record.launcherPid,
      // Without the adb that started it, `emu kill` cannot be sent: go
      // straight to the verified kill.
      ...(adbPath ? {} : { timeoutMs: 1_000 }),
      discoveryDirs: discoveryDirs(),
    });
  };
  const stopEmulator = config.stopEmulator ?? defaultStop;

  /**
   * Takes the stop of one record, unless another brain is already on it or
   * the record as it stands now no longer decides this stop: the person
   * pinned it, a brain adopted it or came back, or it was used, since the
   * sweep read the file.
   */
  const claimStop = (record: AndroidEmulatorOwnerRecord, facts: AndroidSweepFacts, reason: AndroidEmulatorStopReason): boolean =>
    config.store.update((data) => {
      const current = data.emulators.find((entry) => isSameEmulator(entry, record));
      if (!current || !canClaimStop(current, config.self, now(), isPidAlive)) return false;
      const self = isSelf(current.owner);
      const participant = self ? participantFor(current.projectRoot) : null;
      const verdict = decideAndroidEmulatorSweep({ ...current, stopping: null }, {
        ...facts,
        nowMs: now(),
        ownedBySelf: self,
        // Same owner: what the sweep read. Another owner: alive while its pid is.
        ownerAlive: self || (current.owner.brainPid === record.owner.brainPid ? facts.ownerAlive : isPidAlive(current.owner.brainPid)),
        busyHere: participant ? participant.isBusy(current.laneId) : null,
      });
      if (verdict.kind !== "stop" || verdict.reason !== reason) return false;
      current.stopping = { brainPid: config.self.brainPid, at: iso() };
      return true;
    }) === true;

  const releaseClaim = (record: AndroidEmulatorOwnerRecord): void => {
    config.store.update((data) => {
      const current = data.emulators.find((entry) => isSameEmulator(entry, record));
      if (!current?.stopping) return false;
      current.stopping = null;
      return true;
    });
  };

  const runSweep = async (options: { dryRun: boolean }): Promise<AndroidSweepReport> => {
    const started = now();
    const data = config.store.read();
    let running = readAndroidDiscoveryFiles(discoveryDirs());
    const report: AndroidSweepReport = {
      at: new Date(started).toISOString(),
      dryRun: options.dryRun,
      durationMs: 0,
      spawned: 0,
      records: [],
      foreign: [],
    };
    const claimed = new Set<number>();
    const finish = () => {
      report.foreign = running
        .filter((emulator) => !claimed.has(emulator.pid))
        .map((emulator) => ({ avdName: emulator.avdName, serial: emulator.serial, pid: emulator.pid }));
      report.durationMs = now() - started;
      return report;
    };
    if (data.emulators.length === 0) return finish();

    // One `ps` for every start time this sweep compares (none on Windows).
    const pids = new Set<number>();
    for (const record of data.emulators) {
      if (record.pid !== null) pids.add(record.pid);
      if (record.owner.brainPid !== config.self.brainPid) pids.add(record.owner.brainPid);
    }
    if (platform !== "win32" && pids.size > 0) report.spawned += 1;
    const startTimes = await readStartTimes([...pids]);
    // Windows has no start times, and a crashed emulator's discovery file
    // stays: once its pid belongs to another program, the file still names
    // it. There a pid is the emulator only while its image is an emulator's;
    // with no image list, nothing is verified and nothing is stopped.
    let imagesUnread = false;
    if (platform === "win32" && running.length > 0) {
      report.spawned += 1;
      const images = await readProcessImages(running.map((entry) => entry.pid));
      imagesUnread = images === null;
      running = images ? running.filter((entry) => isAndroidEmulatorImage(images.get(entry.pid))) : running;
    }

    type Planned = {
      record: AndroidEmulatorOwnerRecord;
      facts: AndroidSweepFacts;
      verdict: AndroidSweepVerdict;
      emulator: AndroidDiscoveredEmulator | null;
      entry: AndroidSweepReportEntry;
    };
    const planned: Planned[] = [];
    for (const record of data.emulators) {
      let emulator: AndroidDiscoveredEmulator | null = null;
      let state: AndroidEmulatorProcessState;
      if (record.pid !== null) {
        emulator = running.find((entry) => isSameEmulator(record, entry) && entry.pid === record.pid) ?? null;
        const sameProcess = sameStartTime(record.pidStartedAtMs, startTimes.get(record.pid));
        if (emulator && imagesUnread) state = "unverified";
        else if (emulator && sameProcess) state = "running";
        else if (!emulator && isPidAlive(record.pid) && sameProcess && record.pidStartedAtMs !== null) state = "unverified";
        else state = "gone";
        if (state !== "running") emulator = null;
      } else if (isDeadBootingRecord(record, started)) {
        state = "gone";
      } else {
        // A boot handed off before it pinned qemu's pid: its discovery file
        // claims it only while its launcher still runs (a stale record must
        // never claim the user's emulator on the same default port).
        const launcherAlive = isPidAlive(record.launcherPid);
        emulator = launcherAlive ? running.find((entry) => isSameEmulator(record, entry)) ?? null : null;
        state = emulator ? (imagesUnread ? "unverified" : "running") : launcherAlive ? "booting" : "gone";
        if (state !== "running") emulator = null;
      }
      if (emulator) claimed.add(emulator.pid);
      const self = isSelf(record.owner);
      const ownerAlive = self || (isPidAlive(record.owner.brainPid)
        && sameStartTime(record.owner.brainStartedAtMs, startTimes.get(record.owner.brainPid)));
      const participant = self ? participantFor(record.projectRoot) : null;
      const facts: AndroidSweepFacts = {
        nowMs: started,
        emulator: state,
        ownerAlive,
        ownedBySelf: self,
        self: { adeHome: config.self.adeHome, adoptable: config.self.adoptable },
        busyHere: participant ? participant.isBusy(record.laneId) : null,
        idleMs,
      };
      const verdict = decideAndroidEmulatorSweep(record, facts);
      const lastUsed = Date.parse(record.lastUsedAt);
      planned.push({
        record,
        facts,
        verdict,
        emulator,
        entry: {
          avdName: record.avdName,
          consolePort: record.consolePort,
          pid: record.pid ?? emulator?.pid ?? null,
          laneId: record.laneId,
          projectRoot: record.projectRoot,
          owner: { brainPid: record.owner.brainPid, adeHome: record.owner.adeHome, self, alive: ownerAlive },
          emulator: state,
          pinned: record.pinned,
          idleMinutes: Number.isFinite(lastUsed) ? Math.round((started - lastUsed) / 60_000) : null,
          verdict,
          outcome: null,
        },
      });
    }
    report.records = planned.map((item) => item.entry);
    if (options.dryRun) {
      for (const item of planned) if (item.verdict.kind === "stop") item.entry.outcome = "dry_run";
      return finish();
    }

    // The bookkeeping, in one write.
    const at = new Date(started).toISOString();
    const bookkeeping = planned.filter((item) => item.verdict.kind !== "keep" && item.verdict.kind !== "stop");
    if (bookkeeping.length > 0) {
      config.store.update((current) => {
        for (const item of bookkeeping) {
          const index = current.emulators.findIndex((entry) => isSameEmulator(entry, item.record));
          if (index < 0) continue;
          const record = current.emulators[index]!;
          switch (item.verdict.kind) {
            case "prune":
              current.emulators.splice(index, 1);
              log()?.info("android.emulator_record_pruned", { avdName: record.avdName, consolePort: record.consolePort, laneId: record.laneId });
              break;
            case "touch":
              record.lastUsedAt = at;
              break;
            case "adopt":
              log()?.info("android.emulator_adopted", {
                avdName: record.avdName,
                laneId: record.laneId,
                fromPid: record.owner.brainPid,
                adeHome: record.owner.adeHome,
              });
              record.owner = config.self;
              record.ownerGoneAt = null;
              break;
            case "owner_back":
              record.ownerGoneAt = null;
              break;
            case "mark_owner_gone":
              record.ownerGoneAt = at;
              break;
          }
          // A pid-less record whose boot finished: pin it to its qemu now.
          if (record.pid === null && item.emulator) record.pid = item.emulator.pid;
        }
      });
    }

    for (const item of planned) {
      if (item.verdict.kind !== "stop" || !item.emulator) continue;
      const reason = item.verdict.reason;
      if (reason === "idle") {
        const participant = participantFor(item.record.projectRoot);
        if (participant) {
          const answer = await participant.stopIdle(item.record, idleMs).catch((error: unknown) => {
            log()?.warn("android.idle_stop_failed", { avdName: item.record.avdName, error: getErrorMessage(error) });
            return "failed" as const;
          });
          if (answer === "kept") continue;
          if (answer === "stopped" || answer === "busy" || answer === "failed") {
            item.entry.outcome = answer;
            if (answer === "busy") touch(item.record.avdName);
            continue;
          }
        }
      }
      if (!claimStop(item.record, item.facts, reason)) continue;
      try {
        await stopEmulator(item.record, item.emulator);
        noteStopped({ avdName: item.record.avdName, consolePort: item.record.consolePort, reason, laneId: item.record.laneId, known: item.record });
        item.entry.outcome = "stopped";
      } catch (error) {
        releaseClaim(item.record);
        item.entry.outcome = "failed";
        log()?.warn("android.sweep_stop_failed", { avdName: item.record.avdName, reason, error: getErrorMessage(error) });
      }
    }
    return finish();
  };

  /** One sweep; a second caller shares the one in flight. `dryRun` decides and reports, and changes nothing. */
  const sweep = (options: { dryRun?: boolean } = {}): Promise<AndroidSweepReport> => {
    if (options.dryRun) return runSweep({ dryRun: true });
    sweeping ??= runSweep({ dryRun: false }).finally(() => {
      sweeping = null;
    });
    return sweeping;
  };

  /** A project's service joins; the first one starts the sweep. The answer leaves. */
  const register = (participant: AndroidEmulatorLifecycleParticipant): (() => void) => {
    participants.add(participant);
    if (!stopTimers) {
      stopTimers = startDeviceMaintenanceTimers(
        [{ firstMs: ANDROID_SWEEP_FIRST_MS, everyMs: ANDROID_SWEEP_EVERY_MS, run: () => sweep() }],
        (error) => log()?.warn("android.sweep_failed", { error: getErrorMessage(error) }),
      );
    }
    return () => {
      participants.delete(participant);
      if (participants.size === 0) {
        stopTimers?.();
        stopTimers = null;
      }
    };
  };

  return {
    self: config.self,
    idleMs,
    recordLaunch,
    recordBooted,
    noteStopped,
    forget,
    touch,
    lastUsedHereMs,
    recordFor,
    setPinned,
    ledger,
    sweep,
    register,
    ownersFile: path.resolve(config.store.filePath),
  };
}
