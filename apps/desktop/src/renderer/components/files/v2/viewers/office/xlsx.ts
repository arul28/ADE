// Read an `.xlsx` workbook into a small, bounded display model.
//
// Deliberately hand-rolled on top of the bounded zip reader instead of SheetJS:
// the `xlsx` package on npm is years behind its upstream (two known CVEs at
// the last published version) and ships a parser for every spreadsheet format
// ever made. ADE previews exactly one format, from untrusted bytes, and needs
// the first screen of a sheet — not a calculation engine. Everything below is
// bounded by the constants at the top: rows and columns materialized, text
// kept per cell.
//
// The workbook is read in two passes. The first parses the *small* parts
// (`workbook.xml`, its rels, `styles.xml`) and lists the sheets; each sheet
// body is then scanned on demand when its tab is first opened, so a 40-sheet
// workbook costs one sheet's parse, not forty.

import { OoxmlError } from "./ooxmlError";
import {
  columnIndexFromRef,
  decodeXmlEntities,
  elementsNS,
  firstElementNS,
  parseXml,
  relationshipId,
  rowNumberFromRef,
  yieldToEventLoop,
} from "./ooxmlXml";
import { openOoxmlZip, type OoxmlZip } from "./ooxmlZip";

/** Rows materialized per sheet. Past this the grid says so rather than growing. */
export const SPREADSHEET_PREVIEW_MAX_ROWS = 2_000;
/** Columns materialized per sheet. */
export const SPREADSHEET_PREVIEW_MAX_COLS = 64;
/** Characters kept per cell; a spreadsheet cell holding an essay is truncated. */
const MAX_CELL_CHARS = 2_000;
/** Rows scanned between event-loop yields, so a large sheet cannot jank a frame. */
const ROWS_PER_YIELD = 500;
/** The default column width, in the same pixels the explicit widths use. */
const DEFAULT_COLUMN_WIDTH_PX = 112;
const MIN_COLUMN_WIDTH_PX = 56;
const MAX_COLUMN_WIDTH_PX = 320;

export type SpreadsheetSheetInfo = {
  name: string;
  /** Package path of the worksheet part; null for chart sheets and the like. */
  path: string | null;
  hidden: boolean;
};

export type SpreadsheetWindow = {
  /** Display strings, row-major, starting at `firstCol`. */
  rows: string[][];
  /** 1-based row number for each materialized row (sheets can be sparse). */
  rowNumbers: number[];
  /** Total rows in the used range (may exceed `rows.length`). */
  rowCount: number;
  /** Total columns in the used range (may exceed `rows[0].length`). */
  colCount: number;
  /** 1-based index of the first materialized column. */
  firstCol: number;
  /** Pixel width per materialized column, honouring the sheet's own `<cols>`. */
  colWidthsPx: number[];
  truncatedRows: boolean;
  truncatedCols: boolean;
  /** The sheet has no cells at all. */
  empty: boolean;
  /** One honest line about why a sheet shows nothing, when it is not just empty. */
  notice: string | null;
};

export type SpreadsheetWorkbook = {
  sheets: SpreadsheetSheetInfo[];
  /** Sheet this workbook should open on (first visible sheet). */
  defaultSheetIndex: number;
  /**
   * Read one sheet's display window. Results are cached per sheet for the
   * lifetime of the workbook object; a second call is free.
   */
  readSheet(index: number): Promise<SpreadsheetWindow>;
};

/* ── Styles: which cells are dates, and how they print ─────────────────── */

type CellFormatKind = "general" | "date" | "time" | "datetime" | "percent";

