import type { LaneSummary, TerminalSessionSummary } from "../../shared/types";
import { savedChatsMachineKey } from "../../shared/cloudSavedChats";
import { machineIdOfSlot } from "../../shared/machineIdentity";
import type { CrossMachineMachineLanes } from "./appStore";
import {
  adeCloudLaneComputerForMachine,
  isAdeCloudLaneComputerMachine,
  type AdeCloudComputerId,
  type AdeCloudLaneComputer,
} from "./adeCloudLaneIndex";
import { isCloudConnectionTarget, isSavedChatsMachineId } from "./cloudSavedChats";

/**
 * Which machine shows each session when several report it. A machine that
 * reports the session itself (live) owns it over a machine that only holds a
 * saved copy: after a move, the new computer lists the same chats (same ids)
 * as the old computer's saved copies, and the row must send to the new one.
 * Between two live reports, or two saved copies, the first entry in order
 * owns it.
 *
 * `claimed` holds ids another list already shows; they are skipped. With a
 * `laneFilter`, a session counts only on a lane that filter accepts for its
 * entry. Returns the claims in order, live first, then saved.
 */
export function claimSessionsLiveFirst<E extends { sessions: readonly TerminalSessionSummary[] }>(
  entries: readonly E[],
  options: {
    claimed?: Iterable<string>;
    laneFilter?: (entry: E, laneId: string) => boolean;
  } = {},
): Array<{ entry: E; session: TerminalSessionSummary }> {
  const claimed = new Set(options.claimed ?? []);
  const claims: Array<{ entry: E; session: TerminalSessionSummary }> = [];
  for (const savedPass of [false, true]) {
    for (const entry of entries) {
      for (const session of entry.sessions) {
        if ((session.cloudSavedCopy === true) !== savedPass) continue;
        if (options.laneFilter) {
          const laneId = session.laneId;
          if (!laneId || !options.laneFilter(entry, laneId)) continue;
        }
        if (claimed.has(session.id)) continue;
        claimed.add(session.id);
        claims.push({ entry, session });
      }
    }
  }
  return claims;
}

/**
 * An ADE Cloud computer that is not connected here and still exists: asleep,
 * stopped, or never connected in this window. Its work is listed as normal
 * rows, and opening one wakes the computer. Four signs, any one is enough:
 * a `cloud-saved:` slice, a connection the saved chats list names, a saved
 * chat copy, or a machine the ADE Cloud lane index knows. A deleted computer (`computerGone`) is never resting.
 *
 * A React caller passes the index it subscribes to (`useAdeCloudLaneComputers`)
 * so its memo runs again when the index fills after the entries.
 */
export function machineIsCloudResting(
  entry: Pick<CrossMachineMachineLanes, "machineId" | "online" | "sessions" | "computerGone" | "binding">,
  cloudLaneComputers?: readonly AdeCloudLaneComputer[],
): boolean {
  if (entry.online || entry.computerGone === true) return false;
  if (isSavedChatsMachineId(entry.machineId)) return true;
  // A cloud computer's connection whose rows just dimmed: listed at once, its
  // saved copies replace the rows when the saved chats read lands.
  if (isCloudConnectionTarget(entry.machineId)) return true;
  if (entry.sessions.some((session) => session.cloudSavedCopy === true)) return true;
  const hostname = entry.binding?.kind === "remote" ? entry.binding.hostname ?? null : null;
  return adeCloudLaneComputerForMachine({ hostname, targetId: entry.machineId }, cloudLaneComputers) != null;
}

/**
 * A machine's lanes as the lane lists show them. An ADE Cloud lane computer
 * exists for its one lane, so its main checkout (only the clone the lane came
 * from) is left out: connected, asleep (`cloud-saved:` slice, or a
 * connection's slice that kept its last read), or read before the lane index
 * knew it. Every other machine keeps its main checkout. Decided when the list
 * is built, not when the lanes were read, so a slice read before the index
 * filled, or kept while its computer sleeps, can't list it either.
 *
 * A React caller passes the index it subscribes to, so its memo follows it.
 */
export function listedLanesOfMachine(
  entry: Pick<CrossMachineMachineLanes, "machineId" | "targetId" | "binding" | "lanes">,
  cloudLaneComputers?: readonly AdeCloudLaneComputer[],
  cloudComputers?: readonly AdeCloudComputerId[],
): readonly LaneSummary[] {
  if (!entry.lanes.some((lane) => lane.laneType === "primary")) return entry.lanes;
  const laneComputer = isAdeCloudLaneComputerMachine({
    hostname: entry.binding?.kind === "remote" ? entry.binding.hostname ?? null : null,
    machineKey: savedChatsMachineKey(entry.machineId),
    targetId: entry.targetId ?? machineIdOfSlot(entry.machineId),
  }, cloudLaneComputers, cloudComputers);
  return laneComputer ? entry.lanes.filter((lane) => lane.laneType !== "primary") : entry.lanes;
}

/**
 * Whether the machine's work is listed: online (a machine in its short
 * reconnect window still reads online), or an ADE Cloud computer that is only
 * asleep. Any other machine that is offline is not listed at all.
 */
export function machineShowsConnected(
  entry: Pick<CrossMachineMachineLanes, "machineId" | "online" | "sessions" | "computerGone" | "binding">,
  cloudLaneComputers?: readonly AdeCloudLaneComputer[],
): boolean {
  return entry.online || machineIsCloudResting(entry, cloudLaneComputers);
}

/**
 * Whether the row looks like a connected machine's: online, or a cloud
 * computer that is only asleep. Looks only; every guard reads `online`.
 */
export function rowShowsConnected(row: { online: boolean; cloudResting?: boolean }): boolean {
  return row.online || row.cloudResting === true;
}
