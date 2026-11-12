/**
 * Contract C3: a lane follows its computer.
 *
 * A cloud lane keeps its lane id and its chats keep their chat ids for life.
 * The computer under it can change (a move to another size, a new computer
 * after a refused one); then only the machine key changes. Callers ask for
 * the lane's computer by lane id, never by a saved machine key, and listen
 * for `LaneMovedEvent` to re-point what they hold (a chat's pin, the Android
 * panel, tools).
 *
 * The facts come from the account's cloud computer list (each computer's
 * metadata names its lane), which ADE already reads; following a lane adds no
 * repeated server call.
 */

import type { CloudMachineState } from "./adeCloud";
import type { CloudLaneMachine, CloudMachineLaneFacts } from "./cloudLaneLaunch";
import type { MachineAddress } from "./machineAddress";

/** The computer a cloud lane runs on now. */
export type LaneComputer = CloudMachineLaneFacts & {
  instanceId: string;
  /** The computer's account machine key; null until it has joined the account. */
  machineKey: string | null;
  state: CloudMachineState;
};

/** A lane's computer changed: same lane, same chats, another computer. */
export type LaneMovedEvent = {
  laneId: string;
  laneName: string;
  from: { instanceId: string; machineKey: string | null } | null;
  to: { instanceId: string; machineKey: string | null };
  /** ISO time this computer noticed the change. */
  at: string;
};

/** `window.ade.cloud.followLane`: the lane's computer now, and an address for it when it could be reached. */
export type LaneFollowResult =
  | { ok: true; computer: LaneComputer; address: MachineAddress }
  | { ok: false; reason: "no_lane" | "joining" | "unreachable" | "unreadable"; computer: LaneComputer | null; message: string };

/** One of the account's cloud computers, as far as following a lane needs it. */
export type LaneComputerSource = Pick<CloudLaneMachine, "instanceId" | "machineKey" | "state" | "lane"> & {
  createdAtMs?: number | null;
  /**
   * The computer this one was made to replace or copy (`ade_moved_from`,
   * `ade_copied_from`). While that one is still listed, the lane stays there:
   * a move's new computer holds the lane's facts before its files arrive.
   */
  replacesInstanceId?: string | null;
};

/**
 * The lane computers in a list of the account's cloud computers, one per
 * lane. While a move is under way the lane stays on the old computer; after
 * it, on the new one. Between two computers that both claim a lane, the one
 * that has joined the account wins, then the newer one.
 */
export function laneComputersOf(machines: readonly LaneComputerSource[]): LaneComputer[] {
  const listed = new Set(machines.filter((machine) => machine.state !== "deleting").map((machine) => machine.instanceId));
  const byLane = new Map<string, { computer: LaneComputer; createdAtMs: number }>();
  for (const machine of machines) {
    if (!machine.lane || machine.state === "deleting") continue;
    if (machine.replacesInstanceId && machine.replacesInstanceId !== machine.instanceId && listed.has(machine.replacesInstanceId)) continue;
    const computer: LaneComputer = {
      ...machine.lane,
      instanceId: machine.instanceId,
      machineKey: machine.machineKey ?? null,
      state: machine.state,
    };
    const createdAtMs = machine.createdAtMs ?? 0;
    const current = byLane.get(computer.laneId);
    if (
      !current
      || (computer.machineKey && !current.computer.machineKey)
      || (Boolean(computer.machineKey) === Boolean(current.computer.machineKey) && createdAtMs > current.createdAtMs)
    ) byLane.set(computer.laneId, { computer, createdAtMs });
  }
  return [...byLane.values()].map((entry) => entry.computer);
}

/**
 * The lanes whose computer changed between two reads. A lane that is new in
 * `next` is not a move; a lane missing from `next` is not one either (its
 * computer was freed or deleted, which the lane list shows on its own).
 */
export function laneComputerMoves(
  previous: readonly LaneComputer[],
  next: readonly LaneComputer[],
  at: string,
): LaneMovedEvent[] {
  const before = new Map(previous.map((computer) => [computer.laneId, computer]));
  const moves: LaneMovedEvent[] = [];
  for (const computer of next) {
    const old = before.get(computer.laneId);
    if (!old || old.instanceId === computer.instanceId) continue;
    moves.push({
      laneId: computer.laneId,
      laneName: computer.laneName,
      from: { instanceId: old.instanceId, machineKey: old.machineKey },
      to: { instanceId: computer.instanceId, machineKey: computer.machineKey },
      at,
    });
  }
  return moves;
}
