/**
 * accountUsageSource.ts
 *
 * Identity of the transcript files a machine's usage numbers came from.
 *
 * Account-wide usage merges one rollup per machine. Two machines that mount the
 * same home directory — a synced home, an SMB/NFS share, a roaming profile —
 * scan the *same* transcript files and would otherwise double every token on
 * the page. Nothing about a machine's own identity can detect that: both report
 * distinct machine keys, distinct hostnames, and (usually) the very same
 * `/Users/<name>` path, so a bare path comparison is both a false-positive risk
 * across separate machines with the same username and a false negative whenever
 * one side mounts the share somewhere else.
 *
 * So the identity travels with the *files*: a marker id written once into the
 * transcript home. Whoever reads that directory reads that id, wherever it is
 * mounted and whatever the machine is called. Paths remain part of the record
 * for the degraded case where the marker cannot be written (a read-only mount,
 * a locked-down profile) — there the merge requires identical roots before it
 * will call two sides the same at all.
 *
 * The marker is terminal. It used to be overturnable by a token-level
 * comparison of the two machines' recent history, on the theory that a copied
 * disk image hands two genuinely separate machines the same id. That comparison
 * decided "do these two read the same files?" from aggregate day totals, so it
 * had to survive timezone skew, DST, partial scans, key-spelling drift between
 * ADE versions, and N-way merges — and every one of those was a way to read one
 * shared mount as two machines and silently double every token on the page. It
 * is gone.
 *
 * The trade that buys: two machines cloned from one disk image share a marker,
 * so they merge and the account under-counts. That failure is *visible* — the
 * machine list shows the second one as counted once with the first — and it is
 * the opposite direction from silent double-counting. Deleting
 * `.ade-usage-source` on one of the two mints a fresh id on its next scan.
 *
 * Windows: every path is folded through `pathKey`, which normalizes separators,
 * strips the `\\?\` prefix, collapses `.`/`..`, and lower-cases on
 * case-insensitive platforms. No comparison in this file uses `===` on a raw
 * path.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdeUsageTranscriptSource } from "../../../shared/types";
import { pathKey } from "../shared/pathCompare";

/** Marker file name. Dot-prefixed so it stays out of the way of the provider CLIs. */
export const USAGE_SOURCE_MARKER_FILE = ".ade-usage-source";

export type UsageSourceFsApi = {
  readFileSync: (file: string) => string;
  writeFileSync: (file: string, data: string) => void;
  mkdirSync: (dir: string) => void;
  /**
   * Optional so an in-memory test double stays a three-method object. When it
   * is absent the marker is written in place, which is only ever a test path.
   */
  renameSync?: (from: string, to: string) => void;
  /** Best effort; a leftover temp file is harmless. */
  rmSync?: (file: string) => void;
};

const defaultFs: UsageSourceFsApi = {
  readFileSync: (file) => fs.readFileSync(file, "utf8"),
  writeFileSync: (file, data) => fs.writeFileSync(file, data, "utf8"),
  mkdirSync: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (file) => {
    fs.rmSync(file, { force: true });
  },
};

/**
 * One-way fold of a transcript root.
 *
 * A rollup crosses the machine boundary over a `viewerAllowed` command, and the
 * contract this file and `accountUsageRollup.ts` both state is that no path
 * leaves the machine that scanned it. `roots` is only ever consumed as an
 * equality key by `isSameTranscriptSource`, so a digest serves that use exactly
 * as well as the path did — and `/Users/alice/.claude` stops travelling.
 *
 * The input must already be `pathKey`-folded: hashing is the last step, or two
 * spellings of one path would stop matching.
 */
export function transcriptRootDigest(foldedRoot: string): string {
  return crypto.createHash("sha256").update(foldedRoot).digest("hex").slice(0, 32);
}

