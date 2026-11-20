import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { CaretDown, CaretRight, ChatCircleText, Plus, Trash } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { CloudChatComputer } from "../../../shared/cloudSavedChats";
import { CLOUD_KEPT_LANE_FATE, cloudComputerFateSentence, type CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { sameMachineKey } from "../../../shared/machineAddress";
import type { TerminalSessionSummary } from "../../../shared/types";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { primarySessionLabel } from "../../lib/sessions";
import { rootAppStoreApi, useAppStore, useRootAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { savedChatLocationForSession } from "../../state/cloudSavedChats";
import { showToast } from "../app/toast/toastStore";
import { originUrlForBinding } from "../lanes/laneMachines";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { MachineActionsMenu } from "../remoteTargets/MachineActionsMenu";
import { confirmDialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable, forgetCloudLaneWithoutComputer } from "./cloudLaneActions";
import { refreshCloudLanesWithoutComputer, useCloudLanesWithoutComputer } from "./cloudLaneStores";
import { useStartLaneOnNewComputer } from "./CloudLaneWithoutComputer";
import "./cloudLane.css";

/**
 * The one place for this project's ADE Cloud lanes that have no computer, in
 * Work (above the list) and in Lanes. Since a lane delete takes its chats
 * too, a lane shows here only when:
 * - ADE removed its computer and kept the lane (unused too long, the plan,
 *   or the person freed it): the server's kept-lanes list. Its next step is
 *   "New computer", on the same branch.
 * - Its computer was deleted and its chats were kept: the saved-chats read
 *   (`computerGone` on the machine's slice). Its chats stay to read.
 *
 * Each row says what happened in one line, with the server's own reason
 * (`CloudChatComputer.reason`, the kept lane's `reason`). Delete sits in the
 * row's ⋯ menu. The block is folded; a gold dot on its head marks a lane the
 * person hasn't seen yet, and opening the block marks them seen.
 *
 * Deleted computers' lanes never list among live lanes or as a machine chip
 * (`useLanesPageMachines`, the Work list). The block reads only the stores
 * the saved-chats read and the kept-lanes read fill.
 */

type LaneRow = {
  laneId: string;
  laneName: string;
  /** Its saved chats, newest first. */
  sessions: TerminalSessionSummary[];
  /** The deleted computers' store slices it was found on. */
  machineIds: string[];
  /** Set when the server kept the lane: it can get a new computer. */
  kept: CloudLaneWithoutComputer | null;
  /** The saved chats' answer for their computer, when the lane wasn't kept. */
  computer: CloudChatComputer | null;
};

const activityOf = (session: TerminalSessionSummary) => Date.parse(session.lastActivityAt ?? session.startedAt) || 0;

/** The lanes on deleted computers' slices, one per lane id, each with its chats newest first. Pure. */
function lanesOnDeletedComputers(entries: Readonly<Record<string, CrossMachineMachineLanes>>): Map<string, LaneRow> {
  const byLane = new Map<string, LaneRow>();
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
        byLane.set(lane.id, { laneId: lane.id, laneName: lane.name, sessions: [...sessions], machineIds: [entry.machineId], kept: null, computer: null });
      }
    }
  }
  for (const lane of byLane.values()) lane.sessions.sort((a, b) => activityOf(b) - activityOf(a));
  return byLane;
}

const dayOf = (ms: number | null | undefined): string | null => (ms && Number.isFinite(ms)
  ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  : null);

