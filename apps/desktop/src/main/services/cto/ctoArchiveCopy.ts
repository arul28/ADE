/**
 * The CTO's archive in its account copy, so it moves with the CTO to a new
 * home machine (`ctoAccountCopyService.ts`). The archive itself stays a local
 * SQLite file (`ctoMemoryArchive.ts`); this is how its rows travel.
 *
 * The rows ride in the account vault next to the copy, under the same kind
 * (`cto_copy`, scope `repo:<origin>`), so the relay needs nothing new:
 *
 * - `archive`: the index. Which chunks make up the archive now, who wrote it,
 *   and the heat of the notes in the notes files (which notes are coldest).
 * - `archive:<hash>`: a chunk of rows, `gz1:` + base64 gzip of JSON, named by
 *   its content. A reader that has the index and a chunk's key has exactly
 *   the rows the writer meant, whatever order the writes reached the account.
 *
 * Chunks are packed oldest row first, so a new row changes only the last
 * chunk and the others are not written again. Each shelf (story versions,
 * everything else) has a ceiling; past it, the oldest rows of that shelf stop
 * travelling (they stay in the old home's archive) and the cut is kept in the
 * archive's meta so the chunks stay stable until the next cut. Story versions
 * are large and frequent, so they have their own shelf and never push facts
 * or notes out.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { CTO_ARCHIVE_KINDS, type CtoArchiveKind, type CtoNotesScope } from "../../../shared/types/cto";
import type { CtoArchiveCarriedRow, CtoArchiveRecord, CtoNoteHeatRow } from "./ctoMemoryArchive";

export const CTO_ARCHIVE_COPY_INDEX_KEY = "archive";
export const CTO_ARCHIVE_COPY_CHUNK_PREFIX = "archive:";
/** Archive meta key of the travel cut per shelf (`{"entries": id, "story": id}`). */
export const CTO_ARCHIVE_COPY_FLOOR_META = "copyFloor";

const ENCODED_PREFIX = "gz1:";
/** The relay allows 48,000 chars for the kind; leave room like the copy does. */
const CHUNK_MAX_ENCODED_CHARS = 46_000;
/** Raw JSON per chunk before gzip. Text compresses about 3x; an overfull chunk splits. */
const CHUNK_TARGET_RAW_CHARS = 80_000;
/** A decoded chunk past this is not one a home machine wrote. */
const CHUNK_MAX_DECODED_CHARS = 2_000_000;

export type CtoArchiveShelf = "entries" | "story";

/**
 * Chunks per shelf. Past `max`, the oldest rows stop travelling until what is
 * left fits in `trimTo`, so the next cut is many rows away.
 */
const SHELF_LIMITS: Record<CtoArchiveShelf, { max: number; trimTo: number }> = {
  entries: { max: 6, trimTo: 4 },
  story: { max: 3, trimTo: 2 },
};

export type CtoArchiveCopyFloors = Record<CtoArchiveShelf, number>;

/** One row as it travels: short keys, no local ids. */
type CarriedRow = {
  k: CtoArchiveKind;
  s?: CtoNotesScope;
  t: string;
  r?: string;
  at?: string;
  l?: string;
  a: string;
};

export type CtoArchiveCopyIndex = {
  v: 1;
  /** The sync device id of the machine that wrote it: the CTO's home then. */
  ownerDeviceId: string;
  savedAt: string;
  /** Chunk keys, oldest rows first. */
  chunks: string[];
  rows: number;
  heat: CtoNoteHeatRow[];
};

export type CtoArchiveCopyChunk = { key: string; value: string; rows: number };

export type CtoArchiveCopyPack = {
  chunks: CtoArchiveCopyChunk[];
  floors: CtoArchiveCopyFloors;
  /** Rows left out because their shelf was over its ceiling. */
  leftOut: number;
};

const shelfOf = (kind: CtoArchiveKind): CtoArchiveShelf => (kind === "story" ? "story" : "entries");

function toCarried(row: CtoArchiveCarriedRow): CarriedRow {
  return {
    k: row.kind,
    ...(row.scope ? { s: row.scope } : {}),
    t: row.text,
    ...(row.reason ? { r: row.reason } : {}),
    ...(row.sourceAt ? { at: row.sourceAt } : {}),
    ...(row.sourceLabel ? { l: row.sourceLabel } : {}),
    a: row.archivedAt,
  };
}

function encode(rows: readonly CarriedRow[]): string {
  return `${ENCODED_PREFIX}${gzipSync(Buffer.from(JSON.stringify(rows), "utf8")).toString("base64")}`;
}

