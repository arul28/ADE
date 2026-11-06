import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { AdeExpectedError } from "../../../shared/expectedError";
import { nonAsarFs } from "../shared/nonAsarFs";
import { removeTreeOffProcess } from "../shared/removeTreeOffProcess";
import {
  deletingTrashName,
  isInUseError,
  removeTrashInBackground,
  sweepDeletingTrash,
} from "../shared/deletingTrash";

/**
 * Removing lane folders: the delete-with-recovery every lane removal uses,
 * and the Windows steps lane delete and Archive & Reclaim share (wait for the
 * folder to be let go, move it aside, have git drop its record, remove the
 * trash in the background).
 */

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

async function makeTreeWritableForRemoval(targetPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await nonAsarFs.promises.lstat(targetPath);
  } catch {
    return;
  }

  if (stat.isSymbolicLink()) return;

  try {
    await nonAsarFs.promises.chmod(targetPath, stat.mode | 0o700);
  } catch {
    // Best effort. The following rm will surface any remaining failure.
  }

  if (!stat.isDirectory()) return;

  let entries: string[];
  try {
    entries = await nonAsarFs.promises.readdir(targetPath);
  } catch (error) {
    if (!isPermissionError(error)) return;
    try {
      await nonAsarFs.promises.chmod(targetPath, stat.mode | 0o700);
      entries = await nonAsarFs.promises.readdir(targetPath);
    } catch {
      return;
    }
  }

  await Promise.all(entries.map((entry) => makeTreeWritableForRemoval(path.join(targetPath, entry))));
}

/** Each attempt's child already retries a held file for ~9 s (see removeTreeOffProcess). */
const WORKTREE_REMOVE_ATTEMPTS = 3;
const WORKTREE_REMOVE_RETRY_MS = 250;

/**
 * Remove a worktree directory, recovering from read-only files and — on
 * Windows — handles a just-killed git (or an indexer/AV scanner) still holds:
 * those fail with EBUSY/EPERM/EACCES until the handle closes, so retry on a
 * bounded schedule instead of failing the cleanup outright.
 *
 * Every attempt runs in a separate process (see removeTreeOffProcess): a lane
 * folder can hold hundreds of thousands of files, and a removal that stopped
 * at one held file can leave most of them, so even a retry here would stall
 * every other file operation in this process.
 */
export async function removeWorktreeDirectoryWithRecovery(targetPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeTreeOffProcess(targetPath);
      return;
    } catch (error) {
      if (!isInUseError(error) || attempt >= WORKTREE_REMOVE_ATTEMPTS) throw error;
      if (isPermissionError(error)) await makeTreeWritableForRemoval(targetPath);
      if (attempt > 1 || !isPermissionError(error)) {
        await new Promise((resolve) => setTimeout(resolve, WORKTREE_REMOVE_RETRY_MS));
      }
    }
  }
}

/** A lane folder renamed aside (see `shared/deletingTrash`), removed without waiting. */
export function removeLaneTrashInBackground(trashPath: string, logger: Logger): void {
  removeTrashInBackground(trashPath, {
    remove: removeWorktreeDirectoryWithRecovery,
    logger,
    events: { done: "lane.delete.background_remove_done", failed: "lane.delete.background_remove_failed" },
  });
}

/** Finish removing renamed-aside lane folders an earlier run did not get to. */
export function sweepLaneDeletingTrash(parentDir: string, logger: Logger): Promise<void> {
  return sweepDeletingTrash(parentDir, {
    // A folder Git still has metadata for was never pruned — its move back
    // failed, or Git kept a locked worktree. That checkout is not trash.
    keep: gitAdminDirStillExists,
    removeInBackground: (trashPath) => removeLaneTrashInBackground(trashPath, logger),
  });
}

