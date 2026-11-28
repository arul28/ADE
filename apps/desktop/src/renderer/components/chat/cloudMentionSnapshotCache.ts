import type { CloudMentionSnapshot } from "../../../shared/cloudMentionSnapshot";
import { runAccountCall } from "../../lib/adeCloudAccountRead";
import { savedChatLocationForSession } from "../../state/cloudSavedChats";

/**
 * The `@` menu a resting ADE Cloud computer saved (`cloudMentionSnapshot.ts`),
 * held per (computer, project, lane) for the window. An account read, so no
 * pin and no wake. One download per sleep: a later read sends the saved time
 * it holds and the server answers "unchanged" while it still is. Checked at
 * most every `RECHECK_MS` while someone types.
 */

const RECHECK_MS = 30_000;

type Entry = { snapshot: CloudMentionSnapshot | null; checkedAt: number; inFlight: Promise<CloudMentionSnapshot | null> | null };

const entries = new Map<string, Entry>();

/** Where a resting chat's saved menu is: its computer, project and lane, from its saved copy. */
export function restingMentionAddress(sessionId: string): { machineKey: string; projectKey: string; laneId: string | null } | null {
  const location = savedChatLocationForSession(sessionId);
  const projectKey = location?.row.projectKey?.trim();
  if (!location || !projectKey) return null;
  return { machineKey: location.machineKey, projectKey, laneId: location.row.laneId ?? null };
}

/** The saved menu for a resting chat, or null (none saved, an older server, signed out). */
export async function restingMentionSnapshot(sessionId: string): Promise<{ snapshot: CloudMentionSnapshot; laneId: string | null } | null> {
  const address = restingMentionAddress(sessionId);
  if (!address) return null;
  const key = `${address.machineKey}\n${address.projectKey}\n${address.laneId ?? ""}`;
  const entry = entries.get(key) ?? { snapshot: null, checkedAt: 0, inFlight: null };
  entries.set(key, entry);
  if (Date.now() - entry.checkedAt < RECHECK_MS) return entry.snapshot ? { snapshot: entry.snapshot, laneId: address.laneId } : null;
  entry.inFlight ??= runAccountCall({
    call: "mentionSnapshot",
    machineKey: address.machineKey,
    projectKey: address.projectKey,
    laneId: address.laneId,
    since: entry.snapshot?.savedAt ?? null,
  }).then((answer) => {
    // A failed read keeps what the window holds, and asks again on the next query.
    if (!answer?.ok) return entry.snapshot;
    entry.checkedAt = Date.now();
    const result = answer.result;
    // None saved (an older computer, an older server): the window's own rows answer meanwhile.
    if (!result) entry.snapshot = null;
    else if (!("unchanged" in result && result.unchanged)) entry.snapshot = result.snapshot;
    return entry.snapshot;
  }).finally(() => {
    entry.inFlight = null;
  });
  const snapshot = await entry.inFlight;
  return snapshot ? { snapshot, laneId: address.laneId } : null;
}