function chunkKey(value: string): string {
  return `${CTO_ARCHIVE_COPY_CHUNK_PREFIX}${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

/** Oldest first into chunks of about `CHUNK_TARGET_RAW_CHARS` each. */
function group(rows: readonly CarriedRow[]): CarriedRow[][] {
  const groups: CarriedRow[][] = [];
  let current: CarriedRow[] = [];
  let size = 0;
  for (const row of rows) {
    const length = JSON.stringify(row).length + 1;
    if (current.length && size + length > CHUNK_TARGET_RAW_CHARS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += length;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** A group that gzips past the relay's ceiling splits in half until each part fits. */
function encodeGroup(rows: CarriedRow[]): CtoArchiveCopyChunk[] {
  const value = encode(rows);
  if (value.length <= CHUNK_MAX_ENCODED_CHARS || rows.length < 2) {
    // One row never passes the ceiling: the archive clips an entry at 16,000 chars.
    return value.length <= CHUNK_MAX_ENCODED_CHARS ? [{ key: chunkKey(value), value, rows: rows.length }] : [];
  }
  const half = Math.ceil(rows.length / 2);
  return [...encodeGroup(rows.slice(0, half)), ...encodeGroup(rows.slice(half))];
}

/** The id from which the newest rows fill about `chunks` chunks. */
function floorFor(rows: readonly CtoArchiveCarriedRow[], chunks: number): number {
  const budget = chunks * CHUNK_TARGET_RAW_CHARS * 0.9;
  let size = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    size += JSON.stringify(toCarried(rows[index]!)).length + 1;
    if (size > budget) return rows[index + 1]?.id ?? rows[index]!.id + 1;
  }
  return 0;
}

/**
 * The chunks for the archive's rows (oldest first, as `exportRows` returns
 * them), from each shelf's floor. A shelf over its ceiling gets a new floor.
 */
export function packCtoArchiveCopy(
  rows: readonly CtoArchiveCarriedRow[],
  floors: CtoArchiveCopyFloors,
): CtoArchiveCopyPack {
  const chunks: CtoArchiveCopyChunk[] = [];
  const nextFloors: CtoArchiveCopyFloors = { ...floors };
  let leftOut = 0;
  for (const shelf of ["entries", "story"] as const) {
    const all = rows.filter((row) => shelfOf(row.kind) === shelf);
    let floor = nextFloors[shelf];
    let kept = all.filter((row) => row.id >= floor);
    let packed = group(kept.map(toCarried)).flatMap(encodeGroup);
    if (packed.length > SHELF_LIMITS[shelf].max) {
      floor = floorFor(kept, SHELF_LIMITS[shelf].trimTo);
      kept = all.filter((row) => row.id >= floor);
      packed = group(kept.map(toCarried)).flatMap(encodeGroup);
    }
    nextFloors[shelf] = floor;
    leftOut += all.length - kept.length;
    chunks.push(...packed);
  }
  return { chunks, floors: nextFloors, leftOut };
}

export function readCtoArchiveCopyFloors(value: string | null): CtoArchiveCopyFloors {
  try {
    const parsed = value ? JSON.parse(value) as Partial<CtoArchiveCopyFloors> : {};
    const floor = (input: unknown): number => (typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.floor(input) : 0);
    return { entries: floor(parsed.entries), story: floor(parsed.story) };
  } catch {
    return { entries: 0, story: 0 };
  }
}

export function encodeCtoArchiveCopyIndex(index: CtoArchiveCopyIndex): string {
  return JSON.stringify(index);
}

const isScope = (value: unknown): value is CtoNotesScope => value === "project" || value === "user";
const isKind = (value: unknown): value is CtoArchiveKind =>
  typeof value === "string" && (CTO_ARCHIVE_KINDS as readonly string[]).includes(value);
const optionalText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** The index, or null when it is not one this build can read (never treated as "no archive"). */
export function decodeCtoArchiveCopyIndex(value: string | null | undefined): CtoArchiveCopyIndex | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CtoArchiveCopyIndex>;
    if (parsed?.v !== 1 || typeof parsed.ownerDeviceId !== "string" || !parsed.ownerDeviceId.trim()) return null;
    if (!Array.isArray(parsed.chunks) || !parsed.chunks.every((key) => typeof key === "string" && key.startsWith(CTO_ARCHIVE_COPY_CHUNK_PREFIX))) return null;
    const heat = Array.isArray(parsed.heat)
      ? parsed.heat.filter((row): row is CtoNoteHeatRow =>
        Boolean(row) && isScope(row.scope) && typeof row.key === "string" && typeof row.at === "string")
      : [];
    return {
      v: 1,
      ownerDeviceId: parsed.ownerDeviceId,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
      chunks: parsed.chunks,
      rows: typeof parsed.rows === "number" ? parsed.rows : 0,
      heat,
    };
  } catch {
    return null;
  }
}

/** A chunk's rows as archive records, or null when it doesn't decode. */
export function decodeCtoArchiveCopyChunk(value: string | null | undefined): CtoArchiveRecord[] | null {
  if (!value || !value.startsWith(ENCODED_PREFIX)) return null;
  try {
    const text = gunzipSync(Buffer.from(value.slice(ENCODED_PREFIX.length), "base64"), { maxOutputLength: CHUNK_MAX_DECODED_CHARS }).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((row: Partial<CarriedRow>): CtoArchiveRecord[] => {
      if (!row || !isKind(row.k) || typeof row.t !== "string" || !row.t.trim()) return [];
      return [{
        kind: row.k,
        text: row.t,
        scope: isScope(row.s) ? row.s : null,
        reason: optionalText(row.r),
        sourceAt: optionalText(row.at),
        sourceLabel: optionalText(row.l),
        archivedAt: optionalText(row.a),
      }];
    });
  } catch {
    return null;
  }
}
