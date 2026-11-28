import type { CloudMentionSnapshot } from "../../../shared/cloudMentionSnapshot";
import { runAccountCall } from "../../lib/adeCloudAccountRead";
import { accountScopeGeneration } from "../../state/accountScopedStorage";
import { savedChatLocationForSession } from "../../state/cloudSavedChats";

/**
 * The `@` menu a resting ADE Cloud computer saved (`cloudMentionSnapshot.ts`),
 * held per (signed-in account, computer, project, lane) for the window. An
 * account read, so no pin and no wake. One download per sleep: a later read
 * sends the saved time it holds and the server answers "unchanged" while it
 * still is. Checked at most every `RECHECK_MS` while someone types. A copy
 * the window holds answers at once while it is checked. The rows' first read
 * waits at most `FIRST_READ_WAIT_MS`, then the window's own rows answer and
 * the copy joins a later query; files have no such fallback, so their search
 * waits for the download (`waitMs: null`).
 */

const RECHECK_MS = 30_000;
const FIRST_READ_WAIT_MS = 800;

type Entry = { snapshot: CloudMentionSnapshot | null; checkedAt: number; inFlight: Promise<CloudMentionSnapshot | null> | null };

const entries = new Map<string, Entry>();

/** Where a resting chat's saved menu is: its computer, project and lane, from its saved copy. */
export function restingMentionAddress(sessionId: string): { machineKey: string; projectKey: string; laneId: string | null } | null {
  const location = savedChatLocationForSession(sessionId);
  const projectKey = location?.row.projectKey?.trim();
  if (!location || !projectKey) return null;
  return { machineKey: location.machineKey, projectKey, laneId: location.row.laneId ?? null };
}

async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The saved menu for a resting chat, or null (none saved, not read yet, an older server, signed out). */
export async function restingMentionSnapshot(
  sessionId: string,
  options: { waitMs?: number | null } = {},
): Promise<{ snapshot: CloudMentionSnapshot; laneId: string | null } | null> {
  const address = restingMentionAddress(sessionId);
  if (!address) return null;
  // Another account in this window starts empty: it never sees the last one's file names.
  const key = `${accountScopeGeneration()}\n${address.machineKey}\n${address.projectKey}\n${address.laneId ?? ""}`;
  const entry = entries.get(key) ?? { snapshot: null, checkedAt: 0, inFlight: null };
  entries.set(key, entry);
  if (Date.now() - entry.checkedAt >= RECHECK_MS) {
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
    }, () => entry.snapshot).finally(() => {
      entry.inFlight = null;
    });
  }
  const waitMs = options.waitMs === undefined ? FIRST_READ_WAIT_MS : options.waitMs;
  const pending = entry.inFlight;
  const snapshot = entry.snapshot ?? (pending ? await (waitMs == null ? pending : withinMs(pending, waitMs)) : null);
  return snapshot ? { snapshot, laneId: address.laneId } : null;
}
