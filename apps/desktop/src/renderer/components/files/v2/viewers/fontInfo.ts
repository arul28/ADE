/** Font container formats ADE can inspect without an external font service. */
export type FontFormat = "TrueType" | "OpenType" | "WOFF" | "WOFF2" | "TrueType collection" | "Unknown";

/** One variable font axis and its supported value range. */
export type FontAxis = {
  tag: string;
  min: number;
  default: number;
  max: number;
};

/** Human-readable strings from the OpenType name table. */
export type FontNameInfo = {
  family: string | null;
  subfamily: string | null;
  fullName: string | null;
  version: string | null;
  designer: string | null;
  manufacturer: string | null;
  copyright: string | null;
  license: string | null;
  licenseUrl: string | null;
};

/** Bounded metadata extracted from a font; codepoint coverage is capped at 512 entries. */
export type FontInfo = {
  format: FontFormat;
  collectionCount: number | null;
  names: FontNameInfo;
  weight: number | null;
  width: number | null;
  italic: boolean | null;
  unitsPerEm: number | null;
  glyphCount: number | null;
  codepoints: number[];
  axes: FontAxis[];
  features: string[];
  containerOnly: boolean;
  containerTableCount: number | null;
  containerSize: number | null;
};

const MAX_TABLES = 256;
const MAX_FEATURES = 128;
/** Keep both parser work and the rendered glyph grid bounded. */
export const FONT_CODEPOINT_CAP = 512;

const EMPTY_NAMES: FontNameInfo = {
  family: null,
  subfamily: null,
  fullName: null,
  version: null,
  designer: null,
  manufacturer: null,
  copyright: null,
  license: null,
  licenseUrl: null,
};
const EMPTY_INFO: FontInfo = {
  format: "Unknown",
  collectionCount: null,
  names: EMPTY_NAMES,
  weight: null,
  width: null,
  italic: null,
  unitsPerEm: null,
  glyphCount: null,
  codepoints: [],
  axes: [],
  features: [],
  containerOnly: false,
  containerTableCount: null,
  containerSize: null,
};

class Reader {
  constructor(readonly bytes: Uint8Array) {}

  get length() { return this.bytes.length; }

  /** Check every offset before a table read so malformed font records stay local. */
  ok(offset: number, size: number): boolean {
    return Number.isSafeInteger(offset)
      && Number.isSafeInteger(size)
      && offset >= 0
      && size >= 0
      && offset <= this.length
      && size <= this.length - offset;
  }

  u16(offset: number): number {
    return this.ok(offset, 2)
      ? (this.bytes[offset]! << 8) | this.bytes[offset + 1]!
      : 0;
  }

  i16(offset: number): number {
    const value = this.u16(offset);
    return value & 0x8000 ? value - 0x10000 : value;
  }

  u32(offset: number): number {
    if (!this.ok(offset, 4)) return 0;
    return this.bytes[offset]! * 0x1000000
      + (this.bytes[offset + 1]! << 16)
      + (this.bytes[offset + 2]! << 8)
      + this.bytes[offset + 3]!;
  }

  tag(offset: number): string {
    return this.ok(offset, 4)
      ? String.fromCharCode(...this.bytes.subarray(offset, offset + 4))
      : "";
  }
}

