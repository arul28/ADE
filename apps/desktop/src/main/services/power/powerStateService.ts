/**
 * The main process's single owner of "is this machine awake, and what is it
 * running on".
 *
 * Detection is layered, most precise first:
 *
 * 1. Electron `powerMonitor` `suspend`/`resume`. `suspend` fires a beat BEFORE
 *    the machine actually goes down, which is the only moment we can still tell
 *    anyone about it — that beat is the whole reason a phone can say "Asleep"
 *    instead of guessing from silence.
 * 2. `powerMonitor.isOnBatteryPower()`, which is cross-platform. The `on-ac` /
 *    `on-battery` EVENTS are macOS and Windows only, so the battery percentage
 *    and the Linux answer both come from a poll instead.
 * 3. The heartbeat-gap detector, always armed. It needs no platform code at
 *    all, so it covers anything the events above miss.
 *
 * Battery readings come from the ade-cli reader rather than a second
 * implementation here, because Linux ships no ADE desktop app (`linux: false`)
 * and the brain must be able to answer the same question alone.
 */

import { powerMonitor } from "electron";
import {
  createMachinePowerMonitor,
  type MachinePowerEvent,
  type MachinePowerSource,
} from "../../../../../ade-cli/src/services/power/machinePowerMonitor";
import { readMachinePower } from "../../../../../ade-cli/src/services/power/machinePowerReader";
import type {
  MachinePower,
  MachinePowerPublication,
  MachineSleepState,
} from "../../../shared/types/power";

export type PowerStateService = MachinePowerSource & {
  start(): void;
  dispose(): void;
  getPublication(): MachinePowerPublication;
  refreshPower(): Promise<MachinePower | null>;
};

export type PowerStateServiceOptions = {
  /** Injectable for tests and for a main process running without Electron. */
  powerMonitor?: Pick<typeof powerMonitor, "on" | "isOnBatteryPower"> | null;
  now?: () => number;
  pollMs?: number;
  readPower?: () => Promise<MachinePower | null>;
};

export function createPowerStateService(
  options: PowerStateServiceOptions = {},
): PowerStateService {
  const monitorApi = options.powerMonitor === undefined ? powerMonitor : options.powerMonitor;
  const readPlatformPower = options.readPower
    ?? ((): Promise<MachinePower | null> => readMachinePower());
  const readPower = async (): Promise<MachinePower | null> => {
    const power = await readPlatformPower();
    // A platform read that failed knows NOTHING, and null is how that is said.
    // Overlaying Electron's answer on it would build `{ onExternalPower: X }`
    // with no `battery` key — which is the exact shape that means "this machine
    // has no battery hardware" everywhere downstream. Since `isOnBatteryPower()`
    // always answers under Electron, every `pmset` timeout would then republish
    // a MacBook on battery as a plugged-in desktop, and the monitor's
    // keep-the-last-reading guard (which only fires on null) would never see it.
    // `isOnBatteryPower` is the one wall-power signal Electron gives us on
    // every platform — the `on-ac` / `on-battery` events are macOS and Windows
    // only — and it is more current than a poll that may be a minute old. Trust
    // it over a SUCCESSFUL platform read whenever it answers.
    if (power === null) return null;
    try {
      const onBattery = monitorApi?.isOnBatteryPower?.();
      if (typeof onBattery === "boolean") {
        return { ...power, onExternalPower: !onBattery };
      }
    } catch {
      // A powerMonitor that refuses to answer is not a reason to drop an
      // otherwise-good battery reading.
    }
    return power;
  };

  const monitor = createMachinePowerMonitor({
    ...(options.now ? { now: options.now } : {}),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    readPower,
  });

  let started = false;
  let disposed = false;

  const bindPowerMonitor = (): void => {
    if (!monitorApi?.on) return;
    // `suspend` is the pre-suspend beat: consumers get it while the machine can
    // still act on it. Everything downstream of this event is best-effort by
    // construction — the machine is on its way down.
    monitorApi.on("suspend", () => monitor.noteAnnouncedSuspend());
    monitorApi.on("resume", () => monitor.noteAnnouncedResume());
    // macOS and Windows only. Linux gets the same transition from the poll.
    monitorApi.on("on-ac", () => {
      void monitor.refreshPower();
    });
    monitorApi.on("on-battery", () => {
      void monitor.refreshPower();
    });
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      bindPowerMonitor();
      monitor.start();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      started = false;
      // powerMonitor listeners live for the life of the process; Electron has
      // no removal seam that is safe to share with other main-process
      // subscribers, so the monitor's disposal is what stops the work.
      monitor.dispose();
    },

    getPower: (): MachinePower | null => monitor.getPower(),
    getSleepState: (): MachineSleepState => monitor.getSleepState(),
    getSleepStateAt: (): number => monitor.getSleepStateAt(),
    getSuspendGapMs: (): number | null => monitor.getSuspendGapMs(),
    getPublication: (): MachinePowerPublication => monitor.getPublication(),
    refreshPower: (): Promise<MachinePower | null> => monitor.refreshPower(),
    subscribe: (listener: (event: MachinePowerEvent) => void): (() => void) =>
      monitor.subscribe(listener),
  };
}

let sharedPowerStateService: PowerStateService | null = null;

/**
 * One service per main process. Power is a property of the machine, so a second
 * instance would mean two poll loops and two answers to the same question.
 */
export function getPowerStateService(): PowerStateService {
  if (!sharedPowerStateService) {
    sharedPowerStateService = createPowerStateService();
    sharedPowerStateService.start();
  }
  return sharedPowerStateService;
}

/** Test seam: drop the shared instance so a suite can build its own. */
export function resetPowerStateServiceForTests(): void {
  sharedPowerStateService?.dispose();
  sharedPowerStateService = null;
}
