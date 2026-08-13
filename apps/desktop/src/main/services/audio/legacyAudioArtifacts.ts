import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Logger } from "../logging/logger";

/**
 * Delete the speech model ADE used to keep for itself, and sweep stale clips.
 *
 * ADE once shipped dictation compiled in, and downloaded a ~141 MB speech model
 * into `<userData>/whisper/` on first use. Nothing reaches that path any more —
 * speech left core entirely, and the app now only records clips on a plugin's
 * behalf. Left alone, a machine that ever pressed the old mic button would
 * carry 141 MB of orphaned bytes forever, and there is no UI that would ever
 * mention them again, so the app update that removed the feature is the only
 * moment that can clean up after it.
 *
 * That old build also staged its WAV clips in a temp directory of its own, so
 * that is deleted too. Both paths are hard-coded strings, and one of them
 * happens to spell a plugin's name — that is a HISTORICAL PATH, not a coupling.
 * Core has no knowledge of that plugin and no behavior that depends on it; this
 * is a janitor deleting files a design that no longer exists left behind, and
 * it has to name them to delete them. Leaving crumbs on a user's disk to keep a
 * grep clean would be the wrong trade.
 *
 * Four properties this has to hold, because it runs unattended on every boot:
 *
 *   - It never touches a PLUGIN's data. A plugin that acquires its own model
 *     keeps it under the plugins root, and the paths below are the app's own
 *     legacy ones. That is why they are spelled out literally rather than
 *     pattern-matched: a sweep for "model-looking files" would eventually find
 *     a plugin's.
 *   - It is idempotent and silent. A machine that never used dictation has
 *     none of these paths, which is not an error and produces no log line.
 *   - It leaves recent clips alone. The live capture directory is swept by AGE,
 *     because a clip handed to a plugin moments ago is still being read.
 *   - It never throws. Losing this is losing some disk, not a start-up.
 */

/** Clips older than this are from a crashed run, not an in-flight capture. */
const STALE_CLIP_AGE_MS = 6 * 60 * 60_000;

export type LegacyAudioArtifactPurge = {
  /** Absolute paths that existed and were removed. */
  removed: string[];
  /** Bytes reclaimed, best effort (unreadable entries count as zero). */
  freedBytes: number;
};

function directorySize(target: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(child);
      } else {
        total += fs.statSync(child).size;
      }
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}

/**
 * The legacy directories, given the two roots that locate them.
 *
 * Exported so the test names the same paths the app deletes instead of
 * restating them — a rename here that the test did not follow would otherwise
 * pass while deleting nothing.
 */
export function legacyAudioArtifactPaths(args: {
  userDataPath: string;
  tmpdir?: string;
}): string[] {
  return [
    // The runtime-downloaded speech model the old transcription service used,
    // plus any `.part` file from an interrupted download. This is the whole
    // 141 MB, and the main reason this module exists.
    path.join(args.userDataPath, "whisper"),
    // Where that same build staged its captured clips. A legacy path from
    // before the extraction: the string is what the old code created, not a
    // reference to anything core still knows about. Distinct from today's
    // capture directory, which is swept by age below rather than deleted.
    path.join(args.tmpdir ?? os.tmpdir(), "ade-voice"),
  ];
}

/**
 * Remove stale clips from the live capture directory.
 *
 * Separate from the legacy paths because this directory is still in use, and
 * clips there are caller-owned: only files old enough to be leftovers from a
 * crashed run are removed, so a capture that is mid-flight in another window —
 * or a clip a plugin is still reading — survives a second window's start-up.
 */
function sweepStaleClips(captureDir: string, now: number): { removed: string[]; freedBytes: number } {
  const removed: string[] = [];
  let freedBytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(captureDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = path.join(captureDir, entry.name);
    try {
      const stat = fs.statSync(target);
      if (now - stat.mtimeMs < STALE_CLIP_AGE_MS) continue;
      fs.rmSync(target, { force: true });
      removed.push(target);
      freedBytes += stat.size;
    } catch {
      // Unreadable or already gone: nothing to reclaim, nothing to report.
    }
  }
  return { removed, freedBytes };
}

export function purgeLegacyAudioArtifacts(args: {
  userDataPath: string;
  /** The live scratch dir, swept for leftovers rather than deleted. */
  captureDir?: string | null;
  tmpdir?: string;
  logger?: Logger | null;
  now?: number;
}): LegacyAudioArtifactPurge {
  const removed: string[] = [];
  let freedBytes = 0;

  for (const target of legacyAudioArtifactPaths(args)) {
    try {
      if (!fs.existsSync(target)) continue;
      freedBytes += directorySize(target);
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      // Best effort: a locked or permission-denied path is retried next start.
    }
  }

  if (args.captureDir) {
    const swept = sweepStaleClips(args.captureDir, args.now ?? Date.now());
    removed.push(...swept.removed);
    freedBytes += swept.freedBytes;
  }

  // Silent on the common path — most machines have nothing here, every start,
  // forever, and a line saying so is noise in every log ADE ever ships.
  if (removed.length > 0) {
    args.logger?.info("audio.legacy_artifacts_removed", { count: removed.length, freedBytes });
  }
  return { removed, freedBytes };
}
