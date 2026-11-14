import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { appleDeviceDataRoot, parseSimctlDevices } from "../../../../desktop/src/main/services/ios/appleSimulatorCatalog";
import {
  appleDeviceFiles,
  describeDevicePowerOff,
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
  type SimulatorReclaimFacts,
  type SimulatorReclaimState,
  type SimulatorReclaimVerdict,
} from "../../../../desktop/src/main/services/ios/simulatorMemoryReclaim";
import { bareSimulatorPowerOff } from "../../../../desktop/src/main/services/ios/simulatorPower";
import { TRACKED_AGENT_CLI_TOOL_TYPES } from "../../../../desktop/src/shared/cliChildSession";
import type { TrackedAgentCliToolType } from "../../../../desktop/src/shared/types/sessions";

/*
 * The machine brain's low-memory pass over the iOS simulators of this
 * computer (`simulatorMemoryReclaim.ts` in the Apple services holds the rules).
 *
 * It runs on the resource-pressure monitor's samples only, while an episode
 * about memory or swap is open: no timer or poll of its own. A sample that
 * could take a step costs one process listing (the simulators' memory); a
 * step costs one `simctl list` and, for a shutdown, one `ps`.
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

/** One open project, as the pass sees it. Every part may be missing. */
export type SimulatorReclaimScope = {
  simulator: {
    memoryReclaimLaneDevices?: () => Array<{
      udid: string;
      name: string;
      laneId: string;
      extra: boolean;
      adeOwned: boolean;
      busyHere: boolean;
      bootedByChat: string | null;
    }>;
    powerOffLaneDeviceForMemory?: (udid: string, facts: SimulatorReclaimFacts) => Promise<boolean>;
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

export type SimulatorReclaimSample = {
  nowMs: number;
  episodeId: string | null;
  breach: { kinds: readonly string[]; severity: "warn" | "critical" } | null;
  memory: { totalMb: number | null; swapUsedMb: number | null } | null;
  /** The simulators' memory, when the caller just listed the processes. */
  simulatorMb?: number | null;
};

export type SimulatorMemoryReclaimer = {
  /** One pressure sample. Never throws. Null when it took no step. */
  onSample: (sample: SimulatorReclaimSample) => Promise<SimulatorReclaimEpisodeNote | null>;
};

export function createSimulatorMemoryReclaimer(deps: {
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    warn: (event: string, meta?: Record<string, unknown>) => void;
  };
  run?: RunCommand;
  /** The simulators' memory now (the `ios_simulator` process group), or null. */
  readSimulatorMb: () => Promise<number | null>;
  listScopes: () => SimulatorReclaimScope[];
  machineName?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  deviceDataRoot?: string;
}): SimulatorMemoryReclaimer {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const machineName = deps.machineName ?? (() => os.hostname().replace(/\.local$/iu, "").trim());
  const files = () => appleDeviceFiles(deps.deviceDataRoot ?? appleDeviceDataRoot());
  const run = deps.run ?? defaultRun;
  const barePowerOff = bareSimulatorPowerOff(run);
  let state: SimulatorReclaimState = INITIAL_SIMULATOR_RECLAIM_STATE;
  let note: SimulatorReclaimEpisodeNote | null = null;

  /** Show one line in each open agent terminal of the lane. Display only; the agent's input is untouched. */
  const tellLaneTerminals = (scope: SimulatorReclaimScope, laneId: string, text: string): number => {
    const sessions = scope.sessions;
    const show = scope.pty?.showSessionNotice;
    if (!sessions || !show) return 0;
    let shown = 0;
    try {
      const rows = sessions.list({
        laneId,
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

  const tellChat = (scope: SimulatorReclaimScope, chatSessionId: string | null, text: string): number => {
    if (!chatSessionId || !scope.chat?.recordSystemNotice) return 0;
    try {
      scope.chat.recordSystemNotice({ sessionId: chatSessionId, message: text });
      return 1;
    } catch {
      return 0;
    }
  };

  const listBooted = async (): Promise<Array<{ udid: string; name: string; state: string; lastBootedAtMs: number | null }> | null> => {
    try {
      const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      return [...parseSimctlDevices(stdout).values()]
        .filter((device) => device.state === "Booted")
        .map((device) => ({ udid: device.udid, name: device.name, state: device.state, lastBootedAtMs: device.lastBootedAtMs ?? null }));
    } catch {
      return null;
    }
  };

  type LaneDeviceEntry = {
    scope: SimulatorReclaimScope;
    device: ReturnType<NonNullable<NonNullable<SimulatorReclaimScope["simulator"]>["memoryReclaimLaneDevices"]>>[number];
  };
  const laneDevicesByUdid = (): Map<string, LaneDeviceEntry> => {
    const byUdid = new Map<string, LaneDeviceEntry>();
    for (const scope of deps.listScopes()) {
      let devices: LaneDeviceEntry["device"][] = [];
      try {
        devices = scope.simulator?.memoryReclaimLaneDevices?.() ?? [];
      } catch {
        continue;
      }
      for (const device of devices) if (!byUdid.has(device.udid)) byUdid.set(device.udid, { scope, device });
    }
    return byUdid;
  };

  const warn = async (nowMs: number, booted: NonNullable<Awaited<ReturnType<typeof listBooted>>>): Promise<void> => {
    const lanes = laneDevicesByUdid();
    let devices = 0;
    let terminals = 0;
    let chats = 0;
    const at = new Date(nowMs).toISOString();
    for (const listed of booted) {
      const entry = lanes.get(listed.udid);
      // Only a lane has someone to tell; a device outside every lane is
      // judged by the strict rule at the shutdown step.
      if (!entry) continue;
      const text = simulatorMemoryWarningText({ machineName: machineName(), deviceName: entry.device.name || listed.name });
      if (files().writeMemoryWarning(listed.udid, { at, text })) devices += 1;
      terminals += tellLaneTerminals(entry.scope, entry.device.laneId, text);
      chats += tellChat(entry.scope, entry.device.bootedByChat, text);
    }
    note = { ...(note ?? emptyNote()), warnedAt: at, warnedDevices: devices };
    // Counts only: an info line stays on this machine.
    deps.logger.info("ios_simulator.memory_warning_sent", {
      episodeId: state.episodeId,
      bootedDevices: booted.length,
      warnedDevices: devices,
      terminals,
      chats,
    });
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

  /** One shutdown pass. Returns how many devices it shut down. */
  const reclaim = async (
    nowMs: number,
    booted: NonNullable<Awaited<ReturnType<typeof listBooted>>>,
    facts: SimulatorReclaimFacts,
  ): Promise<{ shutDown: number; powerOffDisabled?: true }> => {
    const at = new Date(nowMs).toISOString();
    if (!simulatorMemoryPowerOffEnabled(env)) {
      note = { ...(note ?? emptyNote()), reclaimedAt: at, inUse: booted.length, powerOffDisabled: true };
      deps.logger.info("ios_simulator.reclaimed_for_memory", {
        episodeId: state.episodeId,
        bootedDevices: booted.length,
        shutDown: 0,
        powerOffDisabled: true,
      });
      return { shutDown: 0, powerOffDisabled: true };
    }
    const psOutput = await run("ps", ["-axo", "command="], { timeoutMs: 10_000 })
      .then((result) => result.stdout)
      .catch(() => null);
    const shownUdid = psOutput !== null && simulatorAppRunning(psOutput) ? await simulatorAppDeviceUdid() : null;
    const lanes = laneDevicesByUdid();
    let shutDown = 0;
    let failed = 0;
    let alreadyOff = 0;
    const inUse: Partial<Record<Exclude<SimulatorReclaimVerdict, { idle: true }>["reason"], number>> = {};
    for (const listed of booted) {
      const entry = lanes.get(listed.udid);
      const verdict = classifySimulatorForMemoryReclaim({
        udid: listed.udid,
        name: listed.name,
        state: listed.state,
        lastBootedAtMs: listed.lastBootedAtMs,
        adeOwned: entry?.device.adeOwned ?? false,
        busyHere: entry?.device.busyHere ?? false,
        lastAdeActivityMs: files().lastActivityMs(listed.udid),
        lastInstallChangeMs: files().lastInstallChangeMs(listed.udid),
      }, { nowMs, psOutput, simulatorAppDeviceUdid: shownUdid });
      if (!verdict.idle) {
        inUse[verdict.reason] = (inUse[verdict.reason] ?? 0) + 1;
        continue;
      }
      try {
        const viaLane = entry?.scope.simulator?.powerOffLaneDeviceForMemory
          ? await entry.scope.simulator.powerOffLaneDeviceForMemory(listed.udid, facts)
          : false;
        if (!viaLane) {
          // False: it was already off (someone else shut it down first).
          if (!(await barePowerOff(listed.udid))) {
            alreadyOff += 1;
            continue;
          }
          files().writePowerOff(listed.udid, {
            at,
            reason: "memory",
            idleMinutes: 0,
            name: listed.name,
            facts,
          });
        }
        // The shutdown is the news now; the warning before it is not.
        files().clearMemoryWarning(listed.udid);
        shutDown += 1;
        if (entry) {
          const record = { at, reason: "memory" as const, idleMinutes: 0, name: listed.name, facts };
          const text = describeDevicePowerOff(record, entry.device.name || listed.name, "boot it again when needed.", nowMs);
          tellLaneTerminals(entry.scope, entry.device.laneId, text);
          tellChat(entry.scope, entry.device.bootedByChat, text);
        }
      } catch (error) {
        failed += 1;
        deps.logger.warn("ios_simulator.reclaim_for_memory_failed", {
          udid: listed.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const inUseCount = Object.values(inUse).reduce((sum, count) => sum + (count ?? 0), 0);
    note = { ...(note ?? emptyNote()), reclaimedAt: at, shutDown: (note?.shutDown ?? 0) + shutDown, inUse: inUseCount, failed };
    deps.logger.info("ios_simulator.reclaimed_for_memory", {
      episodeId: state.episodeId,
      bootedDevices: booted.length,
      shutDown,
      failed,
      alreadyOff,
      inUse: inUseCount,
      ...Object.fromEntries(Object.entries(inUse).map(([reason, count]) => [`inUse_${reason}`, count])),
      swapUsedMb: facts.swapUsedMb,
      simulatorMb: facts.simulatorMb,
    });
    return { shutDown };
  };

  return {
    onSample: async (sample) => {
      if (!simulatorMemoryReclaimSupported(platform)) return null;
      try {
        if (state.episodeId !== sample.episodeId) note = null;
        if (!simulatorReclaimStepPossible(state, sample)) return null;
        const simulatorMb = sample.simulatorMb !== undefined ? sample.simulatorMb : await deps.readSimulatorMb().catch(() => null);
        const decision = nextSimulatorReclaimStep(state, { ...sample, simulatorMb, totalMb: sample.memory?.totalMb ?? null });
        state = decision.state;
        if (decision.step === "none") return null;
        const booted = await listBooted();
        if (!booted || booted.length === 0) return null;
        if (decision.step === "warn") {
          await warn(sample.nowMs, booted);
        } else {
          const pass = await reclaim(sample.nowMs, booted, { swapUsedMb: sample.memory?.swapUsedMb ?? null, simulatorMb });
          // The cooldown starts only after a pass that shut something down.
          state = afterSimulatorReclaimPass(state, { nowMs: sample.nowMs, ...pass });
        }
        return note ? { ...note } : null;
      } catch (error) {
        deps.logger.warn("ios_simulator.memory_reclaim_failed", {
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
