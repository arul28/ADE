import fs from "node:fs";
import path from "node:path";
import type { AppleDeviceCleanupResult, AppleLaneDevice } from "../../../shared/types/iosSimulator";
import { isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import { appleDeviceDataRoot, parseSimctlDevices } from "./appleSimulatorCatalog";
import type { LaneDeviceRegistry } from "./laneDeviceRegistry";

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
 */

export const APPLE_DEVICE_ACTIVITY_FILE = "ade-last-activity" as const;
const DEFAULT_IDLE_MS = 30 * 60_000;
const IDLE_TICK_MS = 5 * 60_000;
const CLEANUP_FIRST_MS = 60_000;
const CLEANUP_TICK_MS = 15 * 60_000;
const TOUCH_THROTTLE_MS = 60_000;

type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** `ADE_APPLE_IDLE_POWER_OFF_MINUTES`: minutes, `0` turns idle power-off off. */
export function appleIdlePowerOffMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ADE_APPLE_IDLE_POWER_OFF_MINUTES?.trim();
  if (!raw) return DEFAULT_IDLE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MS;
  return minutes * 60_000;
}

/** Simulator.app is running: `ps` shows its main executable. */
export function simulatorAppRunning(psOutput: string): boolean {
  return psOutput.split("\n").some((line) => /Simulator\.app\/Contents\/MacOS\/Simulator(\s|$)/u.test(line));
}

/**
 * Is a process outside ADE driving this device? `ps` lines of `xcodebuild`
 * and `simctl` that name the device by udid or by name. Pure, for the test.
 */
export function externalToolUsesDevice(psOutput: string, device: { udid: string; name: string }): boolean {
  const name = device.name.trim();
  for (const line of psOutput.split("\n")) {
    if (!/\b(xcodebuild|simctl|xctest)\b/u.test(line)) continue;
    if (line.includes(device.udid)) return true;
    if (name && line.includes(`name=${name}`)) return true;
  }
  return false;
}

export type LaneDeviceMaintenanceDeps = {
  laneDevices: LaneDeviceRegistry;
  run: RunCommand;
  /** Power off through the service's own path, so the helper and recorder hear it. */
  powerOffDevice: (device: AppleLaneDevice) => Promise<void>;
  /** This process is streaming, recording, testing or launching on the device. */
  isBusyHere: (udid: string) => boolean;
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
  const lastTouch = new Map<string, number>();
  const timers: NodeJS.Timeout[] = [];
  let cleanupRunning: Promise<AppleDeviceCleanupResult> | null = null;

  const activityFile = (udid: string) => path.join(root(), udid, APPLE_DEVICE_ACTIVITY_FILE);

  /** Record that something used the device. Throttled; never throws. */
  const touch = (udid: string): void => {
    const at = now();
    const previous = lastTouch.get(udid) ?? 0;
    if (at - previous < TOUCH_THROTTLE_MS) return;
    lastTouch.set(udid, at);
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

  const lastActivityMs = (udid: string): number => {
    try {
      return fs.statSync(activityFile(udid)).mtimeMs;
    } catch {
      return 0;
    }
  };

  /**
   * Power off every ADE device that is booted and idle. Returns what it
   * powered off. With `force`, "idle" means "nothing is using it right now",
   * whatever the last activity was. `onlyUdids` limits the pass: an agent's
   * request may power off its own lane's device and nobody else's.
   */
  type IdlePassResult = {
    poweredOff: AppleDeviceCleanupResult["poweredOff"];
    skipped: AppleDeviceCleanupResult["powerOffSkipped"];
  };
  const runIdlePass = async (
    options: { force?: boolean; onlyUdids?: ReadonlySet<string> | null } = {},
  ): Promise<IdlePassResult> => {
    const poweredOff: AppleDeviceCleanupResult["poweredOff"] = [];
    const done = (skipped: IdlePassResult["skipped"] = null): IdlePassResult => ({ poweredOff, skipped });
    if (!options.force && idleMs <= 0) return done();
    const devices = deps.laneDevices.list().filter((device) => (
      isAdeOwnedLaneDevice(device.origin) && (!options.onlyUdids || options.onlyUdids.has(device.udid))
    ));
    if (!devices.length) return done();
    let states: Map<string, { state: string }>;
    try {
      const { stdout } = await deps.run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      states = parseSimctlDevices(stdout);
    } catch {
      return done();
    }
    let psOutput: string | null = null;
    for (const device of devices) {
      if (states.get(device.udid)?.state !== "Booted") continue;
      if (deps.isBusyHere(device.udid)) {
        touch(device.udid);
        continue;
      }
      const last = Math.max(lastActivityMs(device.udid), startedAt);
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
        deps.logger.info("apple.lane_device_idle_powered_off", {
          laneId: device.laneId,
          udid: device.udid,
          idleMinutes: Math.round((now() - last) / 60_000),
        });
      } catch (error) {
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
    if (timers.length) return;
    const schedule = (ms: number, job: () => Promise<unknown>, repeat: boolean) => {
      const handle = (repeat ? setInterval : setTimeout)(() => {
        void job().catch((error: unknown) => {
          deps.logger.warn("apple.lane_device_maintenance_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, ms);
      // Never the reason a process stays alive.
      handle.unref?.();
      timers.push(handle);
    };
    schedule(CLEANUP_FIRST_MS, () => runCleanup(), false);
    schedule(CLEANUP_TICK_MS, () => runCleanup(), true);
    if (idleMs > 0) schedule(IDLE_TICK_MS, () => runIdlePass(), true);
  };

  const stop = (): void => {
    for (const handle of timers.splice(0)) {
      clearTimeout(handle);
      clearInterval(handle);
    }
  };

  return { touch, runIdlePass, runCleanup, start, stop };
}

export type LaneDeviceMaintenance = ReturnType<typeof createLaneDeviceMaintenance>;
