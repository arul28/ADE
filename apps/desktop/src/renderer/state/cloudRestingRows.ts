import type { TerminalSessionSummary } from "../../shared/types";
import type { CrossMachineMachineLanes } from "./appStore";
import { adeCloudLaneComputerForMachine } from "./adeCloudLaneIndex";
import { isSavedChatsMachineId } from "./cloudSavedChats";

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
 * rows, and opening one wakes the computer. Three signs, any one is enough:
 * a `cloud-saved:` slice, a saved chat copy, or a machine the ADE Cloud lane
 * index knows. A deleted computer (`computerGone`) is never resting.
 */
export function machineIsCloudResting(
  entry: Pick<CrossMachineMachineLanes, "machineId" | "online" | "sessions" | "computerGone" | "binding">,
): boolean {
  if (entry.online || entry.computerGone === true) return false;
  if (isSavedChatsMachineId(entry.machineId)) return true;
  if (entry.sessions.some((session) => session.cloudSavedCopy === true)) return true;
  const hostname = entry.binding?.kind === "remote" ? entry.binding.hostname ?? null : null;
  return adeCloudLaneComputerForMachine({ hostname }) != null;
}

/**
 * Whether the machine's work is listed: online (a machine in its short
 * reconnect window still reads online), or an ADE Cloud computer that is only
 * asleep. Any other machine that is offline is not listed at all.
 */
export function machineShowsConnected(
  entry: Pick<CrossMachineMachineLanes, "machineId" | "online" | "sessions" | "computerGone" | "binding">,
): boolean {
  return entry.online || machineIsCloudResting(entry);
}

/**
 * Whether the row looks like a connected machine's: online, or a cloud
 * computer that is only asleep. Looks only; every guard reads `online`.
 */
export function rowShowsConnected(row: { online: boolean; cloudResting?: boolean }): boolean {
  return row.online || row.cloudResting === true;
}
