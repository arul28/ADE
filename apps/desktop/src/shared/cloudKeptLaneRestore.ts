/**
 * "Move it to my computer" for a kept ADE Cloud lane (a lane whose computer
 * was deleted, `CloudLaneWithoutComputer`): the destination machine's brain
 * restores it from the account's server copies, with no ADE Cloud computer.
 *
 * Calls (`window.ade.cloud.*(args, pin)`, runtime action domain `cloud`):
 * `previewKeptLaneRestore` and `getKeptLaneRestore` read;
 * `restoreKeptLane` writes and returns at once with a running record. `pin`
 * is the DESTINATION machine's project binding.
 *
 * Order (the brain's job, `keptLaneRestore.ts`): the lane's branch and saved
 * work first (nothing pushed, newer local work never overwritten), then each
 * chat and CLI (its saved copy moves to this machine's key before a chat
 * restores), then the kept-lane record is forgotten only when everything
 * came back. A failure leaves the record; a new `restoreKeptLane` goes on.
 *
 * `fromComputer` moves a lane whose ADE Cloud computer is asleep, with no
 * wake. The brain first deletes that computer and keeps its lane, but only
 * while it rests with every lane's work saved (the server checks:
 * `keepLane.onlyIfSaved`). Then the restore above runs. When the save is not
 * complete, or the computer woke, nothing is deleted and the record fails
 * with `wakeInstead`: the person wakes it and moves the lane live.
 */

import type { CloudIgnoredFiles } from "../../../account-directory/src/cloud/contract";

export type CloudKeptLaneRestoreHistory = "full" | "transcript" | "fresh";

/** The lane's ADE Cloud computer, asleep: the move releases it first. */
export type CloudKeptLaneRestoreFromComputer = { instanceId: string };
export type CloudKeptLaneRestorePreviewArgs = { laneId: string; fromComputer?: CloudKeptLaneRestoreFromComputer | null };
export type CloudKeptLaneRestorePreview = {
  laneId: string;
  laneName: string;
  branchRef: string | null;
  /** The project of this pin has the lane's repository (same origin). */
  hasRepository: boolean;
  /** The newest lane backup that holds work not on GitHub; null = none. */
  work: { unpushedCommits: number | null; changedFiles: number | null; bytes: number | null } | null;
  chats: Array<{
    chatId: string;
    title: string | null;
    provider: string | null;
    kind: "chat" | "cli";
    /** full = fork capsule; transcript = replay of the saved transcript; fresh = CLI starts new. */
    history: CloudKeptLaneRestoreHistory;
  }>;
  /**
   * Chats and CLIs whose saved copy is on another computer of the person's
   * (a move there that didn't finish). They can't come here, and the move
   * keeps the lane on ADE Cloud until they do. Absent from an older brain.
   */
  blocked?: Array<{ chatId: string; title: string | null; kind: "chat" | "cli" }>;
  /**
   * For `fromComputer`: whether its saved copy holds all of the lane's work
   * (`saved`), else why not (`reason`; the move then wakes it instead). And
   * the files git ignores on it, which no saved copy holds.
   */
  fromComputer?: { saved: boolean; reason: string | null; ignored: CloudIgnoredFiles | null } | null;
};

export type CloudKeptLaneRestoreArgs = { laneId: string; fromComputer?: CloudKeptLaneRestoreFromComputer | null };
export type CloudKeptLaneRestoreGetArgs = { restoreId: string };
export type CloudKeptLaneRestoreChatState = "pending" | "restored" | "failed";
export type CloudKeptLaneRestoreRecord = {
  restoreId: string;
  laneId: string;
  laneName: string;
  state: "running" | "completed" | "failed";
  /** The lane on this machine once its branch is in. */
  localLaneId: string | null;
  /** `release`: the asleep computer is deleted and its lane kept (`fromComputer` only). */
  step: "release" | "lane" | "chats" | "cleanup" | "done";
  chats: Array<{
    chatId: string;
    title: string | null;
    state: CloudKeptLaneRestoreChatState;
    history: CloudKeptLaneRestoreHistory | null;
    error: string | null;
  }>;
  error: string | null;
  /** The release refused (its save isn't complete, or it woke): nothing was deleted; wake it and move it live. */
  wakeInstead?: boolean;
  startedAt: string;
  updatedAt: string;
};

/**
 * The fields of a preview, restore or get call, picked from any input by
 * shape (an action's args, a phone's sync payload). The brain's store checks
 * the values themselves.
 */
export function pickKeptLaneRestoreArgs(value: unknown): { laneId?: string; restoreId?: string; fromComputer?: CloudKeptLaneRestoreFromComputer } {
  const record = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {});
  const args = record(value);
  const from = record(args.fromComputer);
  return {
    ...(typeof args.laneId === "string" ? { laneId: args.laneId } : {}),
    ...(typeof args.restoreId === "string" ? { restoreId: args.restoreId } : {}),
    ...(typeof from.instanceId === "string" ? { fromComputer: { instanceId: from.instanceId } } : {}),
  };
}
