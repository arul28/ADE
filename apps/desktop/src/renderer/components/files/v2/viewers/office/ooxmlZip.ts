// Bounded ZIP access for OOXML packages (`.xlsx` / `.pptx`), on top of fflate.
//
// Three rules shape this module, and every one of them exists because an office
// file is untrusted bytes that arrived from somewhere else (an agent, a
// download, a commit):
//
//   1. **Nothing loads until a file opens.** fflate is imported dynamically and
//      only from here, so the parser cost is never on the Files route's startup
//      path — the main bundle grows by this file's own bytes and nothing else.
//   2. **Reads are entry-scoped.** `unzip` keeps the whole archive's metadata
//      only (the central directory), and each `readText` / `readBytes` inflates
//      exactly one entry through fflate's filter. A 40 MB deck never becomes
//      40 MB of JavaScript heap just because one slide is on screen.
//   3. **Every read is capped.** A read is checked against the declared
//      uncompressed size as a fast reject, then against the bytes as they
//      actually arrive — which is the guarantee, since a deflate stream can
//      expand far past whatever its header claims. One budget spans the whole
//      package, so 300 slide parts cannot add up to gigabytes.
//
// The final line matters: a preview reads many parts, and a per-entry cap alone
// would still let a crafted deck allocate without bound.

import type * as Fflate from "fflate";
import { OoxmlError } from "./ooxmlError";

/** Largest single entry this module will inflate (uncompressed). */
const ZIP_MAX_ENTRY_BYTES = 24 * 1024 * 1024;

/**
 * Largest total this module will inflate for ONE package.
 *
 * The per-entry cap alone does not bound a preview: a deck reads every slide
 * part, and 300 parts at the entry cap would be gigabytes of retained text. One
 * budget across all reads is what actually makes a crafted archive safe — each
 * read debits the same counter, and the read that would cross it fails.
 */
const ZIP_MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Largest single entry for embedded media (images on a slide). The deck's own
 * numbers stay honest with a smaller media ceiling: a preview never needs a
 * 20 MB bitmap.
 */
export const ZIP_MAX_MEDIA_BYTES = 12 * 1024 * 1024;

/** One package's inflate allowance: bytes left, and the entries already charged. */
type InflateBudget = { remaining: number; charged: Set<string> };

export type OoxmlEntryInfo = {
  name: string;
  /** Compressed size, as the central directory declares it. */
  size: number;
  /** Uncompressed size, as the central directory declares it. */
  originalSize: number;
  compression: number;
};

export type OoxmlZip = {
  /** Every entry in the archive, keyed by its full package path. */
  readonly entries: ReadonlyMap<string, OoxmlEntryInfo>;
  /** Text (UTF-8) of one entry, or null when it does not exist. */
  readText(name: string, maxBytes?: number): Promise<string | null>;
  /** Raw bytes of one entry, or null when it does not exist. */
  readBytes(name: string, maxBytes?: number): Promise<Uint8Array<ArrayBuffer> | null>;
};

const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_EMPTY_MAGIC = 0x06054b50;
const ZIP_SPANNED_MAGIC = 0x08074b50;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** A real ZIP archive starts with a local, empty, or spanned-data signature. */
function looksLikeZipArchive(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  return magic === ZIP_LOCAL_MAGIC || magic === ZIP_EMPTY_MAGIC || magic === ZIP_SPANNED_MAGIC;
}

/**
 * An OLE2 compound file: how legacy formats (`.xls`, `.ppt`) start, and also
 * how an *encrypted* OOXML package starts (Office wraps it in a compound file
 * with an encryption stream). Either way the ZIP parser below cannot help, and
 * saying so specifically beats a generic "corrupt file" message.
 */
function looksLikeOleCompoundFile(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length) return false;
  return OLE_MAGIC.every((byte, index) => bytes[index] === byte);
}

let fflateModule: Promise<FflateModule> | null = null;

/** fflate loads on the first office preview, never on route startup. */
function loadFflate(): Promise<FflateModule> {
  if (!fflateModule) fflateModule = import("fflate");
  return fflateModule;
}

type FflateModule = typeof Fflate;

/**
 * List every entry in the archive without decompressing any of them.
 *
 * `Unzip` streams the central directory and hands each entry to the callback
 * before its data is touched; by never calling `file.start()` nothing is
 * inflated. That makes the listing cheap enough to run for every open, which in
 * turn lets every later read be filter-narrowed to the one entry it needs.
 */
