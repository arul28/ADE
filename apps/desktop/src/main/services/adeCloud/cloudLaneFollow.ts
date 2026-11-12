/**
 * Contract C3 in the main process: a lane follows its computer.
 *
 * The lane id and its chat ids stay; the computer under the lane can change
 * (a move to another size, a computer made again). This module answers
 * "which computer is lane X on now" from the account's cloud computer list
 * that ADE already reads (`cloudMachines.ts` hands every good read here), and
 * says when a lane's computer changed, so every window can re-point what it
 * holds for that lane.
 *
 * It adds no repeated server call. A fresh read happens only when a caller
 * asks for a lane and the last read is older than `FRESH_READ_MS`.
 *
 * On a move this computer:
 * - forgets its saved connection to the old computer (deleted by then), and
 * - pairs with the new one without opening the connection, so the next send
 *   finds it saved (contract C2) and a sleeping computer is not woken here.
 */

import fs from "node:fs";
import { cloudMachineState } from "../../../shared/adeCloud";
import { cloudMachineLaneFactsOf } from "../../../shared/cloudLaneLaunch";
import {
  laneComputerMoves,
  laneComputersOf,
  type LaneComputer,
  type LaneComputerSource,
  type LaneFollowResult,
  type LaneMovedEvent,
} from "../../../shared/laneComputer";
import type { MachineConnector } from "../machines/machineConnector";
import { redirectGoneTargets } from "../machines/goneTargets";
import { getErrorMessage, safeJsonParse, writeTextAtomic } from "../shared/utils";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import type { CloudInstance } from "./cloudProvider";

/** A read this recent answers a lane question without another read. */
export const FRESH_READ_MS = 30_000;

export type LaneFollowerDeps = {
  /** A fresh read of the account's cloud computers; it reaches `note` through `cloudMachines`. Null when it can't be read. */
  readNow: () => Promise<boolean>;
  connector: () => MachineConnector | null;
  /** Removes this computer's saved connections to a computer that is gone. */
  forgetMachine: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** Where the last lane-to-computer list is kept, so a move made while this app was closed is still noticed. */
  statePath: string;
  emit: (event: LaneMovedEvent) => void;
  logger?: {
    info?: (event: string, meta?: Record<string, unknown>) => void;
    warn?: (event: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
};

export type LaneFollower = {
  /** Every good read of the account's computers. */
  note(instances: readonly CloudInstance[]): void;
  /** The lane's computer now, or null when no computer holds the lane. */
  laneComputer(laneId: string): Promise<LaneComputer | null>;
  /** The lane's computer and an address for it (pairing and connecting, which wakes it). */
  follow(laneId: string, options?: { connect?: boolean }): Promise<LaneFollowResult>;
};

export function laneComputerSourceOf(instance: CloudInstance): LaneComputerSource {
  return {
    instanceId: instance.id,
    machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
    state: cloudMachineState(instance.status),
    lane: cloudMachineLaneFactsOf(instance.metadata),
    createdAtMs: instance.created != null ? instance.created * 1000 : null,
    replacesInstanceId: instance.metadata.ade_moved_from ?? instance.metadata.ade_copied_from ?? null,
  };
}

function readSaved(statePath: string): LaneComputer[] {
  try {
    const parsed = safeJsonParse<unknown>(fs.readFileSync(statePath, "utf8"), null);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row): LaneComputer[] => {
      if (!row || typeof row !== "object") return [];
      const value = row as Record<string, unknown>;
      if (typeof value.laneId !== "string" || typeof value.instanceId !== "string") return [];
      return [{
        laneId: value.laneId,
        laneName: typeof value.laneName === "string" ? value.laneName : "",
        projectOrigin: typeof value.projectOrigin === "string" ? value.projectOrigin : null,
        instanceId: value.instanceId,
        machineKey: typeof value.machineKey === "string" ? value.machineKey : null,
        // Old: never says awake.
        state: "asleep",
      }];
    });
  } catch {
    return [];
  }
}

