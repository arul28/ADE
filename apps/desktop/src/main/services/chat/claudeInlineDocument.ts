import { inflateSync } from "node:zlib";
import type { ClaudeRetainedMedia } from "../../../shared/types/chat";

export type { ClaudeRetainedMedia };

/**
 * PDFs Claude reads as `document` blocks, and the budget that keeps them safe.
 *
 * Claude Code keeps every user message for the life of its session and resends
 * the whole history on each request. A document the API rejects is therefore
 * not one failed turn: it stays in the history and fails every turn after it.
 * So a PDF is inlined only when it is known to fit what the session already
 * carries, and anything uncertain goes as a path hint, which Claude can still
 * read with its own tools.
 *
 * Anthropic's limits are 32 MB per request and 100 PDF pages per request
 * (models with a 1M window allow more, but the SDK does not say which window a
 * session has). The budget counts what ADE inlined into this Claude session:
 * PDF pages, and base64 bytes of PDFs and images. Text is not counted; the
 * byte budget leaves room below 32 MB for it, the system prompt and the tools.
 */

/** Base64 bytes of inlined PDFs and images one Claude session may carry. */
export const CLAUDE_RETAINED_MEDIA_MAX_BYTES = 24 * 1024 * 1024;
/** PDF pages one Claude session may carry. */
export const CLAUDE_RETAINED_PDF_MAX_PAGES = 100;
/** Largest single PDF read for inlining, before base64. */
export const CLAUDE_INLINE_PDF_MAX_FILE_BYTES = 18 * 1024 * 1024;

/** Framing a content block adds next to its base64 payload. */
const BLOCK_OVERHEAD_BYTES = 128;
/** Ceiling on bytes inflated from object streams while counting pages. */
const MAX_INFLATED_OBJECT_STREAM_BYTES = 64 * 1024 * 1024;
/** How far back a key may sit from the `<<` of its dictionary. */
const MAX_DICT_LOOKBACK_CHARS = 256 * 1024;

export function emptyClaudeRetainedMedia(): ClaudeRetainedMedia {
  return { pages: 0, bytes: 0 };
}

/** A persisted budget read back, or null when it is missing or malformed. */
export function parseClaudeRetainedMedia(value: unknown): ClaudeRetainedMedia | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pages = record.pages;
  const bytes = record.bytes;
  if (typeof pages !== "number" || typeof bytes !== "number") return null;
  if (!Number.isFinite(pages) || !Number.isFinite(bytes) || pages < 0 || bytes < 0) return null;
  if (pages === 0 && bytes === 0) return null;
  return { pages: Math.ceil(pages), bytes: Math.ceil(bytes) };
}

/** Base64 bytes a block of `rawBytes` adds to the session, framing included. */
export function retainedBytesForInline(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3) + BLOCK_OVERHEAD_BYTES;
}

/** Largest raw PDF that still fits `budget`, never above the single-file cap. */
export function remainingInlinePdfFileBytes(budget: ClaudeRetainedMedia): number {
  const remainingBase64 = CLAUDE_RETAINED_MEDIA_MAX_BYTES - budget.bytes - BLOCK_OVERHEAD_BYTES;
  if (remainingBase64 <= 0) return 0;
  return Math.min(CLAUDE_INLINE_PDF_MAX_FILE_BYTES, Math.floor((remainingBase64 * 3) / 4));
}

export function isPdfBytes(bytes: Buffer): boolean {
  // The spec allows junk before the header within the first 1024 bytes.
  const head = bytes.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}

