import { useId, useMemo, useState } from "react";
import { CaretDown, CaretRight, ChatCircleText, Trash } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { TerminalSessionSummary } from "../../../shared/types";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { primarySessionLabel } from "../../lib/sessions";
import { rootAppStoreApi, useRootAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { savedChatLocationForSession } from "../../state/cloudSavedChats";
import { showToast } from "../app/toast/toastStore";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { confirmDialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable } from "./cloudLaneActions";
import { useCloudLanesWithoutComputer } from "./cloudLaneStores";
import "./cloudLane.css";

/**
 * The one place for ADE Cloud lanes whose computer is really gone: the Lanes
 * tab lists them here, never among the live lanes or as a machine chip
 * (`useLanesPageMachines` leaves them out). "Gone" is the saved-chats read's
 * answer (`computerGone` on the machine's slice, from the account's computer
 * list), so a computer that still exists is never called deleted here.
 *
 * What each lane offers:
 * - Open its chats: the saved copy, read-only, in Work. Each saved chat is
 *   listed under the lane, newest first, so an older one stays reachable
 *   (the Work list leaves a deleted computer's rows out).
 * - Remove: deletes its saved chats from ADE Cloud, and the lane leaves the list.
 *
 * A lane the server kept without a computer (freed, or removed after 30 days)
 * is not listed here: `CloudLanesWithoutComputerList` shows it with "New
 * computer on the same branch", the branch the server kept for it.
 *
 * It reads only the store the saved-chats read fills; nothing of its own.
 */

type DeletedComputerLane = {
  laneId: string;
  laneName: string;
  /** Its saved chats, newest first. */
  sessions: TerminalSessionSummary[];
  /** The store slices (deleted computers) it was found on. */
  machineIds: string[];
};

const activityOf = (session: TerminalSessionSummary) => Date.parse(session.lastActivityAt ?? session.startedAt) || 0;

/** The lanes of deleted computers, one per lane id, newest activity first. Pure. */
function lanesOnDeletedComputers(entries: Readonly<Record<string, CrossMachineMachineLanes>>): DeletedComputerLane[] {
  const byLane = new Map<string, DeletedComputerLane>();
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
        byLane.set(lane.id, { laneId: lane.id, laneName: lane.name, sessions: [...sessions], machineIds: [entry.machineId] });
      }
    }
  }
  const lanes = [...byLane.values()];
  for (const lane of lanes) lane.sessions.sort((a, b) => activityOf(b) - activityOf(a));
  return lanes.sort((a, b) => (b.sessions[0] ? activityOf(b.sessions[0]) : 0) - (a.sessions[0] ? activityOf(a.sessions[0]) : 0));
}

/**
 * Drops deleted saved chats from the deleted computers' slices: the whole lane
 * when every one of its chats went (`removed` null), else only those chats.
 * A slice left with nothing goes too.
 */
function dropFromStore(lane: DeletedComputerLane, removed: ReadonlySet<string> | null): void {
  const store = rootAppStoreApi.getState();
  const drop: string[] = [];
  for (const machineId of lane.machineIds) {
    const entry = store.crossMachineLanesByMachineId[machineId];
    if (!entry) continue;
    const lanes = removed ? entry.lanes : entry.lanes.filter((row) => row.id !== lane.laneId);
    const sessions = entry.sessions.filter((session) => (removed ? !removed.has(session.id) : session.laneId !== lane.laneId));
    if (!lanes.length && !sessions.length) {
      drop.push(machineId);
      continue;
    }
    store.mergeCrossMachineLanes({ machineId, machineName: entry.machineName, computerGone: true, lanes, sessions });
  }
  if (drop.length) store.dropCrossMachineLanes(drop);
}