type Table = {
  offset: number;
  length: number;
  bytes?: Uint8Array;
};
function readSfnt(reader: Reader, base: number): Map<string, Table> {
  const count = Math.min(reader.u16(base + 4), MAX_TABLES);
  if (!reader.ok(base, 12 + count * 16)) return new Map();
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const row = base + 12 + i * 16;
    const tag = reader.tag(row);
    const offset = reader.u32(row + 8);
    const length = reader.u32(row + 12);
    if (reader.ok(offset, length)) tables.set(tag, { offset, length });
  }
  return tables;
}
function tableReader(all: Reader, table: Table | undefined): Reader | null {
  if (!table || !all.ok(table.offset, table.length)) return null;
  return new Reader(all.bytes.subarray(table.offset, table.offset + table.length));
}
function decodeName(bytes: Uint8Array, platform: number): string {
  try {
    if (platform === 0 || platform === 3) {
      return new TextDecoder("utf-16be").decode(bytes).replace(/\0/g, "").trim();
    }
    // macintosh is available in Chromium and preserves classic name-table strings.
    return new TextDecoder("macintosh").decode(bytes).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}
function parseNames(reader: Reader): FontNameInfo {
  const out = { ...EMPTY_NAMES };
  if (reader.length < 6) return out;
  const format = reader.u16(0);
  const count = Math.min(reader.u16(2), 4096);
  const strings = reader.u16(4);
  if (format > 1 || !reader.ok(6, count * 12)) return out;
  const candidates = new Map<number, Array<{ text: string; score: number }>>();
  const idMap: Record<number, keyof FontNameInfo> = {
    0: "copyright",
    1: "family",
    2: "subfamily",
    4: "fullName",
    5: "version",
    8: "manufacturer",
    9: "designer",
    13: "license",
    14: "licenseUrl",
  };
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const platform = reader.u16(p);
    const encoding = reader.u16(p + 2);
    const language = reader.u16(p + 4);
    const nameId = reader.u16(p + 6);
    const len = reader.u16(p + 8);
    const off = reader.u16(p + 10);
    const start = strings + off;
    if (!idMap[nameId] || !reader.ok(start, len) || len > 8192) continue;
    const text = decodeName(reader.bytes.subarray(start, start + len), platform);
    if (!text) continue;
    // Prefer Unicode English, then Mac Roman English, then other Unicode records.
    const score = platform === 3 && language === 0x0409 ? 100
      : platform === 1 && language === 0 ? 80
        : platform === 0 ? 60
          : platform === 3 ? 40
            : platform === 1 ? 20 : encoding === 10 ? 1 : 0;
    const list = candidates.get(nameId) ?? [];
    list.push({ text, score });
    candidates.set(nameId, list);
  }
  for (const [id, key] of Object.entries(idMap)) {
    out[key] = candidates.get(Number(id))
      ?.sort((left, right) => right.score - left.score)[0]?.text ?? null;
  }
  return out;
}
function parseCmap(reader: Reader): number[] {
  if (reader.length < 4) return [];
  const count = Math.min(reader.u16(2), 128);
  const result = new Set<number>();
  let best4: number | null = null;
  let best12: number | null = null;
  let best12Priority = -1;
  for (let i = 0; i < count; i++) {
    const p = 4 + i * 8;
    const platform = reader.u16(p);
    const encoding = reader.u16(p + 2);
    const off = reader.u32(p + 4);
    if (!reader.ok(off, 2)) continue;
    const fmt = reader.u16(off);
    const priority = (platform === 3 && encoding === 10 ? 4 : 0)
      + (platform === 0 ? 3 : 0)
      + (platform === 3 ? 2 : 0);
    if (fmt === 12 && priority > best12Priority) {
      best12 = off;
      best12Priority = priority;
    }
    if (fmt === 4 && best4 === null) best4 = off;
  }
  const add = (codepoint: number) => {
    if (
      codepoint > 0
      && codepoint <= 0x10ffff
      && !(codepoint >= 0xd800 && codepoint <= 0xdfff)
    ) result.add(codepoint);
  };
  // format 12 is compact to enumerate; cap ranges before walking them.
  if (best12 != null && reader.ok(best12, 16)) {
    const tableLength = reader.u32(best12 + 4);
    const groupCount = reader.u32(best12 + 12);
    const n = Math.min(groupCount, 4096, Math.floor((tableLength - 16) / 12));
    if (tableLength >= 16 && reader.ok(best12, tableLength) && reader.ok(best12 + 16, n * 12)) {
      for (let i = 0; i < n && result.size < FONT_CODEPOINT_CAP; i++) {
        const p = best12 + 16 + i * 12;
        const start = reader.u32(p);
        const end = Math.min(reader.u32(p + 4), start + FONT_CODEPOINT_CAP);
        const firstGlyph = reader.u32(p + 8);
        for (let codepoint = start; codepoint <= end && result.size < FONT_CODEPOINT_CAP; codepoint++) {
          if (firstGlyph + codepoint - start !== 0) add(codepoint);
        }
      }
    }
  }
  if (best4 != null && result.size < FONT_CODEPOINT_CAP && reader.ok(best4, 14)) {
    const len = reader.u16(best4 + 2);
    const segCount = Math.min(Math.floor(reader.u16(best4 + 6) / 2), 2048);
    const endBase = best4 + 14;
    const startBase = endBase + segCount * 2 + 2;
    if (len >= 16 + segCount * 8 && reader.ok(best4, len) && reader.ok(startBase, segCount * 2)) {
      const deltaBase = startBase + segCount * 2;
      const rangeBase = deltaBase + segCount * 2;
      for (let i = 0; i < segCount && result.size < FONT_CODEPOINT_CAP; i++) {
        const end = reader.u16(endBase + i * 2), start = reader.u16(startBase + i * 2);
        if (end < start || end > 0xfffe) continue;
        const delta = reader.i16(deltaBase + i * 2);
        const rangeOffset = reader.u16(rangeBase + i * 2);
        for (let codepoint = start; codepoint <= end && result.size < FONT_CODEPOINT_CAP; codepoint++) {
          const glyphOffset = rangeBase + i * 2 + rangeOffset + (codepoint - start) * 2;
          const glyphOffsetInTable = glyphOffset >= best4 && glyphOffset + 2 <= best4 + len;
          const glyph = rangeOffset === 0
            ? (codepoint + delta) & 0xffff
            : glyphOffsetInTable && reader.ok(glyphOffset, 2) && reader.u16(glyphOffset) !== 0
              ? (reader.u16(glyphOffset) + delta) & 0xffff
              : 0;
          if (glyph !== 0) add(codepoint);
        }
      }
    }
  }
  return [...result].sort((a, b) => a - b).slice(0, FONT_CODEPOINT_CAP);
}
function parseAxes(reader: Reader): FontAxis[] {
  if (reader.length < 16) return [];
  const offset = reader.u16(4);
  const count = Math.min(reader.u16(8), 32);
  const size = reader.u16(10);
  if (size < 20 || !reader.ok(offset, count * size)) return [];
  const axes: FontAxis[] = [];
  for (let i = 0; i < count; i++) {
    const position = offset + i * size;
    const tag = reader.tag(position);
    const min = reader.i16(position + 4) + reader.u16(position + 6) / 65536;
    const defaultValue = reader.i16(position + 8) + reader.u16(position + 10) / 65536;
    const max = reader.i16(position + 12) + reader.u16(position + 14) / 65536;
    const values = [min, defaultValue, max];
    if (
      /^[\x20-\x7e]{4}$/.test(tag)
      && values.every(Number.isFinite)
      && min <= defaultValue
      && defaultValue <= max
    ) {
      axes.push({ tag, min, default: defaultValue, max });
    }
  }
  return axes;
}
function parseFeatures(tables: Map<string, Table>, all: Reader): string[] {
  const tags = new Set<string>();
  for (const name of ["GSUB", "GPOS"]) {
    const r = tableReader(all, tables.get(name));
    if (!r || r.length < 10) continue;
    const list = r.u16(6);
    const count = Math.min(r.u16(list), MAX_FEATURES);
    if (!r.ok(list, 2 + count * 6)) continue;
    for (let i = 0; i < count && tags.size < MAX_FEATURES; i++) {
      const tag = r.tag(list + 2 + i * 6);
      if (/^[\x20-\x7e]{4}$/.test(tag)) tags.add(tag);
    }
  }
  return [...tags].sort();
}
function enrich(reader: Reader, tables: Map<string, Table>, info: FontInfo): FontInfo {
  const names = tableReader(reader, tables.get("name"));
  if (names) info.names = parseNames(names);
  const os2 = tableReader(reader, tables.get("OS/2"));
  if (os2 && os2.length >= 8) {
    info.weight = os2.u16(4);
    info.width = os2.u16(6);
    // OS/2 fsSelection bit 0 identifies italic faces.
    if (os2.length >= 64) info.italic = (os2.u16(62) & 1) !== 0;
  }
  const head = tableReader(reader, tables.get("head"));
  if (head && head.length >= 20) info.unitsPerEm = head.u16(18) || null;
  const maxp = tableReader(reader, tables.get("maxp"));
  if (maxp && maxp.length >= 6) info.glyphCount = maxp.u16(4);
  const cmap = tableReader(reader, tables.get("cmap"));
  if (cmap) info.codepoints = parseCmap(cmap);
  const fvar = tableReader(reader, tables.get("fvar"));
  if (fvar) info.axes = parseAxes(fvar);
  info.features = parseFeatures(tables, reader);
  return info;
}

