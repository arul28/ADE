import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appleDeviceDataRoot, parseSimctlDevices } from "../../../../desktop/src/main/services/ios/appleSimulatorCatalog";
import {
  appleDeviceFiles,
  describeDevicePowerOff,
  type AppleDevicePowerOffRecord,
} from "../../../../desktop/src/main/services/ios/laneDeviceMaintenance";
import {
  afterSimulatorReclaimPass,
  classifySimulatorForMemoryReclaim,
  simulatorAppRunning,
  INITIAL_SIMULATOR_RECLAIM_STATE,
  nextSimulatorReclaimStep,
  simulatorMemoryPowerOffEnabled,
  simulatorMemoryReclaimSupported,
  simulatorMemoryWarningText,
  simulatorReclaimStepPossible,
  type BootedSimulator,
  type SimulatorReclaimFacts,
  type SimulatorReclaimLaneDevice,
  type SimulatorReclaimState,
  type SimulatorReclaimStep,
  type SimulatorReclaimTick,
  type SimulatorReclaimVerdict,
} from "../../../../desktop/src/main/services/ios/simulatorMemoryReclaim";
import { bareSimulatorPowerOff } from "../../../../desktop/src/main/services/ios/simulatorPower";
import { TRACKED_AGENT_CLI_TOOL_TYPES } from "../../../../desktop/src/shared/cliChildSession";
import type { TrackedAgentCliToolType } from "../../../../desktop/src/shared/types/sessions";
import { thisMachineDisplayName } from "../sync/deviceRegistryService";

/*
 * The machine brain's low-memory pass over the iOS simulators of this
 * computer (`simulatorMemoryReclaim.ts` in the Apple services holds the rules).
 *
 * It runs on the resource-pressure monitor's samples only, while an episode
 * about memory or swap is open: no timer or poll of its own. A sample that
 * could take a step costs one process listing (the simulators' memory); while
 * the simulators hold less than the mark, that listing runs at most every
 * 30 minutes. A step costs one `simctl list` and, for a shutdown pass, one
 * `ps` (again before each shutdown after the first).
 *
 * Each open project's simulator service names its lane devices and what only
 * it knows (a stream someone watches, a recording, a test). The lane's agents
 * learn of a warning or a shutdown with their next simulator command, through
 * a record in the device's own folder, whichever provider and surface they
 * run on. People see one line in the lane's open agent terminals and a notice
 * in the chat that booted the device. Nothing interrupts a turn, and nothing
 * wakes an idle session.
 */

