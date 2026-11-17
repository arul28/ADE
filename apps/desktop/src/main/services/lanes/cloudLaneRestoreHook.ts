/**
 * The lane launch's seam for lane backups on an ADE Cloud computer
 * (`apps/ade-cli/src/services/cloudChats/cloudLaneBackup.ts`). Only a cloud
 * computer's brain installs it; on every other machine both calls do nothing.
 *
 * 1. `prepareCloudLaneBranch`, before an existing-branch lane is imported:
 *    a branch the person never pushed is not on GitHub, so the new computer
 *    makes it locally from the lane's backup. The import must then not
 *    publish it (`publishUpstream: false`): ADE never pushes on its own.
 * 2. `restoreCloudLaneWork`, once the lane exists and before its chat
 *    starts: applies the lane's backup when the lane lacks that work.
 *
 * Either one failing never fails the launch: the backup stays on the
 * server for the person, and the answer is a note for the launch card.
 */

export type CloudLaneBranchPrepare = (args: { laneId: string; branchRef: string; projectRoot: string }) => Promise<{ created: boolean }>;
export type CloudLaneRestore = (args: { laneId: string; worktreePath: string; projectRoot: string }) => Promise<string | null>;

let prepare: CloudLaneBranchPrepare | null = null;
let restore: CloudLaneRestore | null = null;

export function installCloudLaneRestore(handlers: { prepareBranch: CloudLaneBranchPrepare; restore: CloudLaneRestore }): void {
  prepare = handlers.prepareBranch;
  restore = handlers.restore;
}

export function cloudLaneRestoreInstalled(): boolean {
  return restore != null;
}

/** True when the branch was made here from the lane's backup (the import must not publish it). */
export async function prepareCloudLaneBranch(args: { laneId: string; branchRef: string; projectRoot: string }): Promise<boolean> {
  if (!prepare) return false;
  return (await prepare(args)).created;
}

/** A note for the launch card, or null. Throws only when the hook itself throws; the caller keeps the launch going. */
export async function restoreCloudLaneWork(args: { laneId: string; worktreePath: string; projectRoot: string }): Promise<string | null> {
  return restore ? await restore(args) : null;
}
