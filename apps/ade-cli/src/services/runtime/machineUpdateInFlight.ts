import type { MachineUpdateAndRestartResult } from "./machineUpdateAndRestart";

/**
 * The one "Update & restart" run this process will do at a time.
 *
 * Module-scoped on purpose: overlapping callers are not one impatient client
 * but several — a desktop over the runtime RPC, a phone over a sync command,
 * and a reconnect that retried — each on its own connection and its own
 * handler. Two runs would download and swap the same runtime concurrently and
 * then both ask the service to restart, mid-swap. Whoever asks while a run is
 * in flight joins that run and gets its result.
 *
 * Its own module, with no runtime imports, so a caller can check and join
 * synchronously before it loads the (lazy) updater: an await in between let a
 * second caller miss a run that was just finishing and start another.
 */
let inFlight: { run: Promise<MachineUpdateAndRestartResult>; trackSwitch: boolean } | null = null;

export function joinOrStartMachineUpdate(
  start: () => Promise<MachineUpdateAndRestartResult>,
  { trackSwitch = false }: { trackSwitch?: boolean } = {},
): Promise<MachineUpdateAndRestartResult> {
  if (inFlight) {
    if (trackSwitch || inFlight.trackSwitch) {
      return Promise.reject(new Error("An ADE update or track switch is already running. Try again after it finishes."));
    }
    return inFlight.run;
  }
  const run = start();
  inFlight = { run, trackSwitch };
  const clear = (): void => {
    if (inFlight?.run === run) inFlight = null;
  };
  run.then(clear, clear);
  return run;
}
