import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encodeDisplayImage } from "../chat/providerInlineImage";
import { readArtifactFileBytes } from "./artifactByteRange";

/**
 * The display copy of a proof picture: what a paired desktop shows in the
 * transcript instead of the original. A 2880x1800 screenshot is 2.7 MB as a
 * PNG and about 0.5 MB as this copy, so it shows in a fifth of the time on a
 * slow link. The original stays on this computer, unchanged, for the model,
 * for copy and for save.
 *
 * Each copy is made once and kept in the project's cache, keyed by the
 * original's path, size and change time; a changed original gets a new copy.
 */
const DISPLAY_EDGE_PX = 1920;
const DISPLAY_JPEG_QUALITY = 85;
/** Copies kept per project; the oldest go first. About 250 MB at the most. */
const DISPLAY_COPIES_KEPT = 400;
const DISPLAY_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
/** A copy this new may be open in a read; pruning leaves it until it has rested. */
const PRUNE_GRACE_MS = 60_000;

export type ArtifactDisplayCopies = {
  /** The path of the display copy of `sourcePath`, or null to show the original. */
  pathFor: (sourcePath: string) => Promise<string | null>;
};

export function createArtifactDisplayCopies(cacheDir: string): ArtifactDisplayCopies {
  const dir = path.join(cacheDir, "artifact-display");
  /** Originals that get no copy (no smaller copy helps), by key. */
  const noCopy = new Set<string>();
  const inFlight = new Map<string, Promise<string | null>>();
  // One encode at a time: a chat that opens with twenty pictures must not
  // hold this computer's event loop for twenty decodes in a row.
  let queue: Promise<unknown> = Promise.resolve();

  const make = async (sourcePath: string, key: string, target: string): Promise<string | null> => {
    // The same no-follow, descriptor-checked read the range reader uses: a
    // workspace process must not be able to point the conversion at another
    // file between the jail check and this read.
    const bytes = await readArtifactFileBytes(sourcePath, DISPLAY_SOURCE_MAX_BYTES);
    if (!bytes) {
      noCopy.add(key);
      return null;
    }
    const copy = await encodeDisplayImage(bytes, DISPLAY_EDGE_PX, DISPLAY_JPEG_QUALITY);
    if (!copy) {
      noCopy.add(key);
      return null;
    }
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.promises.writeFile(temp, copy.data);
      await fs.promises.rename(temp, target);
    } catch (error) {
      // A half-written copy is not a copy: the next showing makes it again.
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    void prune(dir).catch(() => {});
    return target;
  };

  return {
    async pathFor(sourcePath) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(sourcePath);
      } catch {
        return null;
      }
      if (!stat.isFile() || stat.size > DISPLAY_SOURCE_MAX_BYTES) return null;
      const key = createHash("sha256")
        .update(`${sourcePath}\u0000${stat.size}\u0000${stat.mtimeMs}`)
        .digest("hex")
        .slice(0, 32);
      if (noCopy.has(key)) return null;
      const target = path.join(dir, `${key}.jpg`);
      if (await fs.promises.access(target).then(() => true, () => false)) return target;
      let running = inFlight.get(key);
      if (!running) {
        const started = queue.then(() => make(sourcePath, key, target));
        running = started.catch(() => null).finally(() => inFlight.delete(key));
        queue = running;
        inFlight.set(key, running);
      }
      return running;
    },
  };
}

async function prune(dir: string): Promise<void> {
  const names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".jpg"));
  if (names.length <= DISPLAY_COPIES_KEPT) return;
  const now = Date.now();
  const dated = await Promise.all(names.map(async (name) => {
    const full = path.join(dir, name);
    const stat = await fs.promises.stat(full).catch(() => null);
    return { full, at: stat?.mtimeMs ?? 0 };
  }));
  dated.sort((a, b) => a.at - b.at);
  for (const { full, at } of dated.slice(0, dated.length - DISPLAY_COPIES_KEPT)) {
    // One just made may be read now; only a copy that has rested goes.
    if (now - at < PRUNE_GRACE_MS) continue;
    await fs.promises.rm(full, { force: true }).catch(() => {});
  }
}
