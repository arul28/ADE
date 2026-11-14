/**
 * Idle iOS simulators give their memory back when the computer runs short.
 *
 * A booted simulator holds several gigabytes. On a Mac that is short of memory
 * the swap grows, and the machine (and ADE's background service with it) can
 * freeze. The machine brain's resource-pressure monitor samples memory every
 * five minutes; on those samples only, and only while an episode about memory
 * or swap is open, this decides:
 *
 * 1. `warn`: the simulators hold a meaningful share of memory. Each lane with
 *    a booted simulator learns it with its next simulator command, and its
 *    open terminals show one line. Nothing is shut down.
 * 2. `reclaim`: still short a while later (or critically short on a later
 *    sample). ADE shuts down the simulators that nothing uses, with
 *    `simctl shutdown`. It never erases or deletes a device, never touches
 *    build products, and never kills a process.
 *
 * Everything here is pure: the caller reads the facts (the pressure sample,
 * `simctl list`, `ps`, the device folders) and acts on the answer.
 */

/** The simulators matter when they hold at least this much memory... */
export const SIMULATOR_RECLAIM_MIN_MB = 3 * 1024;
/** ...and at least this share of RAM. */
export const SIMULATOR_RECLAIM_MIN_SHARE = 0.10;
/**
 * Once a warning went out in an episode, the simulators still matter down to
 * these lower marks, so a share that wavers around the line does not stop
 * the next step (hysteresis).
 */
export const SIMULATOR_RECLAIM_KEEP_MB = 2 * 1024;
export const SIMULATOR_RECLAIM_KEEP_SHARE = 0.07;
/** A warning comes this long before the first shutdown, so agents can act first. */
export const SIMULATOR_RECLAIM_AFTER_WARN_MS = 10 * 60_000;
/** After a shutdown pass that shut at least one device down, the next one waits this long. */
export const SIMULATOR_RECLAIM_COOLDOWN_MS = 60 * 60_000;
/** ADE used the device (input, build, install, launch, screenshot, record, proof) this recently: in use. */
export const SIMULATOR_RECLAIM_RECENT_USE_MS = 15 * 60_000;
/**
 * A device ADE did not boot must have been booted at least this long before
 * ADE shuts it down. With Simulator.app open, every device must also have
 * gone this long without ADE use, an install change or a boot.
 */
export const SIMULATOR_RECLAIM_FOREIGN_MIN_BOOTED_MS = 2 * 60 * 60_000;
/** `ADE_APPLE_MEMORY_POWER_OFF=0` keeps the warnings and turns the automatic shutdown off. */
export const SIMULATOR_RECLAIM_ENV = "ADE_APPLE_MEMORY_POWER_OFF";

/** Whether this machine reclaims at all: macOS only. */
export function simulatorMemoryReclaimSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Whether the automatic shutdown is on (the warnings always are). */
export function simulatorMemoryPowerOffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SIMULATOR_RECLAIM_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export type SimulatorReclaimState = {
  /** The pressure episode the steps below belong to. */
  episodeId: string | null;
  warnedAtMs: number | null;
  /**
   * The last shutdown pass that shut a device down, across episodes (the
   * cooldown). A pass that shut nothing down leaves it, so the next sample
   * tries again.
   */
  reclaimedAtMs: number | null;
};

export const INITIAL_SIMULATOR_RECLAIM_STATE: SimulatorReclaimState = {
  episodeId: null,
  warnedAtMs: null,
  reclaimedAtMs: null,
};

export type SimulatorReclaimTick = {
  nowMs: number;
  /** The open pressure episode, or null. */
  episodeId: string | null;
  /** What this sample breaks; null when it is healthy. */
  breach: { kinds: readonly string[]; severity: "warn" | "critical" } | null;
};

function memoryBreach(tick: SimulatorReclaimTick): boolean {
  return Boolean(tick.episodeId && tick.breach?.kinds.some((kind) => kind === "memory" || kind === "swap"));
}

/**
 * Whether a step could be due on this sample, before the caller spends a
 * process listing on the simulators' memory. Pure.
 */
export function simulatorReclaimStepPossible(state: SimulatorReclaimState, tick: SimulatorReclaimTick): boolean {
  if (!memoryBreach(tick)) return false;
  const sameEpisode = state.episodeId === tick.episodeId;
  if (!sameEpisode || state.warnedAtMs === null) return true;
  return reclaimDue(state, tick);
}

function reclaimDue(state: SimulatorReclaimState, tick: SimulatorReclaimTick): boolean {
  if (state.warnedAtMs === null || tick.nowMs <= state.warnedAtMs) return false;
  if (state.reclaimedAtMs !== null && tick.nowMs - state.reclaimedAtMs < SIMULATOR_RECLAIM_COOLDOWN_MS) return false;
  // Critical on a later sample than the warning, or still short after the delay.
  return tick.breach?.severity === "critical" || tick.nowMs - state.warnedAtMs >= SIMULATOR_RECLAIM_AFTER_WARN_MS;
}

