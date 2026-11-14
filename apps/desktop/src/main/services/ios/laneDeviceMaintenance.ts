import fs from "node:fs";
import path from "node:path";
import type { AppleDeviceCleanupResult, AppleLaneDevice } from "../../../shared/types/iosSimulator";
import { APPLE_DEVICE_CLEANUP_INTERVAL_MS, isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import { appleDeviceDataRoot, parseSimctlDevices } from "./appleSimulatorCatalog";
import type { LaneDeviceRegistry } from "./laneDeviceRegistry";
import { createPerKeyThrottle, deviceIdleMsFromEnv, startDeviceMaintenanceTimers } from "../device/deviceMaintenance";
import {
  externalToolUsesDevice,
  simulatorAppRunning,
  simulatorReclaimFactsPhrase,
  type SimulatorReclaimFacts,
} from "./simulatorMemoryReclaim";

/**
 * The two background jobs that keep lane devices from piling up.
 *
 * - The cleanup pass (`reconcile` on the registry): deletes ADE devices no live
 *   lane holds, releases devices of lanes that ended, drops rows whose
 *   simulator is gone. Runs shortly after start, then every 15 minutes.
 * - Idle power-off: an ADE device that is booted and that nothing has touched
 *   for `idleMs` is powered off. A booted simulator holds several gigabytes of
 *   memory, and on a Mac that is short of it, swap grows on the same disk the
 *   devices use. Booting again takes seconds.
 *
 * Only ADE's own devices are powered off. An attached device is the user's,
 * and Xcode or a test run may be using it without ADE seeing any of it. While
 * Simulator.app is running, nothing is powered off: a person may be driving a
 * device in its window, and that leaves no trace ADE can read.
 *
 * "Touched" is recorded in a file in the device's own directory
 * (`ade-last-activity`), not in memory: the desktop and the brain can each run
 * a simulator service for one project, and one of them must not power off a
 * device the other is driving. A process that is streaming, recording, testing
 * or launching on a device touches it on every tick, so that work counts too.
 * Use outside ADE counts as well, as far as the device shows it: a device
 * still booting is never idle, and CoreSimulator's last boot time and the
 * last app install or removal on the device move the idle clock forward.
 */

export const APPLE_DEVICE_ACTIVITY_FILE = "ade-last-activity" as const;
/**
 * When and why ADE last powered the device off, as JSON, beside the activity
 * file. A simulator that was simply found Shutdown said nothing about who shut
 * it; this is what lets the next command (and `status`, `device-list`) say
 * "ADE did, after 30 min idle". Cleared when ADE boots the device again.
 */
export const APPLE_DEVICE_POWER_OFF_FILE = "ade-powered-off" as const;
/**
 * The low-memory warning a lane's agent has not seen yet, as JSON beside the
 * activity file (`simulatorMemoryReclaim.ts`). The next agent command on the
 * device shows it once and removes it; a boot or a shutdown removes it too.
 */
export const APPLE_DEVICE_MEMORY_WARNING_FILE = "ade-memory-warning" as const;
const DEFAULT_IDLE_MS = 30 * 60_000;
const IDLE_TICK_MS = 5 * 60_000;
const CLEANUP_FIRST_MS = 60_000;
const CLEANUP_TICK_MS = APPLE_DEVICE_CLEANUP_INTERVAL_MS;
const TOUCH_THROTTLE_MS = 60_000;

type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** `ADE_APPLE_IDLE_POWER_OFF_MINUTES`: minutes, `0` turns idle power-off off. */
/** Which chat's agent booted the device, while it stays on. Absent when anyone else did. */
export const APPLE_DEVICE_BOOTED_BY_FILE = "ade-booted-by-chat" as const;

export function appleIdlePowerOffMs(env: NodeJS.ProcessEnv = process.env): number {
  return deviceIdleMsFromEnv(env, "ADE_APPLE_IDLE_POWER_OFF_MINUTES", DEFAULT_IDLE_MS);
}

/** What `APPLE_DEVICE_POWER_OFF_FILE` holds. */
export type AppleDevicePowerOffRecord = {
  /** ISO time of the power-off. */
  at: string;
  /**
   * `idle`: the idle timer. `cleanup`: a Clean up the user or an agent asked
   * for. `memory`: the computer was short of memory (`simulatorMemoryReclaim.ts`).
   */
  reason: "idle" | "cleanup" | "memory";
  /** How long the device had been idle, in whole minutes. */
  idleMinutes: number;
  /** The device's name when it was shut down (memory only). */
  name?: string;
  /** The memory facts at the shutdown (memory only). */
  facts?: SimulatorReclaimFacts;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse a power-off record, or null for anything malformed. */
export function parseDevicePowerOffRecord(raw: string): AppleDevicePowerOffRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<AppleDevicePowerOffRecord> | null;
    if (!value || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return null;
    const reason = value.reason === "cleanup" ? "cleanup" : value.reason === "memory" ? "memory" : "idle";
    const idleMinutes = typeof value.idleMinutes === "number" && Number.isFinite(value.idleMinutes)
      ? Math.max(0, Math.round(value.idleMinutes))
      : 0;
    if (reason !== "memory") return { at: value.at, reason, idleMinutes };
    const facts = value.facts && typeof value.facts === "object"
      ? { swapUsedMb: finiteOrNull(value.facts.swapUsedMb), simulatorMb: finiteOrNull(value.facts.simulatorMb) }
      : null;
    return {
      at: value.at,
      reason,
      idleMinutes,
      ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim().slice(0, 120) } : {}),
      ...(facts ? { facts } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * One sentence on why a device is off: "ADE powered iPad Air 11 off after
 * 31 min idle at 10:12; the next --device command boots it again." `next` is
 * what boots it again, which differs for the lane's device and an extra.
 */
export function describeDevicePowerOff(
  record: AppleDevicePowerOffRecord,
  deviceName: string,
  next: string,
  nowMs: number = Date.now(),
): string {
  const at = new Date(record.at);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  // A device can stay off for days, so "at 10:12" alone would read as today.
  const when = at.toDateString() === new Date(nowMs).toDateString()
    ? `at ${clock}`
    : `on ${at.getMonth() + 1}/${at.getDate()} at ${clock}`;
  if (record.reason === "memory") {
    const facts = simulatorReclaimFactsPhrase(record.facts);
    const name = deviceName || record.name || "";
    return `ADE shut down this simulator${name ? ` (${name})` : ""} ${when} because the computer was short of memory`
      + `${facts ? ` (${facts})` : ""}; ${next}`;
  }
  const why = record.reason === "cleanup"
    ? "in a Clean up"
    : `after ${record.idleMinutes} min idle`;
  return `ADE powered ${deviceName || "this simulator"} off ${why} ${when}; ${next}`;
}

/** What `APPLE_DEVICE_MEMORY_WARNING_FILE` holds. */
export type AppleDeviceMemoryWarning = { at: string; text: string };

/**
 * The files ADE keeps in a simulator's own folder, for any simulator, an ADE
 * lane's or not. `root`: `appleDeviceDataRoot()`. Every call never throws;
 * `onWriteError` hears a write that failed.
 */
export function appleDeviceFiles(
  root: string,
  options: { onWriteError?: (udid: string, fileName: string, error: unknown) => void } = {},
) {
  const dir = (udid: string) => path.join(root, udid);
  const file = (udid: string, name: string) => path.join(root, udid, name);
  const mtime = (filePath: string): number => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  };
  const writeInto = (udid: string, name: string, text: string): boolean => {
    try {
      // Only into a directory that exists: the device may be gone.
      if (!fs.existsSync(dir(udid))) return false;
      fs.writeFileSync(file(udid, name), text, "utf8");
      return true;
    } catch (error) {
      options.onWriteError?.(udid, name, error);
      return false;
    }
  };
  const remove = (udid: string, name: string): void => {
    try {
      fs.rmSync(file(udid, name), { force: true });
    } catch {
      // A leftover file only adds a stale sentence.
    }
  };
  const lastActivityMs = (udid: string): number => mtime(file(udid, APPLE_DEVICE_ACTIVITY_FILE));
  const lastInstallChangeMs = (udid: string): number =>
    mtime(path.join(dir(udid), "data", "Containers", "Bundle", "Application"));
  const writePowerOff = (udid: string, record: AppleDevicePowerOffRecord): boolean =>
    writeInto(udid, APPLE_DEVICE_POWER_OFF_FILE, JSON.stringify(record));
  const clearMemoryWarning = (udid: string): void => remove(udid, APPLE_DEVICE_MEMORY_WARNING_FILE);
  return {
    /** ADE's last recorded use (`ade-last-activity`); 0 when there is none. */
    lastActivityMs,
    /** When an app was last installed or removed on the device, from its bundle folder; 0 when unreadable. */
    lastInstallChangeMs,
    writePowerOff,
    /** Why ADE last powered this device off, or null when it did not (or booted it since). */
    readPowerOff: (udid: string): AppleDevicePowerOffRecord | null => {
      try {
        return parseDevicePowerOffRecord(fs.readFileSync(file(udid, APPLE_DEVICE_POWER_OFF_FILE), "utf8"));
      } catch {
        return null;
      }
    },
    clearPowerOff: (udid: string): void => remove(udid, APPLE_DEVICE_POWER_OFF_FILE),
    /**
     * ADE shut the device down because the computer was short of memory:
     * record why for the next command, and drop the warning before it (the
     * shutdown is the news now). Returns the record.
     */
    recordMemoryPowerOff: (
      udid: string,
      shutdown: { nowMs: number; name: string; facts: SimulatorReclaimFacts },
    ): AppleDevicePowerOffRecord => {
      const lastUse = Math.max(lastActivityMs(udid), lastInstallChangeMs(udid));
      const record: AppleDevicePowerOffRecord = {
        at: new Date(shutdown.nowMs).toISOString(),
        reason: "memory",
        idleMinutes: lastUse > 0 ? Math.max(0, Math.round((shutdown.nowMs - lastUse) / 60_000)) : 0,
        name: shutdown.name,
        facts: shutdown.facts,
      };
      writePowerOff(udid, record);
      clearMemoryWarning(udid);
      return record;
    },
    writeMemoryWarning: (udid: string, warning: AppleDeviceMemoryWarning): boolean =>
      writeInto(udid, APPLE_DEVICE_MEMORY_WARNING_FILE, JSON.stringify(warning)),
    /** The unseen warning, removed as it is read: it shows once. */
    takeMemoryWarning: (udid: string): AppleDeviceMemoryWarning | null => {
      let raw: string;
      try {
        raw = fs.readFileSync(file(udid, APPLE_DEVICE_MEMORY_WARNING_FILE), "utf8");
      } catch {
        return null;
      }
      remove(udid, APPLE_DEVICE_MEMORY_WARNING_FILE);
      try {
        const value = JSON.parse(raw) as Partial<AppleDeviceMemoryWarning> | null;
        return value && typeof value.text === "string" && value.text.trim() && typeof value.at === "string"
          ? { at: value.at, text: value.text.trim() }
          : null;
      } catch {
        return null;
      }
    },
    clearMemoryWarning,
  };
}

export type AppleDeviceFiles = ReturnType<typeof appleDeviceFiles>;

type MemoryWarningEntry = { device: AppleLaneDevice; warning: AppleDeviceMemoryWarning };
type MemoryPowerOffEntry = { device: AppleLaneDevice; record: AppleDevicePowerOffRecord & { reason: "memory" } };

/**
 * What the machine's low-memory pass left for a lane's devices
 * (`simulatorMemoryReclaim.ts`), for the answer of an agent's next device
 * command: each unseen warning, shown once, and why ADE shut a device down,
 * shown until it boots again. An extra's shutdown is named by its own boot
 * (`bootExtraDevice`). A shutdown record of a device the device list shows
 * as Booted is stale: it is dropped and removed. With no device list, no
 * shutdown is named. `restore` puts the warnings back, for a call that fails
 * or cannot carry a notice.
 */
export async function takeLaneMemoryNotices(args: {
  files: AppleDeviceFiles;
  devices: readonly AppleLaneDevice[];
  mode: "drive" | "check";
  /** The udids the device list shows as Booted; null when it cannot be read. Read only when a shutdown record needs it. */
  bootedUdids: () => Promise<ReadonlySet<string> | null>;
}): Promise<{ notices: string[]; restore: () => void }> {
  const { files } = args;
  const warnings = args.devices
    .map((device) => ({ device, warning: files.takeMemoryWarning(device.udid) }))
    .filter((entry): entry is MemoryWarningEntry => entry.warning !== null);
  const records = args.devices
    .filter((device) => !device.extra)
    .map((device) => ({ device, record: files.readPowerOff(device.udid) }))
    .filter((entry): entry is MemoryPowerOffEntry => entry.record?.reason === "memory");
  const shutdowns: MemoryPowerOffEntry[] = [];
  if (records.length > 0) {
    const booted = await args.bootedUdids().catch(() => null);
    if (booted) {
      for (const entry of records) {
        if (booted.has(entry.device.udid)) files.clearPowerOff(entry.device.udid);
        else shutdowns.push(entry);
      }
    }
  }
  const next = args.mode === "drive" ? "this command boots it again if it needs it." : "boot it again when needed.";
  return {
    notices: [
      ...shutdowns.map(({ device, record }) => describeDevicePowerOff(record, device.name, next)),
      ...warnings.map(({ warning }) => warning.text),
    ],
    restore: () => {
      for (const { device, warning } of warnings) files.writeMemoryWarning(device.udid, warning);
    },
  };
}

export type LaneDeviceMaintenanceDeps = {
  laneDevices: LaneDeviceRegistry;
  run: RunCommand;
  /** Power off through the service's own path, so the helper and recorder hear it. */
  powerOffDevice: (device: AppleLaneDevice) => Promise<void>;
  /**
   * This process is streaming, recording, testing or launching on the device.
   * With `onlyWatchedStreams`, a stream nobody is viewing does not count.
   */
  isBusyHere: (udid: string, options?: { onlyWatchedStreams?: boolean }) => boolean;
  deviceDataRoot?: string | null;
  idleMs?: number;
  now?: () => number;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
  };
};

export function createLaneDeviceMaintenance(deps: LaneDeviceMaintenanceDeps) {
  const now = deps.now ?? (() => Date.now());
  const root = () => deps.deviceDataRoot?.trim() || appleDeviceDataRoot();
  const idleMs = deps.idleMs ?? appleIdlePowerOffMs();
  const startedAt = now();
  const touchThrottle = createPerKeyThrottle(TOUCH_THROTTLE_MS, now);
  let stopTimers: (() => void) | null = null;
  let cleanupRunning: Promise<AppleDeviceCleanupResult> | null = null;

  const activityFile = (udid: string) => path.join(root(), udid, APPLE_DEVICE_ACTIVITY_FILE);

  /** Record that something used the device. Throttled; never throws. */
  const touch = (udid: string): void => {
    if (!touchThrottle.take(udid)) return;
    const at = now();
    try {
      // Only into a directory that exists: the device may be gone.
      if (!fs.existsSync(path.join(root(), udid))) return;
      fs.writeFileSync(activityFile(udid), new Date(at).toISOString(), "utf8");
    } catch (error) {
      deps.logger.debug("apple.device_activity_touch_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** The device folder's files; a power-off record that cannot be written is logged. */
  const files = (): AppleDeviceFiles => appleDeviceFiles(root(), {
    onWriteError: (udid, _fileName, error) => {
      deps.logger.debug("apple.device_power_off_record_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  /** Why ADE last powered this device off, or null when it did not (or booted it since). */
  const readPowerOff = (udid: string): AppleDevicePowerOffRecord | null => files().readPowerOff(udid);

  /**
   * ADE booted the device again: the old power-off is no longer the news, and
   * neither is a low-memory warning about the boot before. Never throws.
   */
  const clearPowerOff = (udid: string): void => {
    files().clearPowerOff(udid);
    files().clearMemoryWarning(udid);
  };

  const bootedByFile = (udid: string) => path.join(root(), udid, APPLE_DEVICE_BOOTED_BY_FILE);

  /** A chat, or null when something other than an agent's call brought the device up. Never throws. */
  const recordBootedBy = (udid: string, chatSessionId: string | null): void => {
    try {
      if (!chatSessionId) {
        fs.rmSync(bootedByFile(udid), { force: true });
      } else if (fs.existsSync(path.join(root(), udid))) {
        fs.writeFileSync(bootedByFile(udid), chatSessionId, "utf8");
      }
    } catch (error) {
      deps.logger.debug("apple.device_booted_by_record_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const readBootedBy = (udid: string): string | null => {
    try {
      return fs.readFileSync(bootedByFile(udid), "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  /**
   * Power off every ADE device that is booted and idle. Returns what it
   * powered off. With `force`, "idle" means "nothing is using it right now",
   * whatever the last activity was. `onlyUdids` limits the pass: an agent's
   * request may power off its own lane's device and nobody else's.
   * `onlyBootedBy` limits it further, to devices one of these chats booted.
   */
  type IdlePassResult = {
    poweredOff: AppleDeviceCleanupResult["poweredOff"];
    skipped: AppleDeviceCleanupResult["powerOffSkipped"];
    /** ADE could not read the devices, or a power-off failed. */
    failed?: true;
  };
  const runIdlePass = async (
    options: { force?: boolean; onlyUdids?: ReadonlySet<string> | null; onlyBootedBy?: ReadonlySet<string> | null } = {},
  ): Promise<IdlePassResult> => {
    const poweredOff: AppleDeviceCleanupResult["poweredOff"] = [];
    let failed = false;
    const done = (skipped: IdlePassResult["skipped"] = null): IdlePassResult => ({
      poweredOff,
      skipped,
      ...(failed || skipped === "process-list-unavailable" ? { failed: true as const } : {}),
    });
    if (!options.force && idleMs <= 0) return done();
    const devices = deps.laneDevices.list().filter((device) => (
      isAdeOwnedLaneDevice(device.origin) && (!options.onlyUdids || options.onlyUdids.has(device.udid))
    ));
    if (!devices.length) return done();
    let states: Map<string, { state: string; lastBootedAtMs?: number | null }>;
    try {
      const { stdout } = await deps.run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      states = parseSimctlDevices(stdout);
    } catch {
      failed = true;
      return done();
    }
    let psOutput: string | null = null;
    for (const device of devices) {
      const listed = states.get(device.udid);
      // Off, by whatever means: whoever boots it next is a new question.
      if (listed?.state === "Shutdown") {
        recordBootedBy(device.udid, null);
        continue;
      }
      if (options.onlyBootedBy) {
        const bootedBy = readBootedBy(device.udid);
        if (!bootedBy || !options.onlyBootedBy.has(bootedBy)) continue;
      }
      // A device still booting is in use by whoever booted it (often a raw
      // `simctl boot` outside ADE): restart its idle clock, never power it off.
      if (listed?.state === "Booting") {
        touch(device.udid);
        continue;
      }
      if (listed?.state !== "Booted") continue;
      // An agent's `apple start` leaves its stream running with nobody watching;
      // that must not keep a settled chat's device on.
      if (deps.isBusyHere(device.udid, { onlyWatchedStreams: Boolean(options.onlyBootedBy) })) {
        touch(device.udid);
        continue;
      }
      // ADE's own record of use, and what the device shows of use outside
      // ADE: CoreSimulator's last boot (a raw `simctl boot`) and the last
      // app install or removal (a raw `simctl install`).
      const last = Math.max(
        files().lastActivityMs(device.udid),
        startedAt,
        listed.lastBootedAtMs ?? 0,
        files().lastInstallChangeMs(device.udid),
      );
      if (!options.force && now() - last < idleMs) continue;
      if (psOutput === null) {
        psOutput = await deps.run("ps", ["-axo", "command="], { timeoutMs: 10_000 })
          .then((result) => result.stdout)
          .catch(() => null);
        // No process list means no way to tell what else uses the devices.
        if (psOutput === null) return done("process-list-unavailable");
        if (simulatorAppRunning(psOutput)) {
          deps.logger.debug("apple.lane_device_idle_skipped_simulator_app", {});
          return done("simulator-app-open");
        }
      }
      if (externalToolUsesDevice(psOutput, device)) {
        touch(device.udid);
        continue;
      }
      try {
        await deps.powerOffDevice(device);
        poweredOff.push({ udid: device.udid, name: device.name });
        const idleMinutes = Math.round((now() - last) / 60_000);
        files().writePowerOff(device.udid, {
          at: new Date(now()).toISOString(),
          reason: options.force ? "cleanup" : "idle",
          idleMinutes,
        });
        deps.logger.info("apple.lane_device_idle_powered_off", {
          laneId: device.laneId,
          udid: device.udid,
          extra: device.extra === true,
          idleMinutes,
        });
      } catch (error) {
        failed = true;
        deps.logger.warn("apple.lane_device_idle_power_off_failed", {
          laneId: device.laneId,
          udid: device.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return done();
  };

  /**
   * The cleanup pass. One reconcile at a time: a second caller shares the one
   * in flight. A requested power-off always runs after it, so a Clean up that
   * lands during a background pass still powers off what it was asked to.
   */
  const runCleanup = async (
    options: { powerOffIdle?: boolean; onlyUdids?: ReadonlySet<string> | null } = {},
  ): Promise<AppleDeviceCleanupResult> => {
    const pass = cleanupRunning ?? deps.laneDevices.reconcile().finally(() => {
      cleanupRunning = null;
    });
    cleanupRunning = pass;
    const reconciled = await pass;
    const result: AppleDeviceCleanupResult = {
      deleted: [...reconciled.deleted],
      poweredOff: [...reconciled.poweredOff],
      forgottenRows: [...reconciled.forgottenRows],
      released: [...reconciled.released],
      errors: [...reconciled.errors],
    };
    if (options.powerOffIdle) {
      const idle = await runIdlePass({ force: true, onlyUdids: options.onlyUdids ?? null });
      result.poweredOff.push(...idle.poweredOff);
      result.powerOffSkipped = idle.skipped;
    }
    return result;
  };

  const start = (): void => {
    if (stopTimers) return;
    stopTimers = startDeviceMaintenanceTimers([
      { firstMs: CLEANUP_FIRST_MS, everyMs: CLEANUP_TICK_MS, run: () => runCleanup() },
      ...(idleMs > 0 ? [{ everyMs: IDLE_TICK_MS, run: () => runIdlePass() }] : []),
    ], (error) => {
      deps.logger.warn("apple.lane_device_maintenance_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const stop = (): void => {
    stopTimers?.();
    stopTimers = null;
  };

  /**
   * Shut one lane device down because the computer is short of memory, through
   * the service's own power path, and record why for the next command. The
   * caller decided it is idle (`classifySimulatorForMemoryReclaim`).
   */
  const powerOffForMemory = async (
    device: AppleLaneDevice,
    facts: SimulatorReclaimFacts,
  ): Promise<AppleDevicePowerOffRecord> => {
    await deps.powerOffDevice(device);
    return files().recordMemoryPowerOff(device.udid, { nowMs: now(), name: device.name, facts });
  };

  return {
    touch,
    readPowerOff,
    clearPowerOff,
    recordBootedBy,
    readBootedBy,
    runIdlePass,
    runCleanup,
    powerOffForMemory,
    files,
    start,
    stop,
  };
}

export type LaneDeviceMaintenance = ReturnType<typeof createLaneDeviceMaintenance>;
