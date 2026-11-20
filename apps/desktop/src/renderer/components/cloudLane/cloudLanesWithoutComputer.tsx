import { useMemo } from "react";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import { savedChatsMachineKey, type CloudChatComputer } from "../../../shared/cloudSavedChats";
import { CLOUD_KEPT_LANE_FATE, cloudComputerFateSentence, type CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { cloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { sameMachineKey } from "../../../shared/machineAddress";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { ipcErrorMessage } from "../../lib/format";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { rootAppStoreApi, useAppStore, useRootAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { savedChatLocationForSession } from "../../state/cloudSavedChats";
import { noteCloudSavedChatsDeleted } from "../../state/cloudSavedChatsSync";
import { requestCloudSavedChatsRead } from "../../state/crossMachineLanes";
import { showToast } from "../app/toast/toastStore";
import { originUrlForBinding } from "../lanes/laneMachines";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { confirmDialog } from "../ui/dialog";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable, forgetCloudLaneWithoutComputer } from "./cloudLaneActions";
import { dropCloudLaneWithoutComputer, useCloudLanesWithoutComputer } from "./cloudLaneStores";

/**
 * This project's ADE Cloud lanes whose computer was deleted. A deleted
 * computer looks like a sleeping one: its lane and its chats stay in the Work
 * and Lanes lists, each with one quiet "Computer deleted" mark, and the chat
 * says what a send does (`CloudLaneComputerDeletedBanner`). A lane shows here
 * when:
 * - ADE removed its computer and kept the lane (unused too long, the plan, or
 *   the person freed it): the server's kept-lanes list.
 * - Its computer was deleted and its chats were kept: the saved-chats read
 *   (`computerGone` on the machine's slice).
 *
 * Everything here is account level: the kept lanes and the saved chats are
 * read and deleted by the account, never through a pin.
 */

export type CloudLaneWithoutComputerRow = {
  laneId: string;
  laneName: string;
  /** The lane as its saved chats' slice lists it, when it has chats there. */
  lane: LaneSummary | null;
  /** Its saved chats, newest first. */
  sessions: TerminalSessionSummary[];
  /** The deleted computers' store slices it was found on. */
  machineIds: string[];
  /** Set when the server kept the lane: it can get a new computer. */
  kept: CloudLaneWithoutComputer | null;
  /** The saved chats' answer for their computer, when the lane wasn't kept. */
  computer: CloudChatComputer | null;
};

/** The quiet mark a lane row carries in Work and Lanes, and its tooltip. */
export type CloudLaneRowNote = { label: string; title: string };

const NO_ROWS: CloudLaneWithoutComputerRow[] = [];

const activityOf = (session: TerminalSessionSummary) => Date.parse(session.lastActivityAt ?? session.startedAt) || 0;

/** The lanes on deleted computers' slices, one per lane id, each with its chats newest first. Pure. */
function lanesOnDeletedComputers(entries: Readonly<Record<string, CrossMachineMachineLanes>>): Map<string, CloudLaneWithoutComputerRow> {
  const byLane = new Map<string, CloudLaneWithoutComputerRow>();
  for (const entry of Object.values(entries)) {
    if (entry.computerGone !== true) continue;
    for (const lane of entry.lanes) {
      const sessions = entry.sessions.filter((session) => session.laneId === lane.id);
      const current = byLane.get(lane.id);
      if (current) {
        const known = new Set(current.sessions.map((session) => session.id));
        current.sessions.push(...sessions.filter((session) => !known.has(session.id)));
        if (!current.machineIds.includes(entry.machineId)) current.machineIds.push(entry.machineId);
      } else {
        byLane.set(lane.id, { laneId: lane.id, laneName: lane.name, lane, sessions: [...sessions], machineIds: [entry.machineId], kept: null, computer: null });
      }
    }
  }
  for (const row of byLane.values()) row.sessions.sort((a, b) => activityOf(b) - activityOf(a));
  return byLane;
}

/** The saved chats' own answer for their computer: the newest that has one. */
function computerAnswerOf(row: CloudLaneWithoutComputerRow): CloudChatComputer | null {
  for (const session of row.sessions) {
    const told = savedChatLocationForSession(session.id)?.row.computer ?? null;
    if (told) return told;
  }
  return null;
}

/**
 * The rows of one project, newest first: the deleted computers' lanes, with
 * this project's kept lanes merged in by lane id. Pure, but for the saved
 * chats' computer answer it reads from the saved-chats read's memory.
 */
function buildRows(
  entries: Readonly<Record<string, CrossMachineMachineLanes>>,
  keptLanes: readonly CloudLaneWithoutComputer[],
  identity: string | null,
): CloudLaneWithoutComputerRow[] {
  const byLane = lanesOnDeletedComputers(entries);
  for (const kept of keptLanes) {
    if (!identity || kept.projectOrigin !== identity) continue;
    const current = byLane.get(kept.laneId);
    if (current) {
      current.kept = kept;
      current.laneName = kept.laneName;
    } else {
      byLane.set(kept.laneId, { laneId: kept.laneId, laneName: kept.laneName, lane: null, sessions: [], machineIds: [], kept, computer: null });
    }
  }
  const rows = [...byLane.values()];
  for (const row of rows) {
    if (!row.kept) row.computer = computerAnswerOf(row);
  }
  const when = (row: CloudLaneWithoutComputerRow) => Math.max(
    row.sessions[0] ? activityOf(row.sessions[0]) : 0,
    row.kept?.since ?? 0,
    row.computer?.state === "deleted" ? row.computer.deletedAt : 0,
  );
  return rows.sort((a, b) => when(b) - when(a));
}

/**
 * This project's ADE Cloud lanes whose computer is gone, newest first. Empty
 * when ADE Cloud is off. It reads the stores the saved-chats read and the
 * kept-lanes read fill; no request of its own beyond the kept lanes' shared one.
 */
export function useCloudLanesWithoutComputerRows(): CloudLaneWithoutComputerRow[] {
  const enabled = useAdeCloudEnabled();
  const entries = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const binding = useAppStore((state) => state.projectBinding);
  const identity = normalizeGitRemoteIdentity(originUrlForBinding(binding));
  const { lanes: keptLanes } = useCloudLanesWithoutComputer(enabled && cloudLaneLifeAvailable());
  return useMemo(() => {
    const rows = enabled ? buildRows(entries ?? {}, keptLanes, identity) : NO_ROWS;
    // None is the common case: one empty list, so memos keyed on it hold.
    return rows.length ? rows : NO_ROWS;
  }, [enabled, entries, identity, keptLanes]);
}

/** One lane's row as the stores hold it now, read at the moment of a click (no subscription). */
export function cloudLaneWithoutComputerRowNow(
  laneId: string,
  kept: CloudLaneWithoutComputer | null,
  fallbackName: string,
): CloudLaneWithoutComputerRow {
  const row = lanesOnDeletedComputers(rootAppStoreApi.getState().crossMachineLanesByMachineId).get(laneId)
    ?? { laneId, laneName: kept?.laneName ?? fallbackName, lane: null, sessions: [], machineIds: [], kept: null, computer: null };
  if (kept) {
    row.kept = kept;
    row.laneName = kept.laneName;
  } else {
    row.computer = computerAnswerOf(row);
  }
  return row;
}

/** A lane kept with no saved chat yet: a lane row of its own, as its saved chats would make it. */
export function keptLaneSummary(kept: CloudLaneWithoutComputer): LaneSummary {
  return {
    id: kept.laneId,
    name: kept.laneName,
    laneType: "worktree",
    baseRef: "",
    branchRef: kept.branchRef ? kept.branchRef.replace(/^origin\//, "") : "",
    worktreePath: "",
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: new Date(Number.isFinite(kept.since) ? kept.since : Date.now()).toISOString(),
  };
}

const dayOf = (ms: number | null | undefined): string | null => (ms && Number.isFinite(ms)
  ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  : null);

/** What happened to a kept lane's computer, in one sentence (`cloudComputerFateSentence`). */
export function keptLaneFateSentence(kept: CloudLaneWithoutComputer): string {
  const on = dayOf(kept.since);
  return cloudComputerFateSentence(CLOUD_KEPT_LANE_FATE[kept.reason], on ? ` on ${on}` : "");
}

/** What happened to the computer of a chat with no kept lane, from its saved row's answer. */
export function savedChatFateSentence(computer: CloudChatComputer | null | undefined): string {
  const deleted = computer?.state === "deleted" ? computer : null;
  const on = dayOf(deleted?.deletedAt);
  return cloudComputerFateSentence(deleted?.reason, on ? ` on ${on}` : "");
}

/** What happened to the row's computer, in one sentence. */
export function cloudLaneWithoutComputerFate(row: Pick<CloudLaneWithoutComputerRow, "kept" | "computer">): string {
  return row.kept ? keptLaneFateSentence(row.kept) : savedChatFateSentence(row.computer);
}

/** The branch a new computer for the lane starts on, without `origin/`; null when ADE never learned it. */
export function cloudLaneWithoutComputerBranch(kept: CloudLaneWithoutComputer | null, laneBranchRef: string | null): string | null {
  const ref = kept?.branchRef ?? laneBranchRef ?? "";
  const branch = ref.replace(/^origin\//, "").trim();
  return branch || null;
}

// ---------------------------------------------------------------------------
// New computer sizes
// ---------------------------------------------------------------------------

/**
 * The size a new computer starts at when a message to a chat whose computer
 * is gone goes through the account's queue: ADE's default size, Small. The
 * queue takes no size (`sendThroughLaunch` in the server's `chatMessages.ts`);
 * the server may start Medium for a repository whose setup needed it before.
 */
const CLOUD_QUEUE_SIZE_ID: CloudTierId = "small";

/** A tier's name as the account's catalog gives it ("Small"). */
export function cloudTierLabel(account: CloudAccountState | null | undefined, id: CloudTierId): string {
  return cloudTier(cloudCatalogOf(account), id)?.label ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * The size a queued message's new computer starts at, as a sentence says it
 * ("Small or bigger if the project needs it"): the server can start Medium,
 * and the setup can move it up.
 */
export function cloudQueueSizeLabel(account: CloudAccountState | null | undefined): string {
  return `${cloudTierLabel(account, CLOUD_QUEUE_SIZE_ID)} or bigger if the project needs it`;
}

// ---------------------------------------------------------------------------
// The quiet marks on rows
// ---------------------------------------------------------------------------

/** "Computer deleted", with what happened as its tooltip. */
export function computerDeletedRowNote(fate: string): CloudLaneRowNote {
  return { label: "Computer deleted", title: fate };
}

/** The mark of a row whose computer is gone but whose lane ADE has no record for. */
export const COMPUTER_DELETED_ROW_NOTE: CloudLaneRowNote = computerDeletedRowNote(cloudComputerFateSentence(null, ""));

/** "Deleting soon", with the day as its tooltip. */
export function deletingSoonRowNote(deletesAt: number): CloudLaneRowNote {
  const on = dayOf(deletesAt);
  return { label: "Deleting soon", title: on ? `ADE Cloud deletes this lane's computer on ${on} because it is unused.` : "ADE Cloud deletes this lane's computer soon because it is unused." };
}

/**
 * The marks of this project's ADE Cloud lanes, by lane id: "Computer deleted"
 * for the lanes `rows` lists, "Deleting soon" for the lane computers the idle
 * cleanup warned about. Read from the account (`dueForDeletion`) and the lane
 * index the lists already follow; no read, poll or timer of its own. Each map
 * keeps its identity while its marks are the same, so a row memoized on them
 * re-renders only when its mark changes.
 */
export function useCloudLaneRowNotes(rows: readonly CloudLaneWithoutComputerRow[]): {
  deletedByLaneId: ReadonlyMap<string, CloudLaneRowNote>;
  deletingSoonByLaneId: ReadonlyMap<string, CloudLaneRowNote>;
} {
  const account = useCloudAccount();
  const { computers } = useAdeCloudLaneComputers();
  const deletedKey = rows.map((row) => `${row.laneId}\u0001${cloudLaneWithoutComputerFate(row)}`).join("\u0000");
  const deletedByLaneId = useMemo(() => {
    const map = new Map<string, CloudLaneRowNote>();
    if (!deletedKey) return map;
    for (const part of deletedKey.split("\u0000")) {
      const [laneId, fate] = part.split("\u0001");
      if (laneId) map.set(laneId, computerDeletedRowNote(fate ?? ""));
    }
    return map;
  }, [deletedKey]);
  const due = account?.dueForDeletion;
  const dueKey = useMemo(() => {
    if (!due?.length) return "";
    const laneOf = new Map(computers.map((computer) => [computer.instanceId, computer.laneId] as const));
    // A held entry wasn't deleted (its work couldn't be saved): nothing is due.
    return due
      .flatMap((entry) => {
        const laneId = entry.held ? null : laneOf.get(entry.instanceId);
        return laneId ? [`${laneId}\u0001${entry.deletesAt}`] : [];
      })
      .join("\u0000");
  }, [computers, due]);
  const deletingSoonByLaneId = useMemo(() => {
    const map = new Map<string, CloudLaneRowNote>();
    if (!dueKey) return map;
    for (const part of dueKey.split("\u0000")) {
      const [laneId, deletesAt] = part.split("\u0001");
      if (laneId) map.set(laneId, deletingSoonRowNote(Number(deletesAt)));
    }
    return map;
  }, [dueKey]);
  return { deletedByLaneId, deletingSoonByLaneId };
}

// ---------------------------------------------------------------------------
// Deleting a lane whose computer is gone
// ---------------------------------------------------------------------------

/**
 * Drops deleted saved chats from the deleted computers' slices: the whole lane
 * when every one of its chats went (`removed` null), else only those chats.
 * A slice left with nothing goes too.
 */
function dropFromStore(row: CloudLaneWithoutComputerRow, removed: ReadonlySet<string> | null): void {
  const store = rootAppStoreApi.getState();
  const drop: string[] = [];
  for (const machineId of row.machineIds) {
    const entry = store.crossMachineLanesByMachineId[machineId];
    if (!entry) continue;
    const lanes = removed ? entry.lanes : entry.lanes.filter((lane) => lane.id !== row.laneId);
    const sessions = entry.sessions.filter((session) => (removed ? !removed.has(session.id) : session.laneId !== row.laneId));
    if (!lanes.length && !sessions.length) {
      drop.push(machineId);
      continue;
    }
    store.mergeCrossMachineLanes({ machineId, machineName: entry.machineName, computerGone: true, lanes, sessions });
  }
  if (drop.length) store.dropCrossMachineLanes(drop);
}

/**
 * The server deleted this kept lane, and its saved chats on every computer
 * with it: the lane leaves the lists now, and a read that started before the
 * delete can't list it again.
 */
export function noteKeptLaneDeleted(laneId: string): void {
  noteCloudSavedChatsDeleted({ laneIds: [laneId] });
  dropCloudLaneWithoutComputer(laneId);
}

// A lane's saved chats on one computer are read in pages of this size, at most this many pages.
const SAVED_CHAT_PAGE = 200;
const SAVED_CHAT_PAGES = 20;

/**
 * Deletes the row's saved chats from ADE Cloud: each chat where its saved copy
 * is, then every chat of the lane on its old computers, page by page.
 * Resolves how many of the row's chats are still there (none found where they
 * should be), and whether the page limit cut a computer's scan short.
 */
async function deleteRowChats(row: CloudLaneWithoutComputerRow, removed: Set<string>): Promise<{ missing: number; cut: boolean }> {
  const savedChats = window.ade?.cloud?.savedChats;
  if (!savedChats?.delete) throw new Error(CLOUD_LANE_LIFE_UNAVAILABLE);
  // The lane's old computers: the kept record's, and those of the slices that list it.
  const machineKeys = new Set<string>(row.kept?.formerMachineKey ? [row.kept.formerMachineKey] : []);
  for (const machineId of row.machineIds) {
    const machineKey = savedChatsMachineKey(machineId);
    if (machineKey) machineKeys.add(machineKey);
  }
  for (const session of row.sessions) {
    const location = savedChatLocationForSession(session.id);
    const machineKey = location?.readMachineKey ?? location?.machineKey ?? null;
    // A chat with no known copy is found by the scan of its lane's computers below.
    if (!machineKey) continue;
    machineKeys.add(machineKey);
    await savedChats.delete({ machineKey, chatId: session.id });
    removed.add(session.id);
  }
  // The window reads only a project's newest saved chats: the lane's older ones, on the same computers, go too.
  let cut = false;
  for (const machineKey of machineKeys) {
    let cursor: string | null = null;
    for (let page = 0; page < SAVED_CHAT_PAGES; page += 1) {
      const listed = await savedChats.list({ machineKey, limit: SAVED_CHAT_PAGE, cursor });
      for (const chat of listed?.chats ?? []) {
        if (chat.laneId !== row.laneId || !sameMachineKey(chat.machineKey, machineKey) || removed.has(chat.chatId)) continue;
        await savedChats.delete({ machineKey: chat.machineKey, chatId: chat.chatId });
        removed.add(chat.chatId);
      }
      cursor = listed?.nextCursor ?? null;
      if (!cursor) break;
    }
    if (cursor) cut = true;
  }
  return { missing: row.sessions.filter((session) => !removed.has(session.id)).length, cut };
}

/** Whether this window can delete the row: the kept lane's record, or its saved chats. */
export function canDeleteCloudLaneWithoutComputer(row: Pick<CloudLaneWithoutComputerRow, "kept">): boolean {
  return row.kept ? cloudLaneLifeAvailable() : Boolean(window.ade?.cloud?.savedChats?.delete);
}

/** The row's Delete, as its button and its confirm both say it. */
export function cloudLaneWithoutComputerDeleteLabel(row: Pick<CloudLaneWithoutComputerRow, "kept" | "sessions">): string {
  return row.sessions.length > 0 ? (row.kept ? "Delete lane and chats" : "Delete chats") : "Delete lane";
}

/**
 * Delete a lane whose computer is gone: the kept lane's record and every saved
 * chat, after one question. Account level (no pin). A failure shows a toast.
 */
export async function deleteCloudLaneWithoutComputer(row: CloudLaneWithoutComputerRow): Promise<void> {
  const count = row.sessions.length;
  const chats = count === 1 ? "its chat" : count > 1 ? `its ${count} chats` : null;
  const ok = await confirmDialog({
    title: `Delete ${row.laneName}?`,
    message: row.kept
      ? `ADE stops listing the lane and deletes ${chats ?? "any saved chats it has"} and its saved work that isn't on GitHub. Download that work first if you need it. Its branch stays on GitHub.`
      : `ADE deletes ${chats ?? "its saved chats"} from ADE Cloud. Work it pushed stays on GitHub.`,
    icon: <CloudMark size={16} brand />,
    confirmLabel: cloudLaneWithoutComputerDeleteLabel(row),
    destructive: true,
  });
  if (!ok) return;
  const removed = new Set<string>();
  try {
    // The lane first: the server refuses it while a computer holds the lane
    // (another device started it again), so chats that computer carries on
    // are never deleted.
    if (row.kept) {
      await forgetCloudLaneWithoutComputer(row.laneId);
      noteKeptLaneDeleted(row.laneId);
    }
    const { missing, cut } = await deleteRowChats(row, removed);
    // Only what is gone: a lane that still has chats stays listed.
    noteCloudSavedChatsDeleted({ chatIds: removed, laneIds: missing > 0 || cut ? [] : [row.laneId] });
    if (missing > 0 || cut) {
      console.warn("[cloud] a lane's delete left saved chats", { laneId: row.laneId, missing, cut });
      dropFromStore(row, removed);
      showToast({
        tone: "error",
        title: row.kept ? `Deleted ${row.laneName}, not all its chats` : `Kept ${row.laneName}`,
        message: missing > 0
          ? `ADE couldn't find where ${missing === 1 ? "1 of its chats is" : `${missing} of its chats are`} kept on ADE Cloud. Try again in a moment.`
          : "ADE Cloud has more chats than ADE could read at once. Delete again to remove the rest.",
        replayMask: { title: true },
      });
      return;
    }
    dropFromStore(row, null);
    showToast({ tone: "success", title: `Deleted ${row.laneName}`, message: !row.kept ? "Its chats are gone." : chats ? "The lane and its chats are gone." : "The lane is gone.", replayMask: { title: true } });
  } catch (error) {
    console.warn("[cloud] deleting a lane without a computer failed", error);
    if (removed.size) {
      noteCloudSavedChatsDeleted({ chatIds: removed });
      dropFromStore(row, removed);
    }
    showToast({ tone: "error", title: `Couldn't delete ${row.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment.", replayMask: { title: true } });
  } finally {
    // The list says what is left now, not after its 30 s wait.
    requestCloudSavedChatsRead();
  }
}
