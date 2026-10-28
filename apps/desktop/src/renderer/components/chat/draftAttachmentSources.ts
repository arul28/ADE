/**
 * Where each draft attachment's bytes came from, so a draft can follow the
 * person to another machine.
 *
 * A staged attachment's path names a file on the machine that staged it. When
 * the draft's machine changes, that path means nothing on the new one; the
 * file has to be staged there again. Images can be read back from the old
 * machine, but other files have no reader, so without this the draft drops
 * them: a long paste (staged as a text file) vanished on every machine switch.
 *
 * Two sources, both known only to this window:
 * - `bytes`: the composer read the bytes itself (a paste, a clipboard file, a
 *   file with no path). Kept so they can be saved again on the new machine.
 * - `local`: a file on this computer, staged by path. Staged again from the
 *   same path.
 *
 * Bounded: the newest entries are kept up to a total size, which is far more
 * than a draft holds. A forgotten entry only means that attachment cannot move.
 */

export type DraftAttachmentSource =
  | { kind: "bytes"; data: string; filename: string; pastedLines?: number }
  | { kind: "local"; sourcePath: string; filename: string };

/** Total base64 characters kept for `bytes` entries. */
const MAX_BYTES_CHARS = 64 * 1024 * 1024;
const MAX_ENTRIES = 200;

const sources = new Map<string, DraftAttachmentSource>();
let bytesChars = 0;

function sizeOf(source: DraftAttachmentSource): number {
  return source.kind === "bytes" ? source.data.length : 0;
}

export function rememberDraftAttachmentSource(path: string, source: DraftAttachmentSource): void {
  const previous = sources.get(path);
  if (previous) {
    bytesChars -= sizeOf(previous);
    sources.delete(path);
  }
  sources.set(path, source);
  bytesChars += sizeOf(source);
  for (const [key, entry] of sources) {
    if ((bytesChars <= MAX_BYTES_CHARS && sources.size <= MAX_ENTRIES) || sources.size <= 1) break;
    sources.delete(key);
    bytesChars -= sizeOf(entry);
  }
}

export function draftAttachmentSource(path: string): DraftAttachmentSource | null {
  return sources.get(path) ?? null;
}

/** A pasted-text attachment's line count, for its "Pasted · N lines" chip. */
export function draftAttachmentPastedLines(path: string): number | null {
  const source = sources.get(path);
  return source?.kind === "bytes" ? source.pastedLines ?? null : null;
}