/**
 * Built-in numFmtIds that mean date, time, or both (ECMA-376 §18.8.30).
 * 27–36 are the East-Asian date forms, 45–47 time/duration, 50–58 the
 * remaining regional dates.
 */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function formatKindForNumFmtId(id: number, customCode: string | undefined): CellFormatKind {
  if (customCode !== undefined) return classifyFormatCode(customCode);
  if (id === 9 || id === 10) return "percent";
  if (!BUILTIN_DATE_IDS.has(id)) return "general";
  if (id === 14 || id === 15 || id === 16 || id === 17) return "date";
  if (id === 22) return "datetime";
  if (id >= 18 && id <= 21) return "time";
  if (id >= 45 && id <= 47) return "time";
  return "date";
}

/**
 * Decide what a custom format code means. Quoted literals are removed first
 * (`"USD" #,##0` is a number), then bracketed sections — except `[h]`/`[m]`/
 * `[s]`, which are elapsed-time tokens and *are* time. `m` alone is month or
 * minute and unknowable without context; treating it as time renders `01` for
 * a month-only format, which is the rarer of the two collisions.
 */
export function classifyFormatCode(code: string): CellFormatKind {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/_(.)/g, "")
    .replace(/\*(.)/g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  if (stripped.includes("%")) return "percent";
  const hasYearOrDay = /[yd]/i.test(stripped);
  const hasTime = /[hs]/i.test(stripped) || /\[[hms]+\]/i.test(stripped);
  const hasMonthOrMinute = /m/i.test(stripped);
  if (hasYearOrDay) return hasTime ? "datetime" : "date";
  if (hasTime || hasMonthOrMinute) return "time";
  return "general";
}

function parseCellFormats(stylesXml: string | null): CellFormatKind[] {
  if (!stylesXml) return [];
  const doc = parseXml(stylesXml);
  if (!doc) return [];

  const customCodes = new Map<number, string>();
  const numFmts = firstElementNS(doc, "numFmts");
  if (numFmts) {
    for (const numFmt of elementsNS(numFmts, "numFmt")) {
      const id = Number(numFmt.getAttribute("numFmtId"));
      if (Number.isFinite(id)) customCodes.set(id, numFmt.getAttribute("formatCode") ?? "");
    }
  }

  const formats: CellFormatKind[] = [];
  const cellXfs = firstElementNS(doc, "cellXfs");
  if (cellXfs) {
    for (const child of Array.from(cellXfs.children)) {
      if (child.localName !== "xf") continue;
      const id = Number(child.getAttribute("numFmtId") ?? "0");
      formats.push(formatKindForNumFmtId(Number.isFinite(id) ? id : 0, customCodes.get(id)));
    }
  }
  return formats;
}

/* ── Dates ─────────────────────────────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;

/**
 * Excel serial → display text.
 *
 * 1900 system: serial 1 is 1900-01-01, and the well-known bug means serial 60
 * is the day that never existed (1900-02-29); everything at or past it is
 * shifted by one, which the `serial >= 60` branch corrects. The 1904 system
 * (old Mac Excel) starts at 1904-01-01 with serial 0.
 */
