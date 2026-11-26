import React from "react";
import type { DeletedChat, DeletedLaneSnapshot, OpenProjectBinding } from "../../../shared/types";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { ipcErrorMessage } from "../../lib/format";
import { useEveryCopyRead } from "./useEveryCopyRead";

/**
 * Recently deleted from every computer with a copy of the project: a lane and
 * its chats live on the machine that ran them, so one machine's list is never
 * the whole answer.
 */

/** Locating each chat's conversation can take a while on a machine with many. */
const DELETED_READ_TIMEOUT_MS = 20_000;

export type DeletedSource = {
  pin: OpenProjectBinding;
  machineName: string;
};

export type MachineDeleted = DeletedSource & {
  /** Null until the machine answers. */
  lanes: DeletedLaneSnapshot[] | null;
  chats: DeletedChat[] | null;
  /** Why (part of) the machine's list could not be read. */
  error: string | null;
  /** The machine runs an ADE with no Recently deleted chats. */
  outdated: boolean;
};

type Deleted = { lanes: DeletedLaneSnapshot[]; chats: DeletedChat[]; error: string | null; outdated: boolean };

async function readDeleted(pin: OpenProjectBinding, timed: <R>(call: Promise<R>) => Promise<R>): Promise<Deleted> {
  const listLanes = window.ade.lanes?.listDeleted;
  const [lanes, chats] = await Promise.allSettled([
    listLanes ? timed(listLanes(pin)) : Promise.resolve([] as DeletedLaneSnapshot[]),
    timed(window.ade.agentChat.listDeleted({}, pin)),
  ]);
  const out: Deleted = { lanes: [], chats: [], error: null, outdated: false };
  if (lanes.status === "fulfilled") out.lanes = Array.isArray(lanes.value) ? lanes.value : [];
  // A machine on an older ADE simply has no saved lanes to list.
  else if (!isUnsupportedAdeActionError(lanes.reason)) out.error = ipcErrorMessage(lanes.reason) || "Something went wrong.";
  if (chats.status === "fulfilled") out.chats = chats.value.chats;
  else if (isUnsupportedAdeActionError(chats.reason)) out.outdated = true;
  else out.error ??= ipcErrorMessage(chats.reason) || "Something went wrong.";
  return out;
}

export function useDeletedEverywhere(): {
  machines: MachineDeleted[];
  noCopy: boolean;
  reload: (pinKey?: string) => void;
} {
  const { machines: reads, noCopy, reload } = useEveryCopyRead(readDeleted, DELETED_READ_TIMEOUT_MS);
  const machines = React.useMemo(() => reads.map((read): MachineDeleted => ({
    pin: read.pin,
    machineName: read.machineName,
    lanes: read.done ? read.value?.lanes ?? [] : null,
    chats: read.done ? read.value?.chats ?? [] : null,
    error: read.error ?? read.value?.error ?? null,
    outdated: read.value?.outdated ?? false,
  })), [reads]);
  return { machines, noCopy, reload };
}