function DeletedLaneRow({ lane }: { lane: DeletedComputerLane }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const newest = lane.sessions[0] ?? null;
  const count = lane.sessions.length;
  const open = (session: TerminalSessionSummary) => navigate(`/work?${new URLSearchParams({ sessionId: session.id }).toString()}`);

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove ${lane.laneName}?`,
      message: `Its computer is already deleted. ADE deletes its ${count === 1 ? "saved chat" : `${count} saved chats`} from ADE Cloud too. Work it pushed stays on GitHub.`,
      icon: <CloudMark size={16} brand />,
      confirmLabel: "Remove lane",
      destructive: true,
    });
    if (!ok) return;
    const remover = window.ade?.cloud?.savedChats?.delete;
    if (!remover) {
      showToast({ tone: "error", title: `Couldn't remove ${lane.laneName}`, message: CLOUD_LANE_LIFE_UNAVAILABLE, replayMask: { title: true } });
      return;
    }
    setBusy(true);
    const removed = new Set<string>();
    let skipped = 0;
    try {
      for (const session of lane.sessions) {
        const location = savedChatLocationForSession(session.id);
        const machineKey = location?.readMachineKey ?? location?.machineKey ?? null;
        if (!machineKey) {
          // ADE doesn't know where this saved copy is kept, so it can't delete it.
          skipped += 1;
          continue;
        }
        await remover({ machineKey, chatId: session.id });
        removed.add(session.id);
      }
      if (skipped > 0) {
        console.warn("[cloud] removing a deleted computer's lane skipped saved chats with no known location", { laneId: lane.laneId, skipped });
        dropFromStore(lane, removed);
        showToast({
          tone: "error",
          title: `Kept ${lane.laneName}`,
          message: `ADE couldn't find where ${skipped === 1 ? "1 of its saved chats is" : `${skipped} of its saved chats are`} kept on ADE Cloud, so ${skipped === 1 ? "it stays" : "they stay"}. Try again in a moment.`,
          replayMask: { title: true },
        });
        return;
      }
      dropFromStore(lane, null);
      showToast({ tone: "success", title: `Removed ${lane.laneName}`, message: "Its saved chats are deleted.", replayMask: { title: true } });
    } catch (error) {
      console.warn("[cloud] removing a deleted computer's lane failed", error);
      if (removed.size) dropFromStore(lane, removed);
      showToast({ tone: "error", title: `Couldn't remove ${lane.laneName}`, message: ipcErrorMessage(error) || "Try again in a moment.", replayMask: { title: true } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adecl-nocomp" data-variant="row" data-cloud-lane-deleted-computer={lane.laneId}>
      <span className="adecl-nocomp-mark" aria-hidden><CloudMark size={14} brand /></span>
      <div className="adecl-nocomp-text">
        <span><b>{lane.laneName}</b></span>
        <span className="adecl-muted">
          Its computer was deleted. {count === 1 ? "1 saved chat" : `${count} saved chats`} to read.
        </span>
      </div>
      <div className="adecl-nocomp-actions">
        {count === 1 && newest ? (
          <button type="button" className="kit-btn" data-size="xs" disabled={busy} onClick={() => open(newest)}>
            <ChatCircleText size={11} />
            Open chat
          </button>
        ) : null}
        <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" data-tone="crit" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${lane.laneName}`}>
          <Trash size={11} />
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
      {count > 1 ? (
        <ul className="adecl-deleted-chats" aria-label={`Saved chats of ${lane.laneName}`}>
          {lane.sessions.map((session) => (
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
  );
}

/**
 * The Lanes tab's deleted-computers place: one folded header ("2 lanes on
 * deleted computers"), opened to one row per lane. Nothing when there are none.
 */
export function CloudLanesOnDeletedComputers({ className }: { className?: string }) {
  const enabled = useAdeCloudEnabled();
  const entries = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const onDeleted = useMemo(() => lanesOnDeletedComputers(entries ?? {}), [entries]);
  // The server's kept-lanes list is read only while there is a lane here to sort out.
  const without = useCloudLanesWithoutComputer(enabled && onDeleted.length > 0 && cloudLaneLifeAvailable()).lanes;
  const lanes = useMemo(() => {
    // A lane the server kept without a computer is listed with its next step instead.
    const kept = new Set(without.map((lane) => lane.laneId));
    return onDeleted.filter((lane) => !kept.has(lane.laneId));
  }, [onDeleted, without]);
  const [open, setOpen] = useState(false);
  const listId = `adecl-deleted-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  if (!enabled || !lanes.length) return null;
  return (
    <div className={cn("adecl-nocomp-list", className)} aria-label="ADE Cloud lanes on deleted computers">
      <button
        type="button"
        className="adecl-nocomp-list-head adecl-deleted-head"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        <CloudMark size={11} brand />
        <span>{lanes.length === 1 ? "1 lane on a deleted computer" : `${lanes.length} lanes on deleted computers`}</span>
      </button>
      {open ? (
        <div id={listId} className="adecl-deleted-rows">
          {lanes.map((lane) => <DeletedLaneRow key={lane.laneId} lane={lane} />)}
        </div>
      ) : null}
    </div>
  );
}