export function formatExcelSerial(serial: number, kind: CellFormatKind, date1904: boolean): string {
  const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const dayShift = !date1904 && serial < 60 ? 1 : 0;
  const ms = epochMs + (serial + dayShift) * MS_PER_DAY;
  const date = new Date(Math.round(ms));
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) return String(serial);

  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mi = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  const hasSeconds = date.getUTCSeconds() !== 0;

  if (kind === "date") return `${yyyy}-${mm}-${dd}`;
  if (kind === "time") return hasSeconds ? `${hh}:${mi}:${ss}` : `${hh}:${mi}`;
  return hasSeconds ? `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}` : `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/* ── Text runs ─────────────────────────────────────────────────────────── */

/**
 * Collect the `<t>` runs of an XML fragment (a shared-string item, an inline
 * string, a text cell), skipping phonetic runs, and decode entities.
 *
 * The scanners in this file work on raw XML text rather than a DOM, which is
 * what keeps a 30 MB worksheet away from the DOM parser; the cost is that
 * entity decoding has to happen here.
 */
export function collectTextRuns(fragment: string): string {
  if (!fragment.length) return "";
  const working = fragment.includes("<rPh") ? fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "") : fragment;
  let out = "";
  let pos = 0;
  while (pos < working.length) {
    const start = working.indexOf("<t", pos);
    if (start === -1) break;
    const boundary = working.charCodeAt(start + 2);
    // "<t>" | "<t …" | "<t/>" only — never "<target" or "<tableCell".
    if (!(boundary === 0x3e || boundary === 0x20 || boundary === 0x2f)) {
      pos = start + 2;
      continue;
    }
    const tagEnd = working.indexOf(">", start);
    if (tagEnd === -1) break;
    if (working[tagEnd - 1] === "/") {
      pos = tagEnd + 1;
      continue;
    }
    const close = working.indexOf("</t>", tagEnd + 1);
    if (close === -1) break;
    out += working.slice(tagEnd + 1, close);
    pos = close + 4;
  }
  return decodeXmlEntities(out);
}

/**
 * Resolve only the shared-string indexes a scanned window actually references.
 *
 * The table can hold hundreds of thousands of strings; materializing all of
 * them would cost the preview many megabytes for cells nobody is looking at.
 * The scan walks the raw XML once, keeping just the wanted entries.
 */
async function readSharedStrings(zip: OoxmlZip, wanted: ReadonlySet<number>): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();
  if (wanted.size === 0) return resolved;
  const text = await zip.readText("xl/sharedStrings.xml");
  if (!text) return resolved;

  let pos = 0;
  let index = 0;
  let sinceYield = 0;
  while (pos < text.length) {
    const start = text.indexOf("<si", pos);
    if (start === -1) break;
    const boundary = text.charCodeAt(start + 3);
    if (!(boundary === 0x3e || boundary === 0x20 || boundary === 0x2f)) {
      pos = start + 3;
      continue;
    }
    const tagEnd = text.indexOf(">", start);
    if (tagEnd === -1) break;
    const selfClosing = text[tagEnd - 1] === "/";
    let inner = "";
    let end = tagEnd + 1;
    if (!selfClosing) {
      const close = text.indexOf("</si>", tagEnd + 1);
      if (close === -1) break;
      inner = text.slice(tagEnd + 1, close);
      end = close + 5;
    }
    if (wanted.has(index)) resolved.set(index, collectTextRuns(inner));
    index += 1;
    pos = end;
    if (++sinceYield >= 20_000) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return resolved;
}

/* ── Worksheet scan ────────────────────────────────────────────────────── */

type RawCellType = "shared" | "inline" | "text" | "bool" | "error" | "number";

type RawCell = {
  /** 0-based column index. */
  col: number;
  type: RawCellType;
  raw: string;
  styleIndex: number;
};

/**
 * The scanned worksheet, before shared strings are resolved. Exported for
 * tests: this is the pure part of the reader.
 */
export type SheetScan = {
  rows: RawCell[][];
  /**
   * The sheet's own 1-based row number for each scanned row. Sheets are
   * sparse (a `<dimension>` can claim `A1:F900` while the rows that exist
   * start at row 5), and Excel's row gutter shows the real numbers, so the
   * labels travel with the rows instead of being recomputed from the first
   * one.
   */
  rowNumbers: number[];
  /** Total rows in the sheet, not just the window. */
  rowCount: number;
  /** Total columns in the used range. */
  colCount: number;
  /** 1-based column of the window's first materialized column. */
  firstCol: number;
  colWidthsPx: number[];
  truncatedRows: boolean;
  truncatedCols: boolean;
  /** Shared-string indexes the window references, for the resolver pass. */
  sharedWanted: Set<number>;
};

function attrValue(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? match[1]! : null;
}

function parseColWidths(text: string): number[] {
  const widths: number[] = [];
  const colsStart = text.indexOf("<cols");
  if (colsStart === -1) return widths;
  const colsEnd = text.indexOf("</cols>", colsStart);
  if (colsEnd === -1) return widths;
  const section = text.slice(colsStart, colsEnd);
  const colRe = /<col\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = colRe.exec(section)) !== null) {
    const attrs = match[1] ?? "";
    const min = Number(attrValue(attrs, "min") ?? "0");
    const max = Number(attrValue(attrs, "max") ?? "0");
    const width = Number(attrValue(attrs, "width") ?? "0");
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(width) || min < 1 || max < min) continue;
    // Excel's own character-width → pixel conversion (MDW 7 px for the
    // default font), clamped so one absurd `<col width="800"/>` cannot demand
    // an 8,000 px grid. The 200-column spread cap bounds a `<col min="1"
    // max="16384"/>` default element.
    const px = Math.min(MAX_COLUMN_WIDTH_PX, Math.max(MIN_COLUMN_WIDTH_PX, Math.round(width * 7) + 5));
    for (let col = min; col <= Math.min(max, min + 200); col++) widths[col - 1] = px;
  }
  return widths;
}