type RunCommand = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultRun: RunCommand = async (file, args, options = {}) => {
  const result = await execFileAsync(file, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

/** A shutdown never acts on a process list or lane facts older than this. */
const RECLAIM_FACTS_MAX_AGE_MS = 10_000;

/** One open project, as the pass sees it. Every part may be missing. */
export type SimulatorReclaimScope = {
  simulator: {
    memoryReclaimLaneDevices?: () => SimulatorReclaimLaneDevice[];
    /** Its power-off record, or null when the device is not one of this project's. */
    powerOffLaneDeviceForMemory?: (udid: string, facts: SimulatorReclaimFacts) => Promise<AppleDevicePowerOffRecord | null>;
  } | null;
  chat: { recordSystemNotice?: (args: { sessionId: string; message: string }) => void } | null;
  pty: { showSessionNotice?: (sessionId: string, text: string) => boolean } | null;
  sessions: {
    list: (args: {
      laneId?: string;
      status?: "running";
      toolTypes?: TrackedAgentCliToolType[];
      includeArchived?: boolean;
      limit?: number;
    }) => Array<{ id: string }>;
  } | null;
};

/** What the episode record keeps of the pass: counts and times only. */
export type SimulatorReclaimEpisodeNote = {
  warnedAt: string | null;
  warnedDevices: number;
  reclaimedAt: string | null;
  shutDown: number;
  inUse: number;
  failed: number;
  /** The automatic shutdown is off (`ADE_APPLE_MEMORY_POWER_OFF=0`). */
  powerOffDisabled?: true;
};

export type SimulatorReclaimSample = SimulatorReclaimTick & {
  memory: { totalMb: number | null; swapUsedMb: number | null } | null;
  /** The simulators' memory, when the caller just listed the processes. */
  simulatorMb?: number | null;
  /** What the open episode keeps of the pass so far; the episode owns it. */
  note: SimulatorReclaimEpisodeNote | null;
};

export type SimulatorMemoryReclaimer = {
  /**
   * One pressure sample. Never throws. Returns the episode's next note, or
   * null when the step changed nothing.
   */
  onSample: (sample: SimulatorReclaimSample) => Promise<SimulatorReclaimEpisodeNote | null>;
};

/** One lane that holds the device: whom to tell. */
type LaneTarget = { scope: SimulatorReclaimScope; laneId: string; bootedByChat: string | null };

/**
 * A device as every open project sees it: busy if any project says so, ADE's
 * own only if every project says so, and every lane that holds it.
 */
type LaneDeviceEntry = { name: string; adeOwned: boolean; busyHere: boolean; targets: LaneTarget[] };

type InUseReason = Extract<SimulatorReclaimVerdict, { idle: false }>["reason"];

export function createSimulatorMemoryReclaimer(deps: {
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    warn: (event: string, meta?: Record<string, unknown>) => void;
  };
  run?: RunCommand;
  /** The simulators' memory now (the `ios_simulator` process group), or null. */
  readSimulatorMb: () => Promise<number | null>;
  listScopes: () => SimulatorReclaimScope[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  deviceDataRoot?: string;
}): SimulatorMemoryReclaimer {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const files = () => appleDeviceFiles(deps.deviceDataRoot ?? appleDeviceDataRoot());
  const run = deps.run ?? defaultRun;
  const barePowerOff = bareSimulatorPowerOff(run);
  let state: SimulatorReclaimState = INITIAL_SIMULATOR_RECLAIM_STATE;

  /** Show one line in each open agent terminal of the lane. Display only; the agent's input is untouched. */
  const tellLaneTerminals = (target: LaneTarget, text: string): number => {
    const sessions = target.scope.sessions;
    const show = target.scope.pty?.showSessionNotice;
    if (!sessions || !show) return 0;
    let shown = 0;
    try {
      const rows = sessions.list({
        laneId: target.laneId,
        status: "running",
        toolTypes: [...TRACKED_AGENT_CLI_TOOL_TYPES],
        includeArchived: false,
        limit: 20,
      });
      for (const row of rows) if (show(row.id, text)) shown += 1;
    } catch {
      // A line not shown; the agent still gets the record with its next command.
    }
    return shown;
  };

  const tellChat = (target: LaneTarget, text: string): number => {
    const chat = target.scope.chat;
    if (!target.bootedByChat || !chat?.recordSystemNotice) return 0;
    try {
      chat.recordSystemNotice({ sessionId: target.bootedByChat, message: text });
      return 1;
    } catch {
      return 0;
    }
  };

  /** Every lane of the device hears it: terminals and the chat that booted it. */
  const tellLanes = (entry: LaneDeviceEntry, text: string): { terminals: number; chats: number } => {
    let terminals = 0;
    let chats = 0;
    for (const target of entry.targets) {
      terminals += tellLaneTerminals(target, text);
      chats += tellChat(target, text);
    }
    return { terminals, chats };
  };

  /** The booted simulators, or null when `simctl list` could not be read. */
  const listBooted = async (): Promise<BootedSimulator[] | null> => {
    try {
      const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      return [...parseSimctlDevices(stdout).values()]
        .filter((device) => device.state === "Booted")
        .map((device) => ({ udid: device.udid, name: device.name, state: device.state, lastBootedAtMs: device.lastBootedAtMs ?? null }));
    } catch {
      return null;
    }
  };

  const laneDevicesByUdid = (): Map<string, LaneDeviceEntry> => {
    const byUdid = new Map<string, LaneDeviceEntry>();
    for (const scope of deps.listScopes()) {
      let devices: SimulatorReclaimLaneDevice[] = [];
      try {
        devices = scope.simulator?.memoryReclaimLaneDevices?.() ?? [];
      } catch {
        continue;
      }
      for (const device of devices) {
        const target: LaneTarget = { scope, laneId: device.laneId, bootedByChat: device.bootedByChat };
        const earlier = byUdid.get(device.udid);
        byUdid.set(device.udid, earlier
          ? {
            name: earlier.name || device.name,
            adeOwned: earlier.adeOwned && device.adeOwned,
            busyHere: earlier.busyHere || device.busyHere,
            targets: [...earlier.targets, target],
          }
          : { name: device.name, adeOwned: device.adeOwned, busyHere: device.busyHere, targets: [target] });
      }
    }
    return byUdid;
  };

  const warn = async (
    sample: SimulatorReclaimSample,
    booted: readonly BootedSimulator[],
  ): Promise<SimulatorReclaimEpisodeNote> => {
    const lanes = laneDevicesByUdid();
    const machineName = (await thisMachineDisplayName()) ?? "";
    let devices = 0;
    let terminals = 0;
    let chats = 0;
    const at = new Date(sample.nowMs).toISOString();
    for (const listed of booted) {
      const entry = lanes.get(listed.udid);
      // Only a lane has someone to tell; a device outside every lane is
      // judged by the strict rule at the shutdown step.
      if (!entry) continue;
      const text = simulatorMemoryWarningText({ machineName, deviceName: entry.name || listed.name });
      if (files().writeMemoryWarning(listed.udid, { at, text })) devices += 1;
      const told = tellLanes(entry, text);
      terminals += told.terminals;
      chats += told.chats;
    }
    // Counts only: an info line stays on this machine.
    deps.logger.info("ios_simulator.memory_warning_sent", {
      episodeId: sample.episodeId,
      bootedDevices: booted.length,
      warnedDevices: devices,
      terminals,
      chats,
    });
    return { ...(sample.note ?? emptyNote()), warnedAt: at, warnedDevices: devices };
  };

  /**
   * The device Simulator.app last showed: its own `CurrentDeviceUDID` setting,
   * one `defaults read`, only while Simulator.app runs. Null when unknown.
   */
  const simulatorAppDeviceUdid = async (): Promise<string | null> => {
    try {
      const { stdout } = await run("defaults", ["read", "com.apple.iphonesimulator", "CurrentDeviceUDID"], { timeoutMs: 5_000 });
      const udid = stdout.trim();
      return /^[0-9A-F-]{36}$/iu.test(udid) ? udid.toUpperCase() : null;
    } catch {
      return null;
    }
  };

  /** What a shutdown decision reads: the process list, the shown device and the lanes. */
  const readReclaimFacts = async () => {
    const psOutput = await run("ps", ["-axo", "command="], { timeoutMs: 10_000 })
      .then((result) => result.stdout)
      .catch(() => null);
    const shownUdid = psOutput !== null && simulatorAppRunning(psOutput) ? await simulatorAppDeviceUdid() : null;
    return { readAtMs: Date.now(), psOutput, shownUdid, lanes: laneDevicesByUdid() };
  };

  /** Shut one device down: through a lane's own service when one holds it, else directly. Its record, or null when it was already off. */
  const powerOff = async (
    listed: BootedSimulator,
    entry: LaneDeviceEntry | undefined,
    facts: SimulatorReclaimFacts,
    nowMs: number,
  ): Promise<AppleDevicePowerOffRecord | null> => {
    for (const target of entry?.targets ?? []) {
      const record = await target.scope.simulator?.powerOffLaneDeviceForMemory?.(listed.udid, facts);
      if (record) return record;
    }
    // False: it was already off (someone else shut it down first).
    if (!(await barePowerOff(listed.udid))) return null;
    return files().recordMemoryPowerOff(listed.udid, { nowMs, name: listed.name, facts });
  };

  /** One shutdown pass. */
  const reclaim = async (
    sample: SimulatorReclaimSample,
    booted: readonly BootedSimulator[],
    facts: SimulatorReclaimFacts,
  ): Promise<{ note: SimulatorReclaimEpisodeNote; shutDown: number; powerOffDisabled?: true }> => {
    const nowMs = sample.nowMs;
    const at = new Date(nowMs).toISOString();
    const earlier = sample.note ?? emptyNote();
    if (!simulatorMemoryPowerOffEnabled(env)) {
      deps.logger.info("ios_simulator.reclaimed_for_memory", {
        episodeId: sample.episodeId,
        bootedDevices: booted.length,
        shutDown: 0,
        powerOffDisabled: true,
      });
      return {
        note: { ...earlier, reclaimedAt: at, inUse: booted.length, powerOffDisabled: true },
        shutDown: 0,
        powerOffDisabled: true,
      };
    }
    let current = await readReclaimFacts();
    let attemptsSinceRead = 0;
    let shutDown = 0;
    let failed = 0;
    let alreadyOff = 0;
    const inUse: Partial<Record<InUseReason, number>> = {};
    for (const listed of booted) {
      // Each shutdown after the first, and any decision on old facts, reads them again.
      if (attemptsSinceRead > 0 || Date.now() - current.readAtMs > RECLAIM_FACTS_MAX_AGE_MS) {
        current = await readReclaimFacts();
        attemptsSinceRead = 0;
      }
      const entry = current.lanes.get(listed.udid);
      const verdict = classifySimulatorForMemoryReclaim({
        ...listed,
        adeOwned: entry?.adeOwned ?? false,
        busyHere: entry?.busyHere ?? false,
        lastAdeActivityMs: files().lastActivityMs(listed.udid),
        lastInstallChangeMs: files().lastInstallChangeMs(listed.udid),
      }, { nowMs, psOutput: current.psOutput, simulatorAppDeviceUdid: current.shownUdid });
      if (!verdict.idle) {
        inUse[verdict.reason] = (inUse[verdict.reason] ?? 0) + 1;
        continue;
      }
      attemptsSinceRead += 1;
      try {
        const record = await powerOff(listed, entry, facts, nowMs);
        if (!record) {
          alreadyOff += 1;
          continue;
        }
        shutDown += 1;
        if (entry) tellLanes(entry, describeDevicePowerOff(record, entry.name || listed.name, "boot it again when needed.", nowMs));
      } catch (error) {
        failed += 1;
        deps.logger.warn("ios_simulator.reclaim_for_memory_failed", {
          udid: listed.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const inUseCount = Object.values(inUse).reduce((sum, count) => sum + (count ?? 0), 0);
    deps.logger.info("ios_simulator.reclaimed_for_memory", {
      episodeId: sample.episodeId,
      bootedDevices: booted.length,
      shutDown,
      failed,
      alreadyOff,
      inUse: inUseCount,
      ...Object.fromEntries(Object.entries(inUse).map(([reason, count]) => [`inUse_${reason}`, count])),
      swapUsedMb: facts.swapUsedMb,
      simulatorMb: facts.simulatorMb,
    });
    return {
      note: { ...earlier, reclaimedAt: at, shutDown: earlier.shutDown + shutDown, inUse: inUseCount, failed },
      shutDown,
    };
  };

  return {
    onSample: async (sample) => {
      if (!simulatorMemoryReclaimSupported(platform)) return null;
      let step: SimulatorReclaimStep = "none";
      try {
        if (!simulatorReclaimStepPossible(state, sample)) return null;
        const simulatorMb = sample.simulatorMb !== undefined ? sample.simulatorMb : await deps.readSimulatorMb().catch(() => null);
        const decision = nextSimulatorReclaimStep(state, { ...sample, simulatorMb, totalMb: sample.memory?.totalMb ?? null });
        step = decision.step;
        if (decision.step === "none") {
          state = decision.state;
          return null;
        }
        const booted = await listBooted();
        if (booted === null) {
          // The state stays as it was, so the next sample tries the step again.
          deps.logger.warn("ios_simulator.memory_reclaim_failed", {
            step,
            error: "The simulator list could not be read.",
          });
          return null;
        }
        if (decision.step === "warn") {
          // Nobody to warn: the state stays, so the warning still comes first.
          if (booted.length === 0) return null;
          const note = await warn(sample, booted);
          state = decision.state;
          return note;
        }
        state = decision.state;
        if (booted.length === 0) return null;
        const pass = await reclaim(sample, booted, { swapUsedMb: sample.memory?.swapUsedMb ?? null, simulatorMb });
        // The cooldown starts only after a pass that shut something down.
        state = afterSimulatorReclaimPass(state, {
          nowMs: sample.nowMs,
          shutDown: pass.shutDown,
          powerOffDisabled: pass.powerOffDisabled,
        });
        return pass.note;
      } catch (error) {
        deps.logger.warn("ios_simulator.memory_reclaim_failed", {
          step,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}

function emptyNote(): SimulatorReclaimEpisodeNote {
  return { warnedAt: null, warnedDevices: 0, reclaimedAt: null, shutDown: 0, inUse: 0, failed: 0 };
}