/** What happened to the lane's computer, in one line. */
function rowSentence(row: LaneRow): string {
  if (row.kept) {
    const on = dayOf(row.kept.since);
    const branch = row.kept.branchRef ? row.kept.branchRef.replace(/^origin\//, "") : null;
    return `${cloudComputerFateSentence(CLOUD_KEPT_LANE_FATE[row.kept.reason], on ? ` on ${on}` : "")} Its work is on ${branch ?? "GitHub"}.`;
  }
  const computer = row.computer?.state === "deleted" ? row.computer : null;
  const on = dayOf(computer?.deletedAt);
  const fate = cloudComputerFateSentence(computer?.reason, on ? ` on ${on}` : "");
  // ADE's own deletes say why; a delete the person made says the chats are what they kept.
  return computer?.reason === "you" || computer?.reason === "freed" || computer?.reason === "other" || !computer
    ? `${fate} Its chats are kept here.`
    : fate;
}

/** A row's key for "seen": a lane kept again after a delete counts as new. */
const rowKey = (row: LaneRow) => `${row.laneId}:${row.kept ? `kept:${row.kept.since}` : "chats"}`;

// ---------------------------------------------------------------------------
// Seen rows: the head's dot is for lanes the person hasn't looked at yet.
// ---------------------------------------------------------------------------

const SEEN_STORAGE_KEY = "ade.cloudLanesWithoutComputer.seen.v1";
const SEEN_MAX = 200;
let seen: ReadonlySet<string> = readSeen();
const seenListeners = new Set<() => void>();

function readSeen(): ReadonlySet<string> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SEEN_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch (error) {
    console.warn("[cloud] reading the seen lanes without a computer failed", error);
    return new Set();
  }
}

function markSeen(keys: readonly string[]): void {
  if (keys.every((key) => seen.has(key))) return;
  const next = [...seen, ...keys.filter((key) => !seen.has(key))].slice(-SEEN_MAX);
  seen = new Set(next);
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // A full or blocked storage only brings the dot back next launch.
    console.warn("[cloud] saving the seen lanes without a computer failed", error);
  }
  for (const listener of seenListeners) listener();
}

function subscribeSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}
const readSeenNow = () => seen;

// ---------------------------------------------------------------------------
// Deleting a row
// ---------------------------------------------------------------------------

/**
 * Drops deleted saved chats from the deleted computers' slices: the whole lane
 * when every one of its chats went (`removed` null), else only those chats.
 * A slice left with nothing goes too.
 */
function dropFromStore(row: LaneRow, removed: ReadonlySet<string> | null): void {
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

/** Deletes the row's saved chats from ADE Cloud. Resolves how many it couldn't find. */
async function deleteRowChats(row: LaneRow, removed: Set<string>): Promise<number> {
  const savedChats = window.ade?.cloud?.savedChats;
  if (!savedChats?.delete) throw new Error(CLOUD_LANE_LIFE_UNAVAILABLE);
  let skipped = 0;
  const machineKeys = new Set<string>(row.kept?.formerMachineKey ? [row.kept.formerMachineKey] : []);
  for (const session of row.sessions) {
    const location = savedChatLocationForSession(session.id);
    const machineKey = location?.readMachineKey ?? location?.machineKey ?? row.kept?.formerMachineKey ?? null;
    if (!machineKey) {
      skipped += 1;
      continue;
    }
    machineKeys.add(machineKey);
    await savedChats.delete({ machineKey, chatId: session.id });
    removed.add(session.id);
  }
  // The window reads only a project's newest saved chats: the lane's older ones, on the same computers, go too.
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
  }
  return skipped;
}

// A lane's saved chats on one computer are read in pages of this size, at most this many pages.
const SAVED_CHAT_PAGE = 200;
const SAVED_CHAT_PAGES = 20;

/** The row's Delete, as its menu item and its confirm button both say it. */
const deleteLabel = (row: LaneRow) => (row.sessions.length > 0 ? (row.kept ? "Delete lane and chats" : "Delete chats") : "Delete lane");

