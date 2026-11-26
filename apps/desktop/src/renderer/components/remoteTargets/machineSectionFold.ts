import type { AdeAccountMachine, RemoteRuntimeTarget } from "../../../shared/types";
import {
  accountMachinePresence,
  isMachineConnected,
  type ConnectedMachineIds,
} from "../../../shared/machinePresence";
import type { MachineRow, MachineSection } from "./remoteMachineModel";
import { accountRowKey, type RowAction } from "./useRowActions";

/** The sections of computers that are not connected, which fold to one line. */
export const FOLDABLE_SECTIONS: ReadonlySet<MachineSection> = new Set(["available", "unavailable"]);
/** One quiet row is already one line; a fold starts at two. */
export const FOLD_MIN_ROWS = 2;

/** What the list knows about its rows that decides whether a section folds. */
export type MachineFoldContext = {
  busyById: Readonly<Record<string, RowAction>>;
  accountRowErrors: Readonly<Record<string, string>>;
  accountRowStages: Readonly<Record<string, string>>;
  connectedIds: ConnectedMachineIds;
  checkingIds: ReadonlySet<string>;
  updatingIds: ReadonlySet<string>;
  testingId: string | null;
  formTargetId: string | null;
  hostKeyTargetId: string | null;
  focusMachineKey: string | null;
  accountMachineForTarget: (target: RemoteRuntimeTarget) => AdeAccountMachine | null;
  /**
   * The person pressed Connect, Retry or Reconnect on this saved machine (or
   * paired it from its account row and that failed), and the answer is still
   * on screen.
   */
  savedRowUserAttempted: (target: RemoteRuntimeTarget) => boolean;
};

/**
 * True when a not-connected row has something to say beyond one quiet line:
 * it is online or updating, an attempt the person started is running or
 * failed, or they opened one of its panels. Its section stays open.
 *
 * ADE's own background reconnects do not count: a folded section would
 * otherwise open and close on every automatic attempt.
 */
export function machineRowNeedsAttention(row: MachineRow, ctx: MachineFoldContext): boolean {
  if (row.kind === "saved") {
    const id = row.target.id;
    const machineKey = row.target.pairedMachine?.machineKey ?? null;
    const accountMachine = ctx.accountMachineForTarget(row.target);
    return row.connected
      || ctx.busyById[id] != null
      || (machineKey != null && ctx.busyById[accountRowKey(machineKey)] != null)
      || (accountMachine != null && accountMachinePresence(accountMachine) === "online")
      || ctx.checkingIds.has(id)
      || ctx.updatingIds.has(id)
      || ctx.savedRowUserAttempted(row.target)
      || ctx.testingId === id
      || ctx.formTargetId === id
      || ctx.hostKeyTargetId === id
      || row.status?.hostStorageWait != null
      || row.status?.hostStall != null
      || (ctx.focusMachineKey != null && machineKey === ctx.focusMachineKey);
  }
  if (row.kind === "account") {
    const machineKey = row.machine.machineKey;
    return ctx.busyById[accountRowKey(machineKey)] != null
      || isMachineConnected(row.machine, ctx.connectedIds)
      || accountMachinePresence(row.machine) === "online"
      || ctx.accountRowErrors[machineKey] != null
      || ctx.accountRowStages[machineKey] != null
      || ctx.testingId === row.id
      || machineKey === ctx.focusMachineKey;
  }
  return true;
}

/**
 * Whether a section folds, and whether it is open. Computers that are off fold
 * to one line, "Not connected · 5", until one of them has something to say or
 * the person opens the section; their open or close wins while the list is open.
 */
export function machineSectionFold(
  section: MachineSection,
  rows: readonly MachineRow[],
  openOverride: boolean | undefined,
  ctx: MachineFoldContext,
): { foldable: boolean; open: boolean } {
  const foldable = FOLDABLE_SECTIONS.has(section) && rows.length >= FOLD_MIN_ROWS;
  if (!foldable) return { foldable, open: true };
  return { foldable, open: openOverride ?? rows.some((row) => machineRowNeedsAttention(row, ctx)) };
}