/** Offset of the `>>` closing the dictionary that starts at `open`, or -1. */
function matchingDictEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length - 1; i += 1) {
    const char = text[i];
    if (char === "(") {
      // Skip a literal string; dictionaries inside strings are not structure.
      let nesting = 1;
      for (i += 1; i < text.length && nesting > 0; i += 1) {
        if (text[i] === "\\") i += 1;
        else if (text[i] === "(") nesting += 1;
        else if (text[i] === ")") nesting -= 1;
      }
      i -= 1;
      continue;
    }
    if (char === "<" && text[i + 1] === "<") {
      depth += 1;
      i += 1;
    } else if (char === ">" && text[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Offset of the `<<` opening the innermost dictionary around `index`, or -1. */
function enclosingDictStart(text: string, index: number): number {
  let depth = 0;
  const floor = Math.max(0, index - MAX_DICT_LOOKBACK_CHARS);
  for (let i = index; i > floor; i -= 1) {
    if (text[i] === ">" && text[i - 1] === ">") {
      depth += 1;
      i -= 1;
    } else if (text[i] === "<" && text[i - 1] === "<") {
      if (depth === 0) return i - 1;
      depth -= 1;
      i -= 1;
    }
  }
  return -1;
}

type PageScan = { pageObjects: number; treeCount: number; indirectCounts: string[] };

const PAGE_TYPE_RE = /\/Type\s*\/Page(?![A-Za-z0-9#])/g;
const PAGES_TYPE_RE = /\/Type\s*\/Pages(?![A-Za-z0-9#])/g;
// A direct count. `/Count 3 0 R` is an indirect reference, read separately.
const DIRECT_COUNT_RE = /\/Count\s+(\d{1,9})(?!\s*\d+\s+R)(?=[\s/>\]%]|$)/;
const INDIRECT_COUNT_RE = /\/Count\s+(\d{1,9})\s+(\d{1,5})\s+R(?![A-Za-z0-9#])/;
// A plain integer object, `5 0 obj 60 endobj`: what an indirect /Count points at.
const INTEGER_OBJECT_RE = /(?:^|[^0-9])(\d{1,9})\s+(\d{1,5})\s+obj\s+(\d{1,9})\s+endobj/g;

function scanPages(text: string): PageScan {
  let pageObjects = 0;
  for (const _match of text.matchAll(PAGE_TYPE_RE)) pageObjects += 1;
  let treeCount = 0;
  const indirectCounts: string[] = [];
  for (const match of text.matchAll(PAGES_TYPE_RE)) {
    const start = enclosingDictStart(text, match.index);
    if (start < 0) continue;
    const end = matchingDictEnd(text, start);
    if (end < 0) continue;
    // Only this dictionary's own keys: drop nested dictionaries first, so an
    // outline's or a kid's /Count is never read as the tree's.
    let own = text.slice(start + 2, end - 2);
    for (let nested = own.indexOf("<<"); nested >= 0; nested = own.indexOf("<<")) {
      const close = matchingDictEnd(own, nested);
      if (close < 0) break;
      own = own.slice(0, nested) + own.slice(close);
    }
    const count = DIRECT_COUNT_RE.exec(own);
    if (count) treeCount = Math.max(treeCount, Number(count[1]));
    const indirect = INDIRECT_COUNT_RE.exec(own);
    if (indirect) indirectCounts.push(`${indirect[1]} ${indirect[2]}`);
  }
  return { pageObjects, treeCount, indirectCounts };
}

/**
 * The decoded contents of every Flate object stream (`/Type /ObjStm`), where
 * modern PDFs keep their page objects. Null when one cannot be decoded, so the
 * caller treats the count as unknown instead of under-counting.
 */
function objectStreamTexts(text: string, bytes: Buffer): string[] | null {
  const out: string[] = [];
  let inflatedTotal = 0;
  const objStmRe = /\/Type\s*\/ObjStm(?![A-Za-z0-9#])/g;
  for (const match of text.matchAll(objStmRe)) {
    const dictStart = enclosingDictStart(text, match.index);
    if (dictStart < 0) return null;
    const dictEnd = matchingDictEnd(text, dictStart);
    if (dictEnd < 0) return null;
    const dict = text.slice(dictStart, dictEnd);
    const streamKeyword = text.indexOf("stream", dictEnd);
    if (streamKeyword < 0 || streamKeyword - dictEnd > 64) return null;
    let dataStart = streamKeyword + "stream".length;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;
    const endKeyword = text.indexOf("endstream", dataStart);
    if (endKeyword < 0) return null;
    const filter = /\/Filter\s*(\[\s*)?\/([A-Za-z0-9]+)/.exec(dict);
    // Several filters, or anything but Flate, is not decoded here.
    if (filter && (filter[2] !== "FlateDecode" || /\/Filter\s*\[[^\]]*\/[A-Za-z0-9]+\s*\/[A-Za-z]/.test(dict))) {
      return null;
    }
    if (/\/DecodeParms/.test(dict) && /\/Predictor\s*([2-9]|1\d)/.test(dict)) return null;
    const raw = bytes.subarray(dataStart, endKeyword);
    let decoded: Buffer;
    try {
      decoded = filter
        ? inflateSync(raw, { maxOutputLength: MAX_INFLATED_OBJECT_STREAM_BYTES - inflatedTotal })
        : raw;
    } catch {
      return null;
    }
    inflatedTotal += decoded.length;
    if (inflatedTotal >= MAX_INFLATED_OBJECT_STREAM_BYTES) return null;
    out.push(decoded.toString("latin1"));
  }
  return out;
}

/**
 * The number of pages in a PDF, or null when it cannot be told with
 * confidence: not a PDF, encrypted, or a page tree ADE cannot read. Errs high,
 * never low: stale copies an incremental update leaves in the file are
 * counted too, which at worst sends the PDF as a path hint.
 */
export function countPdfPages(bytes: Buffer): number | null {
  if (!isPdfBytes(bytes)) return null;
  const text = bytes.toString("latin1");
  // Encrypted documents keep their object streams encrypted, and Claude
  // cannot read a password-protected PDF anyway.
  if (/\/Encrypt(?![A-Za-z0-9#])/.test(text)) return null;
  const streams = objectStreamTexts(text, bytes);
  if (!streams) return null;
  let pageObjects = 0;
  let treeCount = 0;
  const indirectCounts = new Set<string>();
  for (const source of [text, ...streams]) {
    const scan = scanPages(source);
    pageObjects += scan.pageObjects;
    treeCount = Math.max(treeCount, scan.treeCount);
    for (const ref of scan.indirectCounts) indirectCounts.add(ref);
  }
  // Resolve `/Count 5 0 R` in one pass over the file. Every definition of the
  // object counts, the highest wins: an incremental update leaves the old one
  // earlier in the file. One kept in an object stream is not resolved; the
  // page objects still count.
  if (indirectCounts.size) {
    for (const match of text.matchAll(INTEGER_OBJECT_RE)) {
      if (indirectCounts.has(`${match[1]} ${match[2]}`)) treeCount = Math.max(treeCount, Number(match[3]));
    }
  }
  // The larger of the two. A tree count can be low when an indirect root
  // /Count cannot be resolved and only a subtree's is read; page objects can
  // be high when an incremental update leaves old copies behind. High is safe.
  const pages = Math.max(treeCount, pageObjects);
  return pages > 0 ? pages : null;
}