function parseDimension(text: string): { firstRow: number; firstCol: number; rowCount: number; colCount: number } | null {
  const ref = /<dimension\b[^>]*ref="([^"]+)"/.exec(text)?.[1];
  if (!ref) return null;
  const range = ref.split(":");
  const start = range[0] ?? "";
  const end = range[1] ?? range[0] ?? "";
  const startCol = columnIndexFromRef(/^[A-Za-z]+/.exec(start)?.[0] ?? "");
  const startRow = rowNumberFromRef(start);
  const endCol = columnIndexFromRef(/^[A-Za-z]+/.exec(end)?.[0] ?? "");
  const endRow = rowNumberFromRef(end);
  if (startCol < 0 || endCol < 0 || startRow < 1 || endRow < 1) return null;
  return {
    firstRow: Math.min(startRow, endRow),
    firstCol: Math.min(startCol, endCol),
    rowCount: Math.abs(endRow - startRow) + 1,
    colCount: Math.abs(endCol - startCol) + 1,
  };
}

/** First `<v>` / `<f>`-style child's text within a cell body (no nested tags). */
function extractElementText(inner: string, name: string): string {
  const start = inner.indexOf(`<${name}`);
  if (start === -1) return "";
  const boundary = inner.charCodeAt(start + name.length + 1);
  if (!(boundary === 0x3e || boundary === 0x20 || boundary === 0x2f)) return "";
  const tagEnd = inner.indexOf(">", start);
  if (tagEnd === -1) return "";
  if (inner[tagEnd - 1] === "/") return "";
  const close = inner.indexOf(`</${name}>`, tagEnd + 1);
  if (close === -1) return "";
  return inner.slice(tagEnd + 1, close);
}

