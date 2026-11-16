/**
 * Scratch folders: `ade shell start --machine <this machine> --scratch -- <cmd>`
 * runs a command that needs no code (nvidia-smi, a disk check) in an empty
 * temporary folder under ADE's own home, with no work copy and no git. The
 * folder goes when the command's shell ends; the sweep removes any a
 * restart left behind, and never one whose shell still runs.
 */

import fs from "node:fs";
import path from "node:path";
import { isPathInside, pathComparisonKey, pathsEqual } from "../shared/pathCompare";
import { defaultAdeHome, remoteWorkLaneIdFor, type RemoteWorkLogger } from "./remoteWorkCopyService";

/** A scratch folder older than this is left over (its shell ended while no brain ran) and goes in the sweep. */
const REMOTE_WORK_SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Scratch folders made by this process whose shell has not ended yet; the sweep leaves them. */
const liveScratchDirs = new Set<string>();

function scratchRoot(adeHome: string): string {
  return path.join(adeHome, "remote-work", "scratch");
}

/** A new, empty scratch folder for `owner`'s one command. It counts as live until it is removed. */
export function createRemoteWorkScratchDir(owner: string, adeHome: string = defaultAdeHome()): string {
  const root = scratchRoot(adeHome);
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${remoteWorkLaneIdFor(owner)}-`));
  liveScratchDirs.add(pathComparisonKey(dir));
  return dir;
}

/** Remove a scratch folder (its shell ended). Anything outside the scratch root is refused (logged, kept). */
export function removeRemoteWorkScratchDir(dir: string, adeHome: string = defaultAdeHome(), logger?: RemoteWorkLogger): void {
  liveScratchDirs.delete(pathComparisonKey(dir));
  const root = scratchRoot(adeHome);
  if (pathsEqual(dir, root) || !isPathInside(dir, root)) {
    logger?.warn("remote_work.scratch_outside_root", { dir });
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    // A file still held open (Windows); the sweep tries again.
    logger?.warn("remote_work.scratch_remove_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Remove scratch folders older than a week, except one whose shell still runs. */
export function sweepRemoteWorkScratch(adeHome: string = defaultAdeHome(), logger?: RemoteWorkLogger): void {
  const root = scratchRoot(adeHome);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // No scratch folder made yet.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      logger?.warn("remote_work.scratch_sweep_read_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const cutoff = Date.now() - REMOTE_WORK_SCRATCH_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (liveScratchDirs.has(pathComparisonKey(dir))) continue;
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) removeRemoteWorkScratchDir(dir, adeHome, logger);
    } catch (error) {
      // Gone meanwhile is expected.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        logger?.warn("remote_work.scratch_sweep_stat_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