/**
 * Shape of an acceptable marker. Deliberately wider than the UUID this code
 * writes: the file lives in a directory shared with other tools and future ADE
 * versions, and rejecting an id merely because it is not a UUID would split one
 * source in two the moment the format changes.
 */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Read — or, once, create — the marker id in `home`.
 *
 * Returns `null` rather than throwing on any failure. A machine that cannot
 * write a marker is still a perfectly good contributor; it just falls back to
 * the roots+digest comparison, and the page must never fail over a dot file.
 */
export function readOrCreateUsageSourceId(
  home: string = os.homedir(),
  io: UsageSourceFsApi = defaultFs,
  makeId: () => string = () => crypto.randomUUID(),
): string | null {
  if (!home) return null;
  const markerPath = path.join(home, USAGE_SOURCE_MARKER_FILE);
  const readMarker = (): string | null => {
    try {
      const existing = io.readFileSync(markerPath).trim();
      return SOURCE_ID_PATTERN.test(existing) ? existing : null;
    } catch {
      return null;
    }
  };

  const existing = readMarker();
  if (existing) return existing;

  try {
    const created = makeId();
    io.mkdirSync(home);
    if (io.renameSync) {
      // Write-then-rename, never write-in-place: a reader on a genuinely shared
      // mount must see either the old marker or the new one, never a truncated
      // file that fails `SOURCE_ID_PATTERN` and silently splits one source in
      // two. The temp name carries the id so two machines racing here cannot
      // collide on the temp file itself.
      const tempPath = `${markerPath}.${created}.tmp`;
      try {
        io.writeFileSync(tempPath, `${created}\n`);
        io.renameSync(tempPath, markerPath);
      } catch (error) {
        io.rmSync?.(tempPath);
        throw error;
      }
      // Read back rather than trusting what we just wrote: if another machine
      // on the same mount renamed its own marker in after ours, the id on disk
      // is the one both sides must converge on.
      return readMarker() ?? created;
    }
    io.writeFileSync(markerPath, `${created}\n`);
    return created;
  } catch {
    // Losing the create race is not a failure: whoever won left a usable id.
    return readMarker();
  }
}

export function buildTranscriptSource({
  roots,
  home = os.homedir(),
  platform = process.platform,
  io = defaultFs,
}: {
  roots: readonly string[];
  home?: string;
  platform?: NodeJS.Platform;
  io?: UsageSourceFsApi;
}): AdeUsageTranscriptSource {
  // Fold first, hash second. `pathKey` is what makes `C:\Users\Dev\.claude`,
  // `c:/users/dev/.claude` and `\\?\C:\Users\Dev\.claude` one root; hashing
  // before folding would turn each spelling into a different key.
  const normalized = Array.from(new Set(roots.filter(Boolean).map((root) => pathKey(root, platform)))).sort();
  return {
    sourceId: readOrCreateUsageSourceId(home, io),
    roots: normalized.map(transcriptRootDigest),
  };
}

/**
 * True when two machines read the same transcript files.
 *
 * Two steps, and nothing else.
 *
 * 1. **Both sides carry a marker: the ids decide, and that is the answer.**
 *    Equal ids means one directory read twice. Different ids means two
 *    directories — a machine that wrote its own marker is, by construction, not
 *    reading someone else's — and falling through to the path heuristic there
 *    is how same-username laptops get wrongly collapsed into one.
 * 2. **A marker missing on either side: the folded roots must match exactly.**
 *    Digested paths are a weak signal (`/Users/dev/.claude` is everybody's),
 *    but they are the only one left when the marker could not be read. An empty
 *    root list is never a match.
 */
export function isSameTranscriptSource(
  a: AdeUsageTranscriptSource | null | undefined,
  b: AdeUsageTranscriptSource | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.sourceId && b.sourceId) return a.sourceId === b.sourceId;
  if (a.roots.length === 0 || b.roots.length === 0) return false;
  if (a.roots.length !== b.roots.length) return false;
  // `roots` are `pathKey`-folded then hashed at build time, so this is a
  // platform-correct comparison rather than a raw path one.
  for (let index = 0; index < a.roots.length; index += 1) {
    if (a.roots[index] !== b.roots[index]) return false;
  }
  return true;
}