/** The simulators hold a meaningful share of memory. `keep`: the lower marks of a step already taken. */
export function simulatorsHoldMeaningfulMemory(
  simulatorMb: number | null,
  totalMb: number | null,
  keep = false,
): boolean {
  if (simulatorMb === null || !Number.isFinite(simulatorMb) || simulatorMb <= 0) return false;
  const minMb = keep ? SIMULATOR_RECLAIM_KEEP_MB : SIMULATOR_RECLAIM_MIN_MB;
  const minShare = keep ? SIMULATOR_RECLAIM_KEEP_SHARE : SIMULATOR_RECLAIM_MIN_SHARE;
  const shareMb = totalMb && totalMb > 0 ? totalMb * minShare : 0;
  return simulatorMb >= Math.max(minMb, shareMb);
}

export type SimulatorReclaimStep = "none" | "warn" | "reclaim";

/**
 * One sample's step and the state after it. A new episode starts with a
 * warning again; the cooldown between shutdown passes holds across episodes.
 * Pure.
 */
export function nextSimulatorReclaimStep(
  state: SimulatorReclaimState,
  tick: SimulatorReclaimTick & { simulatorMb: number | null; totalMb: number | null },
): { step: SimulatorReclaimStep; state: SimulatorReclaimState } {
  if (!memoryBreach(tick)) return { step: "none", state };
  const current: SimulatorReclaimState = state.episodeId === tick.episodeId
    ? state
    : { episodeId: tick.episodeId, warnedAtMs: null, reclaimedAtMs: state.reclaimedAtMs };
  const warned = current.warnedAtMs !== null;
  if (!simulatorsHoldMeaningfulMemory(tick.simulatorMb, tick.totalMb, warned)) return { step: "none", state: current };
  if (!warned) return { step: "warn", state: { ...current, warnedAtMs: tick.nowMs } };
  if (!reclaimDue(current, tick)) return { step: "none", state: current };
  // The cooldown starts only once the pass shut something down (`afterSimulatorReclaimPass`).
  return { step: "reclaim", state: current };
}

/**
 * The state after a shutdown pass. The cooldown starts only when the pass shut
 * at least one device down (or the shutdown is turned off, so the pass is not
 * repeated on every sample). An empty or failed pass leaves it, and the next
 * sample tries again. Pure.
 */
export function afterSimulatorReclaimPass(
  state: SimulatorReclaimState,
  pass: { nowMs: number; shutDown: number; powerOffDisabled?: boolean },
): SimulatorReclaimState {
  return pass.shutDown > 0 || pass.powerOffDisabled ? { ...state, reclaimedAtMs: pass.nowMs } : state;
}

/** What the caller knows about one booted simulator. */
export type SimulatorReclaimDevice = {
  udid: string;
  name: string;
  /** `simctl list` state. */
  state: string;
  /** CoreSimulator's last boot time, or null when it cannot be read. */
  lastBootedAtMs: number | null;
  /** ADE made the device for a lane (not an attached or outside device). */
  adeOwned: boolean;
  /** This brain streams, records, tests or launches on it, or a viewer watches it. */
  busyHere: boolean;
  /** ADE's last use of it (`ade-last-activity`); 0 when there is none. */
  lastAdeActivityMs: number;
  /** The last app install or removal on it; 0 when unreadable. */
  lastInstallChangeMs: number;
};

export type SimulatorReclaimContext = {
  nowMs: number;
  /** `ps -axo command=`; null when it could not be read. */
  psOutput: string | null;
  /**
   * The device Simulator.app last showed (its `CurrentDeviceUDID` setting),
   * read only while Simulator.app runs; null when unknown. A hint: a person
   * may be looking at that one.
   */
  simulatorAppDeviceUdid?: string | null;
};

export type SimulatorReclaimVerdict =
  | { idle: true }
  | {
    idle: false;
    reason:
      | "not_booted"
      | "no_process_list"
      | "simulator_app_device"
      | "simulator_app_recent_use"
      | "test_run_unknown_device"
      | "tool_uses_device"
      | "busy_here"
      | "recent_use"
      | "boot_time_unknown"
      | "booted_recently";
  };

/** Simulator.app is running: a person may be driving a device in its window. */
export function simulatorAppRunning(psOutput: string): boolean {
  return psOutput.split("\n").some((line) => /Simulator\.app\/Contents\/MacOS\/Simulator(\s|$)/u.test(line));
}

/** An `xcodebuild` or `simctl` process names the device by udid or by name. */
function toolNamesDevice(psOutput: string, device: { udid: string; name: string }): boolean {
  const name = device.name.trim();
  for (const line of psOutput.split("\n")) {
    if (!/\b(xcodebuild|simctl|xctest)\b/u.test(line)) continue;
    if (line.includes(device.udid)) return true;
    if (name && line.includes(`name=${name}`)) return true;
  }
  return false;
}

