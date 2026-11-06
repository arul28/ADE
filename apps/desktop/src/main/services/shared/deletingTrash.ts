import type fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { nonAsarFs } from "./nonAsarFs";

/**
 * A folder renamed aside so its files can be removed after the caller
 * returns: `.<name>.ade-deleting-<8 hex>`, next to where it lived. The name is
 * ADE's own, which is what makes sweeping a forgotten one safe. Lane delete,
 * Archive & Reclaim and the build output cleanup all use it.
 */
export const DELETING_TRASH_SUFFIX = ".ade-deleting-";
export const DELETING_TRASH_NAME = /^\..+\.ade-deleting-[0-9a-f]{8}$/;

/** A fresh trash name for a folder called `baseName`. */
export function deletingTrashName(baseName: string): string {
  return `.${baseName}${DELETING_TRASH_SUFFIX}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** What a folder held open by another program fails to rename or remove with. */
const IN_USE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export function isInUseError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return Boolean(code && IN_USE_CODES.has(code));
}

// Trash removals running in this process, shared by every caller so a lane
// sweep and a build output sweep of the same folder never remove one twice.
const trashRemovalsInFlight = new Set<string>();

/**
 * Removes a folder already renamed aside, without waiting for it. A failure is
 * logged and left for the next sweep of its parent folder.
 */
export function removeTrashInBackground(
  trashPath: string,
  opts: {
    remove: (trashPath: string) => Promise<void>;
    logger: Pick<Logger, "info" | "warn">;
    events: { done: string; failed: string };
  },
): void {
  const key = path.resolve(trashPath);
  if (trashRemovalsInFlight.has(key)) return;
  trashRemovalsInFlight.add(key);
  const t0 = Date.now();
  void opts.remove(key)
    .then(() => {
      opts.logger.info(opts.events.done, { path: key, durationMs: Date.now() - t0 });
    })
    .catch((error) => {
      opts.logger.warn(opts.events.failed, {
        path: key,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      trashRemovalsInFlight.delete(key);
    });
}

/**
 * Finishes removing the trash folders in `parentDir` an earlier run did not
 * get to: real folders (no links) with ADE's trash name that pass `accept`,
 * except the ones `keep` says are not trash after all.
 */
export async function sweepDeletingTrash(
  parentDir: string,
  opts: {
    /** Narrows the trash names this sweep owns. */
    accept?: (name: string) => boolean;
    keep: (trashPath: string) => Promise<boolean>;
    removeInBackground: (trashPath: string) => void;
  },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await nonAsarFs.promises.readdir(parentDir, { withFileTypes: true });
  } catch {
    // No such folder: nothing to sweep.
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !DELETING_TRASH_NAME.test(entry.name)) continue;
    if (opts.accept && !opts.accept(entry.name)) continue;
    const trashPath = path.join(parentDir, entry.name);
    if (await opts.keep(trashPath)) continue;
    opts.removeInBackground(trashPath);
  }
}