export async function gitAdminDirStillExists(checkoutPath: string): Promise<boolean> {
  let pointer: string;
  try {
    pointer = await fs.promises.readFile(path.join(checkoutPath, ".git"), "utf8");
  } catch (error) {
    // No `.git` at all is the pruned case. Anything else (a `.git` directory,
    // an unreadable file) is not something to sweep.
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (!gitdir) return true;
  return fs.existsSync(path.resolve(checkoutPath, gitdir));
}

/**
 * A lane folder something on this computer still holds open (an editor, a
 * dev server, Defender, an agent CLI that has not exited yet). Nothing was
 * removed; the reclaim is recorded as kept and tried again later, without an
 * error for the person.
 */
/**
 * A reclaim refused because the lane has work saved nowhere else (uncommitted
 * files, commits no remote has) and nobody confirmed losing it. The cleanup's
 * retry stops on this and waits for a person, instead of trying every tick.
 */
export class LaneUnsavedWorkError extends AdeExpectedError {
  // No `name` of its own: Electron prints it into the message a window shows.
  constructor(message: string) {
    super(message, "user");
  }
}

export class LaneFolderBusyError extends Error {
  constructor(message = "Some files in this lane are still in use. ADE kept the folder and will try again later.") {
    super(message);
    this.name = "LaneFolderBusyError";
  }
}

/** How long a reclaim waits for the lane's own processes to let go of its folder. */
const FOLDER_RELEASE_WAIT_MS = 20_000;
const FOLDER_RELEASE_POLL_MS = 500;

/**
 * Windows: move a lane folder out of its place once nothing holds it.
 *
 * Windows refuses to rename a folder while any process has a file open in it
 * or works inside it, and the refusal changes nothing. So the rename is both
 * the wait for the lane's chats, terminals and agent CLIs (`claude.exe`,
 * `codex.exe` and their MCP children) to finish exiting after archive stopped
 * them, and the check that nothing outside ADE is using the folder. Deleting
 * in place instead stops partway at the first held file and leaves half a
 * checkout, which git may then stop listing.
 *
 * Returns the new path, a `.ade-deleting-` name beside the original that the
 * trash sweeps finish if this process stops first. Throws
 * {@link LaneFolderBusyError} when the folder is still held at the deadline.
 */
export async function moveLaneFolderAsideWhenReleased(target: string): Promise<string> {
  const trashPath = path.join(path.dirname(target), deletingTrashName(path.basename(target)));
  const deadline = Date.now() + FOLDER_RELEASE_WAIT_MS;
  for (;;) {
    try {
      await fs.promises.rename(target, trashPath);
      return trashPath;
    } catch (error) {
      if (!isInUseError(error)) throw error;
      if (Date.now() >= deadline) throw new LaneFolderBusyError();
      await new Promise((resolve) => setTimeout(resolve, FOLDER_RELEASE_POLL_MS));
    }
  }
}

/**
 * Windows: turn a rename aside into a removal. Moves the worktree folder
 * aside (`moveAside`; null when it could not, with nothing changed), has git
 * prune its now-missing record, and confirms git no longer lists it. When git
 * kept the record (a locked worktree, a failed prune, or no way to tell), the
 * folder goes back where it was so it stays a working checkout.
 *
 * Returns the trash path, which the caller removes; or a null trash path with
 * the folder in its place, and `keptReason` when it had been moved and came
 * back. Throws when the folder could not be moved back.
 */
export async function moveWorktreeAsideAndPrune(
  target: string,
  opts: {
    moveAside: (target: string) => Promise<string | null>;
    /** Null when the prune succeeded, else what git said. */
    prune: () => Promise<string | null>;
    /** Whether git still lists `target` as a worktree; null when it could not tell. */
    isListed: () => Promise<boolean | null>;
  },
): Promise<{ trashPath: string; keptReason?: undefined } | { trashPath: null; keptReason?: string }> {
  const trashPath = await opts.moveAside(target);
  if (!trashPath) return { trashPath: null };
  let keptReason: string | null = null;
  try {
    keptReason = await opts.prune();
    if (keptReason === null) {
      const listed = await opts.isListed();
      // Unknown counts as listed: the folder goes back.
      if (listed !== false) keptReason = "Git kept its record of this worktree.";
    }
  } catch (error) {
    keptReason = error instanceof Error ? error.message : String(error);
  }
  if (keptReason === null) return { trashPath };
  try {
    await fs.promises.rename(trashPath, target);
  } catch (restoreError) {
    throw new Error(
      `ADE moved the lane folder to ${trashPath} and could not move it back: ${
        restoreError instanceof Error ? restoreError.message : String(restoreError)
      }`,
    );
  }
  return { trashPath: null, keptReason };
}

/**
 * Git's own refusals for `git worktree remove --force`, checked by ADE where
 * ADE removes the files itself (Windows): a locked worktree is never removed,
 * and submodules only with the person's confirmation that work may be lost
 * (`forceDirty`, which also covers uncommitted files). Null when it may go.
 */
export async function worktreeRemovalRefusal(checkoutPath: string, forceDirty: boolean): Promise<string | null> {
  let pointer: string;
  try {
    pointer = await fs.promises.readFile(path.join(checkoutPath, ".git"), "utf8");
  } catch {
    return null;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (!gitdir) return null;
  const adminDir = path.resolve(checkoutPath, gitdir);
  if (fs.existsSync(path.join(adminDir, "locked"))) {
    return "Git has this lane's worktree locked. Unlock it (git worktree unlock) and try again.";
  }
  if (!forceDirty && (fs.existsSync(path.join(adminDir, "modules")) || fs.existsSync(path.join(checkoutPath, ".gitmodules")))) {
    return "This lane has submodules. Confirm that their changes may be lost.";
  }
  return null;
}
