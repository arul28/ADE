/**
 * One power monitor per brain process.
 *
 * Three consumers in the brain need the same answer to "is this machine
 * awake": the account-directory publisher (so a phone can say "Asleep"), the
 * chat service (so a turn interrupted by a suspend says so instead of blaming
 * the API), and the RPC method the desktop uses to forward its OS-level
 * pre-suspend beat. A second instance would mean two poll loops, two gap
 * detectors, and two different answers to the same question.
 *
 * Consumers `borrow` the monitor rather than receiving it directly, because
 * the publisher owns the lifecycle of whatever source it is handed and would
 * otherwise dispose the instance the chat service is still subscribed to.
 */

import {
  createMachinePowerMonitor,
  type MachinePowerMonitor,
  type MachinePowerSource,
} from "./machinePowerMonitor";

let shared: MachinePowerMonitor | null = null;

/**
 * The brain's power monitor, started on first use.
 *
 * Plain Node has no `powerMonitor`, so this instance's own detection is the
 * heartbeat gap — universal, and the only signal a Linux host (which has no
 * ADE desktop app at all) will ever have. A desktop on the same machine
 * upgrades it to a precise pre-suspend announcement through
 * `noteAnnouncedSuspend()`; nothing here depends on that happening.
 */
export function getSharedMachinePowerMonitor(): MachinePowerMonitor {
  if (!shared) {
    shared = createMachinePowerMonitor();
    shared.start();
  }
  return shared;
}

/**
 * A read/subscribe view of the shared monitor. `MachinePowerSource` carries no
 * `start`/`dispose`, so a borrower cannot end the shared instance for everybody
 * else — the lifecycle stays with `getSharedMachinePowerMonitor()`.
 */
export function borrowSharedMachinePowerSource(): MachinePowerSource {
  const monitor = getSharedMachinePowerMonitor();
  return {
    getPower: () => monitor.getPower(),
    getSleepState: () => monitor.getSleepState(),
    getSleepStateAt: () => monitor.getSleepStateAt(),
    getSuspendGapMs: () => monitor.getSuspendGapMs(),
    subscribe: (listener) => monitor.subscribe(listener),
  };
}

/** Test seam: drop the shared instance so a suite can build its own. */
export function resetSharedMachinePowerMonitorForTests(): void {
  shared?.dispose();
  shared = null;
}
