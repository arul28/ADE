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
  parseSavedLaneComputers,
  savedLaneComputerRows,
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
const FRESH_READ_MS = 30_000;

export type LaneFollowerDeps = {
  /** A fresh read of the account's cloud computers; it reaches `note` through `cloudMachines`. False when it can't be read. */
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

function laneComputerSourceOf(instance: CloudInstance): LaneComputerSource {
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
    return parseSavedLaneComputers(safeJsonParse<unknown>(fs.readFileSync(statePath, "utf8"), null));
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

  /** The rows last written, so an unchanged read writes nothing. */
  let savedRows: string | null = null;
  const save = (computers: readonly LaneComputer[]): void => {
    const rows = savedLaneComputerRows(computers);
    if (rows === savedRows) return;
    try {
      writeTextAtomic(deps.statePath, rows);
      savedRows = rows;
    } catch (error) {
      deps.logger?.warn?.("cloud.lane_follow_save_failed", { error: getErrorMessage(error) });
    }
  };

  /**
   * Moves whose new computer hasn't joined the account yet (no machine key):
   * by lane id. They finish when that computer gets its key.
   */
  const pendingMoves = new Map<string, LaneMovedEvent>();

  /**
   * A lane's computer changed. The old computer's connections are forgotten,
   * and pins to it redirected, only once it is really gone: a copy or a
   * refused computer that still runs keeps its connection.
   */
  const onMoved = (move: LaneMovedEvent, liveInstanceIds: ReadonlySet<string>): void => {
    deps.logger?.info?.("cloud.lane_moved", { laneId: move.laneId, from: move.from?.instanceId ?? null, to: move.to.instanceId });
    if (move.from && !liveInstanceIds.has(move.from.instanceId)) {
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
    const live = instances.filter((instance) => instance.status !== "deleted");
    const liveInstanceIds = new Set(live.filter((instance) => cloudMachineState(instance.status) !== "deleting").map((instance) => instance.id));
    const computers = laneComputersOf(live.map(laneComputerSourceOf));
    const previous = baseline();
    const at = new Date(now()).toISOString();
    const moves = laneComputerMoves(previous, computers, at);
    // Lanes a read left out keep their last computer: one read that missed a
    // lane must not turn its next appearance into a move from nowhere.
    const listedLanes = new Set(computers.map((computer) => computer.laneId));
    const listedInstances = new Set(instances.map((instance) => instance.id));
    const kept = previous.filter((computer) => !listedLanes.has(computer.laneId) && listedInstances.has(computer.instanceId));
    known = [...computers, ...kept];
    lastNoteAtMs = now();
    save(known);
    for (const move of moves) {
      // A new computer that hasn't joined yet: finish the move once it has a key.
      if (!move.to.machineKey) {
        pendingMoves.set(move.laneId, move);
        deps.emit(move);
        continue;
      }
      pendingMoves.delete(move.laneId);
      onMoved(move, liveInstanceIds);
    }
    for (const [laneId, pending] of pendingMoves) {
      const laneNow = computers.find((computer) => computer.laneId === laneId);
      if (!laneNow || laneNow.instanceId !== pending.to.instanceId) {
        // The lane went elsewhere (or away) before that computer joined.
        if (!laneNow) pendingMoves.delete(laneId);
        continue;
      }
      if (!laneNow.machineKey) continue;
      pendingMoves.delete(laneId);
      onMoved({ ...pending, to: { instanceId: laneNow.instanceId, machineKey: laneNow.machineKey }, at }, liveInstanceIds);
    }
  };

  /** The lane's computer, and whether ADE could read the account's computers at all. */
  const lookup = async (laneId: string): Promise<{ computer: LaneComputer | null; unreadable: boolean }> => {
    const id = laneId.trim();
    if (!id) return { computer: null, unreadable: false };
    if (now() - lastNoteAtMs > FRESH_READ_MS) {
      const read = await deps.readNow().catch(() => false);
      const computer = baseline().find((entry) => entry.laneId === id) ?? null;
      // A failed read that knows nothing of the lane can't tell "no computer" from "can't say".
      if (!read && !computer) return { computer: null, unreadable: true };
      return { computer, unreadable: false };
    }
    return { computer: baseline().find((computer) => computer.laneId === id) ?? null, unreadable: false };
  };

  const laneComputer = async (laneId: string): Promise<LaneComputer | null> => (await lookup(laneId)).computer;

  const follow = async (laneId: string, options?: { connect?: boolean }): Promise<LaneFollowResult> => {
    const { computer, unreadable } = await lookup(laneId);
    if (unreadable) return { ok: false, reason: "unreadable", computer: null, message: "ADE couldn't read your cloud computers. Try again in a moment." };
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