const UDID_PATTERN = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/iu;

/**
 * An `xcodebuild` test run (or an `xctest` runner) whose device the command
 * line does not name: it may run on any simulator, so every device counts as
 * in use. Pure.
 */
export function testRunWithUnknownDevice(psOutput: string): boolean {
  for (const line of psOutput.split("\n")) {
    const isXcodebuildTest = /\bxcodebuild\b/u.test(line) && /\s(test|test-without-building)(\s|$)/u.test(line);
    const isXctest = /\bxctest\b/u.test(line) && !/\bxcodebuild\b/u.test(line);
    if (!isXcodebuildTest && !isXctest) continue;
    if (UDID_PATTERN.test(line)) continue;
    if (/name=/u.test(line)) continue;
    return true;
  }
  return false;
}

/**
 * Whether ADE may shut this simulator down to free memory. Conservative:
 * any doubt keeps it on. Pure.
 *
 * In use: not booted; no process list; a test run whose device is unknown; a
 * tool that names the device; ADE streaming, recording, testing or launching
 * on it; ADE used it, booted it or installed on it in the last
 * {@link SIMULATOR_RECLAIM_RECENT_USE_MS}. A device ADE did not make is idle
 * only when its boot time can be read and it has been booted at least
 * {@link SIMULATOR_RECLAIM_FOREIGN_MIN_BOOTED_MS}.
 *
 * Simulator.app open raises the bar for every device, ADE's or not: a person
 * may drive one in its window, which leaves no trace. The device it last
 * showed stays on, and any other device is idle only after
 * {@link SIMULATOR_RECLAIM_FOREIGN_MIN_BOOTED_MS} without ADE use, an install
 * change or a boot, with a boot time that can be read.
 */
export function classifySimulatorForMemoryReclaim(
  device: SimulatorReclaimDevice,
  context: SimulatorReclaimContext,
): SimulatorReclaimVerdict {
  if (device.state !== "Booted") return { idle: false, reason: "not_booted" };
  const ps = context.psOutput;
  if (ps === null) return { idle: false, reason: "no_process_list" };
  if (testRunWithUnknownDevice(ps)) return { idle: false, reason: "test_run_unknown_device" };
  if (toolNamesDevice(ps, device)) return { idle: false, reason: "tool_uses_device" };
  if (device.busyHere) return { idle: false, reason: "busy_here" };
  const lastUse = Math.max(device.lastAdeActivityMs, device.lastInstallChangeMs, device.lastBootedAtMs ?? 0);
  if (context.nowMs - lastUse < SIMULATOR_RECLAIM_RECENT_USE_MS) return { idle: false, reason: "recent_use" };
  if (simulatorAppRunning(ps)) {
    if (context.simulatorAppDeviceUdid && context.simulatorAppDeviceUdid.toUpperCase() === device.udid.toUpperCase()) {
      return { idle: false, reason: "simulator_app_device" };
    }
    if (device.lastBootedAtMs === null || context.nowMs - lastUse < SIMULATOR_RECLAIM_FOREIGN_MIN_BOOTED_MS) {
      return { idle: false, reason: "simulator_app_recent_use" };
    }
  }
  if (!device.adeOwned) {
    if (device.lastBootedAtMs === null) return { idle: false, reason: "boot_time_unknown" };
    if (context.nowMs - device.lastBootedAtMs < SIMULATOR_RECLAIM_FOREIGN_MIN_BOOTED_MS) {
      return { idle: false, reason: "booted_recently" };
    }
  }
  return { idle: true };
}

/** The memory facts a shutdown names; a fact not read is null. */
export type SimulatorReclaimFacts = {
  swapUsedMb: number | null;
  simulatorMb: number | null;
};

function gb(mb: number): string {
  const value = mb / 1024;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}

/** "13 GB swap used, simulators used 20 GB", or null with no facts. */
export function simulatorReclaimFactsPhrase(facts: SimulatorReclaimFacts | null | undefined): string | null {
  if (!facts) return null;
  const parts: string[] = [];
  if (facts.swapUsedMb !== null && facts.swapUsedMb > 0) parts.push(`${gb(facts.swapUsedMb)} GB swap used`);
  if (facts.simulatorMb !== null && facts.simulatorMb > 0) parts.push(`simulators used ${gb(facts.simulatorMb)} GB`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** The warning each lane with a booted simulator gets. */
export function simulatorMemoryWarningText(args: { machineName: string; deviceName: string }): string {
  const machine = args.machineName.trim() || "this computer";
  const device = args.deviceName.trim() || "a simulator";
  return `Memory on ${machine} is low. Your lane has simulator ${device} booted. Shut it down if you do not need it now. `
    + "ADE shuts down idle simulators to keep the computer running.";
}