/** Cells of one `<row>` body, with the row's own column bookkeeping applied. */
function parseRowCells(body: string, sharedWanted: Set<number>): RawCell[] {
  const cells: RawCell[] = [];
  let expectedCol = -1;
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf("<c", pos);
    if (start === -1) break;
    const boundary = body.charCodeAt(start + 2);
    if (!(boundary === 0x3e || boundary === 0x20 || boundary === 0x2f)) {
      pos = start + 2;
      continue;
    }
    const tagEnd = body.indexOf(">", start);
    if (tagEnd === -1) break;
    const attrs = body.slice(start + 2, tagEnd);
    const selfClosing = body[tagEnd - 1] === "/";

    const ref = attrValue(attrs, "r");
    let col = ref ? columnIndexFromRef(ref.replace(/\d+$/, "")) : -1;
    if (col < 0) col = expectedCol; // Producers that omit `r` store cells in order.
    if (col < 0) {
      pos = tagEnd + 1;
      continue;
    }
    expectedCol = col + 1;

    const typeAttr = attrValue(attrs, "t") ?? "n";
    const styleIndexRaw = Number(attrValue(attrs, "s") ?? "0");

    let inner = "";
    let end = tagEnd + 1;
    if (!selfClosing) {
      const close = body.indexOf("</c>", tagEnd + 1);
      if (close === -1) break;
      inner = body.slice(tagEnd + 1, close);
      end = close + 4;
    }
    pos = end;

    let type: RawCellType;
    let raw = "";
    if (typeAttr === "s") {
      type = "shared";
      raw = inner.indexOf("<v") === -1 ? "" : extractElementText(inner, "v");
      const index = Number(raw);
      if (Number.isFinite(index)) sharedWanted.add(index);
    } else if (typeAttr === "inlineStr") {
      type = "inline";
      raw = collectTextRuns(inner);
    } else if (typeAttr === "str") {
      type = "text";
      raw = decodeXmlEntities(extractElementText(inner, "v"));
    } else if (typeAttr === "b") {
      type = "bool";
      raw = extractElementText(inner, "v");
    } else if (typeAttr === "e") {
      type = "error";
      raw = decodeXmlEntities(extractElementText(inner, "v"));
    } else if (typeAttr === "d") {
      // ECMA-376 ISO-8601 date cell: already display-shaped.
      type = "text";
      raw = extractElementText(inner, "v");
    } else {
      type = "number";
      raw = extractElementText(inner, "v");
      if (raw === "" && inner.includes("<f")) {
        // A formula with no cached result: show the formula rather than a
        // blank cell, which would read as "empty".
        const formula = decodeXmlEntities(extractElementText(inner, "f"));
        if (formula) {
          type = "text";
          raw = `=${formula}`;
        }
      }
    }

    if (raw !== "" || type === "number") {
      cells.push({ col, type, raw, styleIndex: Number.isFinite(styleIndexRaw) ? styleIndexRaw : 0 });
    }
  }
  return cells;
}

/**
 * Walk a worksheet's `<sheetData>` once. Rows inside the window have their
 * cells parsed; rows past it are counted and skipped, so a 200,000-row sheet
 * costs a cheap string scan rather than 200,000 parsed rows.
 */
export async function scanSheetXml(text: string): Promise<SheetScan> {
  const widthByColumn = parseColWidths(text);
  const dimension = parseDimension(text);
  const sharedWanted = new Set<number>();

  const rows: RawCell[][] = [];
  const rowNumbers: number[] = [];
  let rowCount = 0;
  let observedFirstCol = -1;
  let observedMaxCol = -1;
  let lastRowNumber = dimension?.firstRow ?? 1;
  let sinceYield = 0;

  const rowRe = /<row(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(text)) !== null) {
    const tagEnd = text.indexOf(">", match.index);
    if (tagEnd === -1) break;
    const attrs = text.slice(match.index + 4, tagEnd);
    const selfClosing = text[tagEnd - 1] === "/";
    const declared = Number(attrValue(attrs, "r") ?? "");
    const rowNumber = Number.isFinite(declared) && declared >= 1
      ? declared
      : (rowCount === 0 ? lastRowNumber : lastRowNumber + 1);
    lastRowNumber = rowNumber;
    rowCount += 1;

    let nextPos = tagEnd + 1;
    if (!selfClosing) {
      const close = text.indexOf("</row>", tagEnd + 1);
      if (close === -1) break;
      nextPos = close + 6;
      if (rows.length < SPREADSHEET_PREVIEW_MAX_ROWS) {
        const cells = parseRowCells(text.slice(tagEnd + 1, close), sharedWanted);
        for (const cell of cells) {
          if (observedFirstCol < 0 || cell.col < observedFirstCol) observedFirstCol = cell.col;
          if (cell.col > observedMaxCol) observedMaxCol = cell.col;
        }
        rows.push(cells);
        rowNumbers.push(rowNumber);
        if (++sinceYield >= ROWS_PER_YIELD) {
          sinceYield = 0;
          await yieldToEventLoop();
        }
      }
    } else if (observedFirstCol < 0) {
      // A self-closing row carries no cells; keep at least column A addressable.
      observedFirstCol = 0;
    }
    rowRe.lastIndex = nextPos;
  }

  const firstCol = dimension?.firstCol ?? (observedFirstCol >= 0 ? observedFirstCol : 0);
  const observedColCount = observedMaxCol >= firstCol ? observedMaxCol - firstCol + 1 : 0;
  const colCount = Math.max(dimension?.colCount ?? 0, observedColCount, 0);
  // The reported size is the used range (what Excel's own "used range" means),
  // but truncation is about ROWS SCANNED vs rows kept: a sheet whose `<row>`
  // elements all made it into the window is complete even when its dimension
  // spans an empty row in the middle, and calling that "truncated" would put a
  // misleading "showing the first 7 of 8 rows" strip on a fully shown sheet.
  const rowCountTotal = Math.max(dimension?.rowCount ?? 0, rowCount);

  const visibleColCount = Math.min(colCount, SPREADSHEET_PREVIEW_MAX_COLS);
  const colWidthsPx: number[] = [];
  for (let col = 0; col < visibleColCount; col++) {
    colWidthsPx.push(widthByColumn[firstCol + col] ?? DEFAULT_COLUMN_WIDTH_PX);
  }

  return {
    rows,
    rowNumbers,
    rowCount: rowCountTotal,
    colCount,
    firstCol: firstCol + 1,
    colWidthsPx,
    truncatedRows: rowCount > rows.length,
    truncatedCols: colCount > visibleColCount,
    sharedWanted,
  };
}