function parseWoff(bytes: Uint8Array): Map<string, Table> {
  const r = new Reader(bytes);
  const count = Math.min(r.u16(12), MAX_TABLES);
  if (r.length < 44 || !r.ok(44, count * 20)) throw new Error("The WOFF table directory is incomplete.");
  const expanded = new Map<string, Table>();
  let totalExpanded = 0;
  for (let i = 0; i < count; i++) {
    const p = 44 + i * 20;
    const tag = r.tag(p);
    const off = r.u32(p + 4);
    const comp = r.u32(p + 8);
    const original = r.u32(p + 12);
    totalExpanded += original;
    if (
      !r.ok(off, comp)
      || original > 10 * 1024 * 1024
      || comp > original
      || totalExpanded > 32 * 1024 * 1024
    ) {
      throw new Error("A WOFF table has invalid bounds or exceeds the preview memory limit.");
    }
    expanded.set(tag, { offset: 0, length: original, bytes: r.bytes.subarray(off, off + comp) });
  }
  return expanded;
}

/**
 * Parses bounded metadata after the viewer opens. WOFF inflation is dynamically
 * imported so its decompressor stays out of the renderer startup bundle.
 */
export async function readFontInfo(bytes: Uint8Array): Promise<FontInfo> {
  if (bytes.length < 4) throw new Error("The file is too short to contain a font.");
  const r = new Reader(bytes), signature = r.tag(0);
  if (signature === "wOF2") {
    if (r.length < 48 || r.u32(8) !== r.length) {
      throw new Error("The WOFF2 container header is incomplete or has an invalid length.");
    }
    const info: FontInfo = {
      ...EMPTY_INFO,
      format: "WOFF2",
      containerOnly: true,
      containerTableCount: Math.min(r.u16(12), MAX_TABLES),
      containerSize: r.u32(16),
    };
    return info;
  }
  if (signature === "wOFF") {
    const tables = parseWoff(bytes);
    if (tables.size > 0) {
      const { unzlibSync } = await import("fflate");
      for (const table of tables.values()) {
        if (!table.bytes) continue;
        const data = table.bytes.length === table.length
          ? table.bytes
          : unzlibSync(table.bytes, { out: new Uint8Array(table.length) });
        if (data.length !== table.length) {
          throw new Error("A WOFF table did not decompress to its declared size.");
        }
        table.bytes = data;
      }
      const joined = new Uint8Array([...tables.values()].reduce((n, t) => n + t.length, 0));
      let offset = 0;
      for (const table of tables.values()) {
        table.offset = offset;
        joined.set(table.bytes!, offset);
        offset += table.length;
      }
      return enrich(new Reader(joined), tables, {
        ...EMPTY_INFO,
        format: "WOFF",
        collectionCount: null,
        containerOnly: false,
      });
    }
    return { ...EMPTY_INFO, format: "WOFF", containerOnly: false };
  }
  let base = 0;
  let collectionCount: number | null = null;
  let format: FontFormat = signature === "OTTO"
    ? "OpenType"
    : signature === "true" || r.u32(0) === 0x00010000
      ? "TrueType"
      : "Unknown";
  if (signature === "ttcf") {
    format = "TrueType collection";
    if (!r.ok(8, 4)) throw new Error("The font collection header is incomplete.");
    collectionCount = r.u32(8);
    if (collectionCount < 1 || !r.ok(12, collectionCount * 4)) {
      throw new Error("The font collection has no readable faces.");
    }
    base = r.u32(12);
  }
  if (format === "Unknown") throw new Error("This file does not have a supported font signature.");
  const tables = readSfnt(r, base);
  if (!tables.size) throw new Error("The font table directory is incomplete or malformed.");
  return enrich(r, tables, {
    ...EMPTY_INFO,
    format,
    collectionCount,
    containerOnly: false,
  });
}