/** The row's Delete: the kept lane's record and every saved chat, after one question. */
async function deleteRow(row: LaneRow): Promise<void> {
  const count = row.sessions.length;
  const chats = count === 1 ? "its chat" : count > 1 ? `its ${count} chats` : null;
  const ok = await confirmDialog({
    title: `Delete ${row.laneName}?`,
    message: row.kept
      ? `ADE stops listing the lane and deletes ${chats ?? "any saved chats it has"}. Its branch stays on GitHub.`
      : `ADE deletes ${chats ?? "its saved chats"} from ADE Cloud. Work it pushed stays on GitHub.`,
    icon: <CloudMark size={16} brand />,
    confirmLabel: deleteLabel(row),
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
      refreshCloudLanesWithoutComputer();
    }
    const skipped = await deleteRowChats(row, removed);
    if (skipped > 0) {
      console.warn("[cloud] a lane's delete skipped saved chats with no known location", { laneId: row.laneId, skipped });
      dropFromStore(row, removed);
      showToast({
        tone: "error",
        title: row.kept ? `Deleted ${row.laneName}, not all its chats` : `Kept ${row.laneName}`,
        message: `ADE couldn't find where ${skipped === 1 ? "1 of its chats is" : `${skipped} of its chats are`} kept on ADE Cloud. Try again in a moment.`,
        replayMask: { title: true },
      });
      return;
    }
    dropFromStore(row, null);
    showToast({ tone: "success", title: `Deleted ${row.laneName}`, message: !row.kept ? "Its chats are gone." : chats ? "The lane and its chats are gone." : "The lane is gone.", replayMask: { title: true } });
  } catch (error) {
    console.warn("[cloud] deleting a lane without a computer failed", error);
    if (removed.size) dropFromStore(row, removed);
    showToast({ tone: "error", title: `Couldn't delete ${row.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment.", replayMask: { title: true } });
  }
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

function NewComputerButton({ lane, disabled }: { lane: CloudLaneWithoutComputer; disabled: boolean }) {
  const { problem, busy, start } = useStartLaneOnNewComputer(lane, null);
  return (
    <button
      type="button"
      className="kit-btn adecl-btn-sky"
      data-size="xs"
      disabled={disabled || busy || Boolean(problem)}
      title={problem ?? "A new computer on the same branch"}
      onClick={() => void start()}
    >
      <Plus size={11} />
      {busy ? "Starting…" : "New computer"}
    </button>
  );
}

function LaneRowView({ row }: { row: LaneRow }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const chatsId = `adecl-wc-chats-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const count = row.sessions.length;
  const open = (session: TerminalSessionSummary) => navigate(`/work?${new URLSearchParams({ sessionId: session.id }).toString()}`);
  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteRow(row);
    } finally {
      setBusy(false);
    }
  };
  const canDelete = row.kept ? cloudLaneLifeAvailable() : Boolean(window.ade?.cloud?.savedChats?.delete);
  return (
    <li className="adecl-wc-row" data-cloud-lane-without-computer={row.laneId} aria-busy={busy || undefined}>
      <span className="adecl-wc-mark" aria-hidden><CloudMark size={13} brand /></span>
      <div className="adecl-wc-main">
        <b className="adecl-wc-name" title={row.laneName}>{row.laneName}</b>
        <span className="adecl-wc-why">{rowSentence(row)}</span>
        <div className="adecl-wc-actions">
          {row.kept ? <NewComputerButton lane={row.kept} disabled={busy} /> : null}
          {count === 1 ? (
            <button type="button" className="adecl-wc-chats-toggle" disabled={busy} onClick={() => open(row.sessions[0]!)}>
              <ChatCircleText size={11} />
              Open chat
            </button>
          ) : count > 1 ? (
            <button
              type="button"
              className="adecl-wc-chats-toggle"
              aria-expanded={chatsOpen}
              aria-controls={chatsId}
              disabled={busy}
              onClick={() => setChatsOpen((value) => !value)}
            >
              {chatsOpen ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
              {count} chats
            </button>
          ) : null}
        </div>
        {count > 1 && chatsOpen ? (
          <ul id={chatsId} className="adecl-deleted-chats" aria-label={`Chats of ${row.laneName}`}>
            {row.sessions.map((session) => (
              <li key={session.id}>
                <button type="button" className="adecl-deleted-chat" disabled={busy} onClick={() => open(session)}>
                  <ChatCircleText size={11} />
                  <span className="adecl-deleted-chat-title">{primarySessionLabel(session)}</span>
                  <span className="adecl-muted">{relativeWhen(session.lastActivityAt ?? session.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {canDelete ? (
        <MachineActionsMenu
          label={`More for ${row.laneName}`}
          actions={[{
            key: "delete",
            label: deleteLabel(row),
            icon: <Trash size={13} />,
            danger: true,
            disabled: busy,
            onSelect: () => void onDelete(),
          }]}
        />
      ) : null}
    </li>
  );
}

/**
 * The block: one folded head ("2 cloud lanes without a computer"), opened to
 * a row per lane. Nothing when there are none or ADE Cloud is off.
 */
/**
 * The lanes this project has on ADE Cloud computers that are gone, newest
 * first. Empty when ADE Cloud is off. The block and the Lanes filter's
 * "Without a computer" entry both read this, so their count cannot drift.
 */
function useCloudLanesWithoutComputerRows(): LaneRow[] {
  const enabled = useAdeCloudEnabled();
  const entries = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const binding = useAppStore((state) => state.projectBinding);
  const identity = normalizeGitRemoteIdentity(originUrlForBinding(binding));
  const { lanes: keptLanes } = useCloudLanesWithoutComputer(enabled && cloudLaneLifeAvailable());
  return useMemo(() => {
    if (!enabled) return [];
    const byLane = lanesOnDeletedComputers(entries ?? {});
    // A kept lane of this project: listed with its next step, and its chats if any.
    for (const kept of keptLanes) {
      if (!identity || kept.projectOrigin !== identity) continue;
      const current = byLane.get(kept.laneId);
      if (current) {
        current.kept = kept;
        current.laneName = kept.laneName;
      } else {
        byLane.set(kept.laneId, { laneId: kept.laneId, laneName: kept.laneName, sessions: [], machineIds: [], kept, computer: null });
      }
    }
    const list = [...byLane.values()];
    for (const row of list) {
      if (row.kept) continue;
      // The saved chats' own answer for their computer; the newest that has one.
      for (const session of row.sessions) {
        const told = savedChatLocationForSession(session.id)?.row.computer ?? null;
        if (told) {
          row.computer = told;
          break;
        }
      }
    }
    const when = (row: LaneRow) => Math.max(
      row.sessions[0] ? activityOf(row.sessions[0]) : 0,
      row.kept?.since ?? 0,
      row.computer?.state === "deleted" ? row.computer.deletedAt : 0,
    );
    return list.sort((a, b) => when(b) - when(a));
  }, [enabled, entries, identity, keptLanes]);
}

/**
 * How many ADE Cloud lanes of this project have no computer, and whether any is
 * unseen. The Lanes sidebar's Computer filter reads it for its entry and its
 * gold dot; it costs the same stores the block reads, and no request.
 */
export function useCloudLanesWithoutComputerSummary(): { count: number; unseen: boolean } {
  const rows = useCloudLanesWithoutComputerRows();
  const seenNow = useSyncExternalStore(subscribeSeen, readSeenNow, readSeenNow);
  return useMemo(
    () => ({ count: rows.length, unseen: rows.some((row) => !seenNow.has(rowKey(row))) }),
    [rows, seenNow],
  );
}

export function CloudLanesWithoutComputerBlock({ className, initiallyOpen = false, visible = true }: {
  className?: string;
  initiallyOpen?: boolean;
  /**
   * False while the surface holding the block is not on screen. A block the
   * filter opened is the person looking at these lanes, so it marks them seen —
   * but only while they can actually see it: a lane that arrives while the tab
   * is parked keeps its new dot until they come back.
   */
  visible?: boolean;
}) {
  const enabled = useAdeCloudEnabled();
  const rows = useCloudLanesWithoutComputerRows();
  const seenNow = useSyncExternalStore(subscribeSeen, readSeenNow, readSeenNow);
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    // Only while the block is actually open on screen: a row that arrives after
    // the person collapsed it (or while the tab is parked) keeps its new dot.
    if (initiallyOpen && visible && open) markSeen(rows.map(rowKey));
  }, [initiallyOpen, open, rows, visible]);
  const listId = `adecl-wc-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const unseen = rows.some((row) => !seenNow.has(rowKey(row)));
  const toggle = useCallback(() => {
    if (!open) markSeen(rows.map(rowKey));
    setOpen(!open);
  }, [open, rows]);
  if (!enabled || !rows.length) return null;
  return (
    <section className={cn("adecl-wc", className)} aria-label="ADE Cloud lanes without a computer">
      <button type="button" className="adecl-wc-head" aria-expanded={open} aria-controls={listId} onClick={toggle}>
        {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        <CloudMark size={11} brand />
        <span>{rows.length === 1 ? "1 cloud lane without a computer" : `${rows.length} cloud lanes without a computer`}</span>
        {unseen ? <i className="adecl-wc-new" role="img" aria-label="New" /> : null}
      </button>
      {open ? (
        <ul id={listId} className="adecl-wc-rows">
          {rows.map((row) => <LaneRowView key={row.laneId} row={row} />)}
        </ul>
      ) : null}
    </section>
  );
}