async function listEntries(bytes: Uint8Array): Promise<Map<string, OoxmlEntryInfo>> {
  const { Unzip } = await loadFflate();
  const entries = new Map<string, OoxmlEntryInfo>();
  const unzip = new Unzip((file) => {
    entries.set(file.name, {
      name: file.name,
      size: file.size ?? 0,
      originalSize: file.originalSize ?? 0,
      compression: file.compression,
    });
  });
  try {
    unzip.push(bytes, true);
  } catch (err) {
    throw new OoxmlError("corrupt", "The file could not be read as a zip package.", err);
  }
  if (entries.size === 0) {
    throw new OoxmlError("corrupt", "The file contains no zip entries.");
  }
  return entries;
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Inflate ONE entry, streaming, with a hard byte cap on this read and a shared
 * budget across the package.
 *
 * The cap is enforced on the bytes as they arrive rather than on the size the
 * archive declares: a deflate stream can expand a thousandfold, so a crafted
 * 100 KB entry could otherwise allocate gigabytes in this process before
 * anyone could look at a header. The declared size is still checked first as a
 * cheap rejection. Counting `ondata` chunks is the only place the real size is
 * known before it is too late.
 *
 * Decoding runs in a worker (`AsyncUnzipInflate`) so a large sheet never
 * blocks a frame; a worker-less environment (jsdom tests, a stripped runtime)
 * falls back to the synchronous decoder, where the same cap still holds.
 */
async function readEntryStreaming(
  fflate: FflateModule,
  bytes: Uint8Array,
  name: string,
  maxBytes: number,
  budget: InflateBudget,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let found = false;
  // Decided once per READ, and then every chunk of that read is charged. The
  // decision cannot be made per chunk: the entry is in the set after its first
  // chunk, so a per-chunk check would debit only that first chunk and the
  // budget would stop bounding the package at all.
  const charging = !budget.charged.has(name);
  if (charging) budget.charged.add(name);

  return new Promise<Uint8Array<ArrayBuffer> | null>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const tooLarge = () => new OoxmlError(
      "too-large",
      `“${name}” expands past the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`,
    );
    const budgetExhausted = () => new OoxmlError(
      "too-large",
      `This file expands past what a preview will read (over ${Math.round(ZIP_MAX_TOTAL_INFLATED_BYTES / (1024 * 1024))} MB of document parts).`,
    );

    const unzip = new fflate.Unzip((file) => {
      if (file.name !== name) return; // Not started: the entry is never inflated.
      found = true;
      if (file.originalSize != null && file.originalSize > maxBytes) {
        file.terminate();
        fail(tooLarge());
        return;
      }
      file.ondata = (err, chunk, final) => {
        if (settled) return;
        if (err) {
          file.terminate();
          fail(new OoxmlError("corrupt", `“${name}” could not be decompressed.`, err));
          return;
        }
        total += chunk.length;
        // A distinct entry spends the package budget once; a re-read of an
        // entry already charged is free, because the deck re-reads a slide's
        // media on every visit and the workbook re-reads its shared string
        // table per sheet. The bound that matters is DISTINCT parts.
        if (charging) budget.remaining -= chunk.length;
        if (total > maxBytes) {
          file.terminate();
          fail(tooLarge());
          return;
        }
        if (budget.remaining < 0) {
          file.terminate();
          fail(budgetExhausted());
          return;
        }
        chunks.push(chunk);
        if (final) {
          settled = true;
          resolve(concatChunks(chunks, total));
        }
      };
      file.start();
    });
    try {
      unzip.register(fflate.UnzipPassThrough);
      unzip.register(typeof Worker === "function" ? fflate.AsyncUnzipInflate : fflate.UnzipInflate);
      unzip.push(bytes, true);
    } catch (err) {
      fail(new OoxmlError("corrupt", `“${name}” could not be decompressed.`, err));
      return;
    }
    // The stream walks every header synchronously while nothing is decoding,
    // so an entry that never appeared is a genuine miss.
    if (!settled && !found) {
      settled = true;
      resolve(null);
    }
  });
}

/**
 * Open an OOXML package from its bytes. Fails with a typed `OoxmlError` the
 * callers turn into user-facing copy — never a raw stack.
 */
export async function openOoxmlZip(bytes: Uint8Array): Promise<OoxmlZip> {
  if (looksLikeOleCompoundFile(bytes)) {
    throw new OoxmlError(
      "encrypted-or-legacy",
      "This is a legacy binary or password-protected Office file, which cannot be previewed.",
    );
  }
  if (!looksLikeZipArchive(bytes)) {
    throw new OoxmlError("not-zip", "This file is not an Office (zip) package.");
  }

  const entries = await listEntries(bytes);
  const fflate = await loadFflate();
  // One budget for the whole package, charged per distinct entry.
  const budget: InflateBudget = { remaining: ZIP_MAX_TOTAL_INFLATED_BYTES, charged: new Set<string>() };

  async function readBytes(name: string, maxBytes: number = ZIP_MAX_ENTRY_BYTES): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!entries.has(name)) return null;
    return readEntryStreaming(fflate, bytes, name, maxBytes, budget);
  }

  return {
    entries,
    readBytes,
    async readText(name: string, maxBytes: number = ZIP_MAX_ENTRY_BYTES): Promise<string | null> {
      const data = await readBytes(name, maxBytes);
      return data ? decodeUtf8(data) : null;
    },
  };
}