export function createLaneFollower(deps: LaneFollowerDeps): LaneFollower {
  const now = deps.now ?? (() => Date.now());
  let known: LaneComputer[] | null = null;
  let lastNoteAtMs = Number.NEGATIVE_INFINITY;

  const baseline = (): LaneComputer[] => {
    known ??= readSaved(deps.statePath);
    return known;
  };

  const save = (computers: readonly LaneComputer[]): void => {
    try {
      const rows = computers.map(({ laneId, laneName, projectOrigin, instanceId, machineKey }) => ({ laneId, laneName, projectOrigin, instanceId, machineKey }));
      writeTextAtomic(deps.statePath, JSON.stringify(rows));
    } catch (error) {
      deps.logger?.warn?.("cloud.lane_follow_save_failed", { error: getErrorMessage(error) });
    }
  };

  const onMoved = (move: LaneMovedEvent): void => {
    deps.logger?.info?.("cloud.lane_moved", { laneId: move.laneId, from: move.from?.instanceId ?? null, to: move.to.instanceId });
    if (move.from) {
      try {
        deps.forgetMachine({ machineKey: move.from.machineKey, instanceId: move.from.instanceId });
      } catch (error) {
        deps.logger?.warn?.("cloud.lane_follow_forget_failed", { error: getErrorMessage(error) });
      }
      // Pins that reached the old computer (a chat, its tools) now reach the new one.
      redirectGoneTargets(move.from.machineKey, move.to.machineKey);
    }
    deps.emit(move);
    const key = move.to.machineKey;
    const connector = deps.connector();
    if (key && connector) {
      void connector.connect(key, { connect: false }).then((result) => {
        if (!result.ok) deps.logger?.info?.("cloud.lane_follow_pair_later", { laneId: move.laneId, reason: result.reason });
      });
    }
  };

  const note = (instances: readonly CloudInstance[]): void => {
    const computers = laneComputersOf(instances.filter((instance) => instance.status !== "deleted").map(laneComputerSourceOf));
    const previous = baseline();
    const moves = laneComputerMoves(previous, computers, new Date(now()).toISOString());
    // Lanes a read left out keep their last computer: one read that missed a
    // lane must not turn its next appearance into a move from nowhere.
    const listedLanes = new Set(computers.map((computer) => computer.laneId));
    const listedInstances = new Set(instances.map((instance) => instance.id));
    const kept = previous.filter((computer) => !listedLanes.has(computer.laneId) && listedInstances.has(computer.instanceId));
    known = [...computers, ...kept];
    lastNoteAtMs = now();
    const changed = moves.length > 0
      || previous.length !== known.length
      || known.some((computer) => {
        const old = previous.find((entry) => entry.laneId === computer.laneId);
        return !old || old.instanceId !== computer.instanceId || old.machineKey !== computer.machineKey || old.laneName !== computer.laneName;
      });
    if (changed) save(known);
    for (const move of moves) onMoved(move);
  };

  const laneComputer = async (laneId: string): Promise<LaneComputer | null> => {
    const id = laneId.trim();
    if (!id) return null;
    if (now() - lastNoteAtMs > FRESH_READ_MS) {
      const read = await deps.readNow().catch(() => false);
      if (!read && known == null) return null;
    }
    return baseline().find((computer) => computer.laneId === id) ?? null;
  };

  const follow = async (laneId: string, options?: { connect?: boolean }): Promise<LaneFollowResult> => {
    let computer: LaneComputer | null;
    try {
      computer = await laneComputer(laneId);
    } catch (error) {
      return { ok: false, reason: "unreadable", computer: null, message: `ADE couldn't read your cloud computers: ${getErrorMessage(error)}` };
    }
    if (!computer) return { ok: false, reason: "no_lane", computer: null, message: "This lane has no cloud computer right now." };
    if (!computer.machineKey) {
      return { ok: false, reason: "joining", computer, message: `${computer.laneName || "The lane"}'s computer is still joining your account.` };
    }
    const connector = deps.connector();
    if (!connector) return { ok: false, reason: "unreachable", computer, message: "ADE isn't ready to reach your computers yet. Try again in a moment." };
    const result = await connector.connect(computer.machineKey, { connect: options?.connect !== false });
    if (!result.ok) return { ok: false, reason: "unreachable", computer, message: result.message };
    return { ok: true, computer, address: result.address };
  };

  return { note, laneComputer, follow };
}