/* ── Cell formatting ───────────────────────────────────────────────────── */

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}

function formatCell(cell: RawCell, shared: Map<number, string>, formats: CellFormatKind[], date1904: boolean): string {
  let text: string;
  switch (cell.type) {
    case "shared": {
      const index = Number(cell.raw);
      text = Number.isFinite(index) ? shared.get(index) ?? "" : "";
      break;
    }
    case "inline":
    case "text":
      text = cell.raw;
      break;
    case "bool":
      text = cell.raw === "1" ? "TRUE" : cell.raw === "0" ? "FALSE" : "";
      break;
    case "error":
      text = cell.raw;
      break;
    case "number":
    default: {
      const value = Number(cell.raw);
      if (cell.raw === "" || !Number.isFinite(value)) {
        text = cell.raw;
        break;
      }
      const kind = formats[cell.styleIndex] ?? "general";
      if (kind === "general") text = cell.raw;
      else if (kind === "percent") text = `${trimTrailingZeros((value * 100).toFixed(2))}%`;
      else text = formatExcelSerial(value, kind, date1904);
      break;
    }
  }
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS)}…`;
  return text;
}

/* ── Workbook assembly ─────────────────────────────────────────────────── */

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export function parseSheetList(workbookXml: string, relsXml: string | null): SpreadsheetSheetInfo[] {
  const doc = parseXml(workbookXml);
  if (!doc) throw new OoxmlError("invalid", "xl/workbook.xml is not valid XML.");

  const relTargets = new Map<string, { target: string; type: string }>();
  if (relsXml) {
    const relsDoc = parseXml(relsXml);
    if (relsDoc) {
      for (const rel of elementsNS(relsDoc, "Relationship")) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (id && target) relTargets.set(id, { target, type: rel.getAttribute("Type") ?? "" });
      }
    }
  }

  const sheets: SpreadsheetSheetInfo[] = [];
  const container = firstElementNS(doc, "sheets");
  if (container) {
    for (const sheet of elementsNS(container, "sheet")) {
      const name = sheet.getAttribute("name") ?? `Sheet ${sheets.length + 1}`;
      const state = sheet.getAttribute("state");
      const relId = relationshipId(sheet, "id") ?? "";
      const rel = relId ? relTargets.get(relId) ?? null : null;
      // A chartsheet/dialogsheet resolves to a part with no `<sheetData>`;
      // only real worksheets get a path, so the tab can say what it is.
      const isWorksheet = rel
        ? rel.type.includes("/worksheet") || rel.target.includes("worksheets/")
        : false;
      sheets.push({
        name,
        path: rel && isWorksheet ? resolvePartPath("xl", rel.target) : null,
        hidden: state === "hidden" || state === "veryHidden",
      });
    }
  }
  if (sheets.length === 0) throw new OoxmlError("invalid", "This workbook declares no sheets.");
  return sheets;
}

function readDate1904(workbookXml: string): boolean {
  return /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbookXml);
}

function emptyWindow(colWidthsPx: number[] = [], notice: string | null = null): SpreadsheetWindow {
  return {
    rows: [],
    rowNumbers: [],
    rowCount: 0,
    colCount: 0,
    firstCol: 1,
    colWidthsPx,
    truncatedRows: false,
    truncatedCols: false,
    empty: true,
    notice,
  };
}

export async function openXlsx(bytes: Uint8Array): Promise<SpreadsheetWorkbook> {
  const zip = await openOoxmlZip(bytes);

  const workbookXml = await zip.readText("xl/workbook.xml");
  if (!workbookXml) {
    throw new OoxmlError("invalid", "This package has no xl/workbook.xml — it is not an .xlsx workbook.");
  }
  const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
  const sheets = parseSheetList(workbookXml, relsXml);
  const date1904 = readDate1904(workbookXml);
  const formats = parseCellFormats(await zip.readText("xl/styles.xml"));

  const cache = new Map<number, Promise<SpreadsheetWindow>>();
  const defaultSheetIndex = Math.max(0, sheets.findIndex((sheet) => !sheet.hidden));

  function readSheet(index: number): Promise<SpreadsheetWindow> {
    const cached = cache.get(index);
    if (cached) return cached;
    const pending = readSheetUncached(index);
    cache.set(index, pending);
    // A failed read must not be cached as the sheet's answer forever.
    pending.catch(() => cache.delete(index));
    return pending;
  }

  async function readSheetUncached(index: number): Promise<SpreadsheetWindow> {
    const info = sheets[index];
    if (!info) throw new OoxmlError("invalid", "That sheet does not exist.");
    if (!info.path) return emptyWindow([], "This sheet is not a grid (a chart or dialog sheet).");
    const text = await zip.readText(info.path);
    if (!text) throw new OoxmlError("corrupt", `The sheet part “${info.path}” is missing.`);
    const scan = await scanSheetXml(text);
    const shared = await readSharedStrings(zip, scan.sharedWanted);
    return materializeWindow(scan, shared, formats, date1904);
  }

  return { sheets, defaultSheetIndex, readSheet };
}

/** Turn a scan plus its resolved shared strings into the display window. */
export function materializeWindow(
  scan: SheetScan,
  shared: Map<number, string>,
  formats: CellFormatKind[],
  date1904: boolean,
): SpreadsheetWindow {
  const visibleColCount = scan.colWidthsPx.length;
  const rows: string[][] = new Array(scan.rows.length);
  for (let r = 0; r < scan.rows.length; r++) {
    const row = new Array<string>(visibleColCount).fill("");
    for (const cell of scan.rows[r]!) {
      const offset = cell.col - (scan.firstCol - 1);
      if (offset < 0 || offset >= visibleColCount) continue;
      row[offset] = formatCell(cell, shared, formats, date1904);
    }
    rows[r] = row;
  }

  if (scan.rows.length === 0 && scan.rowCount === 0) {
    return emptyWindow(scan.colWidthsPx, null);
  }
  return {
    rows,
    rowNumbers: scan.rowNumbers,
    rowCount: scan.rowCount,
    colCount: scan.colCount,
    firstCol: scan.firstCol,
    colWidthsPx: scan.colWidthsPx,
    truncatedRows: scan.truncatedRows,
    truncatedCols: scan.truncatedCols,
    empty: rows.length === 0,
    notice: null,
  };
}
