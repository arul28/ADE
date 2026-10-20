// Bounded, dependency-free reader for the WordprocessingML subset ADE previews.
// File parts are untrusted: limits here bound model size and work per preview.
import { OoxmlError } from "./ooxmlError";
import { ooxmlMediaMimeType } from "./ooxmlMedia";
import { parseRelationships } from "./ooxmlPackage";
import {
  parseXml,
  elementsNS,
  firstElementNS,
  relationshipId,
  yieldToEventLoop,
} from "./ooxmlXml";
import { openOoxmlZip, ZIP_MAX_MEDIA_BYTES } from "./ooxmlZip";

const WORD_PREVIEW_MAX_BLOCKS = 20_000;
/** Keep a document with millions of short runs from dominating renderer memory. */
const MAX_TEXT_CHARS = 2_000_000;
/** Bound one pathological table and the total number of cells materialized. */
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLS = 100;
const MAX_TABLE_CELLS = 20_000;
/** Nested tables are useful content, but recursion must stay shallow. */
const MAX_NESTING = 4;
/** Yield while scanning long bodies and tables so rendering can continue. */
const BLOCKS_PER_YIELD = 250;
const DOC_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EMU_PER_INCH = 914_400;
const TWIPS_PER_INCH = 1_440;

export type WordRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vertical: "superscript" | "subscript" | null;
  color: string | null;
  highlight: string | null;
  sizePt: number | null;
  family: "serif" | "sans-serif" | "monospace";
  href: string | null;
};
export type WordParagraph = {
  kind: "paragraph";
  /**
   * `heading-N`, unique within the document, on body headings only (the
   * outline's targets). Headings inside table cells get none.
   */
  id: string | null;
  /** Every bookmark that starts in this paragraph (internal link targets). */
  bookmarks: string[];
  headingLevel: number | null;
  style: "normal" | "title" | "subtitle" | "heading";
  align: "left" | "center" | "right" | "justify";
  indentLeftPx: number;
  indentFirstPx: number;
  indentRightPx: number;
  beforePx: number;
  afterPx: number;
  lineHeight: number | null;
  runs: WordRun[];
  list: { marker: string; level: number } | null;
};
export type WordImage = {
  kind: "image";
  path: string | null;
  widthPx: number;
  heightPx: number;
  alt: string;
};
export type WordTable = {
  kind: "table";
  rows: WordTableRow[];
  headerRows: number;
};
export type WordTableRow = { cells: WordTableCell[] };
export type WordTableCell = {
  blocks: WordBlock[];
  colSpan: number;
  rowSpan: number;
  fill: string | null;
  borders: Partial<
    Record<
      "top" | "right" | "bottom" | "left",
      { color: string; width: number }
    >
  >;
};
export type WordBlock =
  WordParagraph | WordImage | WordTable | { kind: "pageBreak" };
export type WordHeading = {
  id: string;
  text: string;
  level: number;
  blockIndex: number;
};
export type WordNotices = {
  charts: number;
  textBoxes: number;
  shapes: number;
  footnotes: number;
  endnotes: number;
  comments: number;
  headers: number;
  footers: number;
  unsupportedImages: number;
  trimmedTables: number;
};
export type WordDocument = {
  blocks: WordBlock[];
  headings: WordHeading[];
  pageWidthPx: number;
  pageHeightPx: number;
  marginsPx: { top: number; right: number; bottom: number; left: number };
  truncated: boolean;
  wordCount: number;
  notices: WordNotices;
  loadMedia(
    path: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null>;
};

function children(el: Element | null, name: string): Element[] {
  return el
    ? Array.from(el.children).filter((child) => child.localName === name)
    : [];
}
function child(el: Element | null, name: string): Element | null {
  return children(el, name)[0] ?? null;
}
function val(el: Element | null, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(DOC_NS, name) ?? el.getAttribute(name) ?? null;
}
function on(el: Element | null, name: string): boolean {
  if (!el) return false;
  const v = val(el, name);
  // In WordprocessingML an empty on/off element means enabled.
  return v == null || (v !== "0" && v !== "false" && v !== "off");
}
function twipsPx(value: string | null, fallback = 0): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(-2000, Math.min(2000, (n * 96) / TWIPS_PER_INCH))
    : fallback;
}
function runSizePt(rPr: Element | null): number | null {
  // Some producers put run properties in a non-schema order and use szCs.
  const size =
    child(rPr, "sz") ??
    Array.from(rPr?.children ?? []).find(
      (element) =>
        element.localName.toLowerCase().replace(/[^a-z]/g, "") === "szcs",
    ) ??
    null;
  const points = Number(val(size, "val"));
  return Number.isFinite(points) && points > 0
    ? Math.min(144, points / 2)
    : null;
}
function safeColor(value: string | null): string | null {
  if (!value || value === "auto") return null;
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`;
  const named: Record<string, string> = {
    yellow: "#ffff00",
    green: "#00ff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    blue: "#0000ff",
    red: "#ff0000",
    darkBlue: "#000080",
    darkRed: "#800000",
    darkGreen: "#008000",
    darkGray: "#808080",
    lightGray: "#c0c0c0",
    black: "#000000",
    white: "#ffffff",
  };
  return named[value] ?? null;
}
function fontFamily(rPr: Element | null): WordRun["family"] {
  const fonts = child(rPr, "rFonts");
  const name =
    ["ascii", "hAnsi", "eastAsia", "cs"]
      .map((key) => val(fonts, key))
      .find(Boolean)
      ?.toLowerCase() ?? "";
  if (/mono|courier|consolas|menlo/.test(name)) return "monospace";
  if (/serif|times|cambria|georgia|garamond/.test(name)) return "serif";
  return "sans-serif";
}
function isHeadingStyle(id: string, name: string): number | null {
  const text = `${id} ${name}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = /(?:heading|title)([1-6])/.exec(text);
  return match ? Number(match[1]) : null;
}
/** The cell's width in grid columns (`w:gridSpan`), bounded. */
function gridSpan(tc: Element): number {
  const span = Number(val(child(child(tc, "tcPr"), "gridSpan"), "val") ?? 1);
  return Number.isFinite(span) ? Math.max(1, Math.min(20, span)) : 1;
}
/** Grid columns a row leaves empty before its first cell (`w:gridBefore`). */
function gridBefore(tr: Element): number {
  const before = Number(
    val(child(child(tr, "trPr"), "gridBefore"), "val") ?? 0,
  );
  return Number.isFinite(before) ? Math.max(0, Math.min(1000, before)) : 0;
}
/** The row's cell that starts at this grid column, or null. */
function cellAtGridColumn(tr: Element, column: number): Element | null {
  let start = gridBefore(tr);
  for (const tc of children(tr, "tc")) {
    if (start === column) return tc;
    if (start > column) return null;
    start += gridSpan(tc);
  }
  return null;
}
function nearestAncestor(el: Element, name: string): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement)
    if (node.localName === name) return node;
  return null;
}

type StyleInfo = {
  basedOn: string | null;
  name: string;
  heading: number | null;
  outline: number | null;
  pPr: Element | null;
  rPr: Element | null;
};
function readStyles(doc: Document | null): Map<string, StyleInfo> {
  const result = new Map<string, StyleInfo>();
  if (!doc) return result;
  for (const style of elementsNS(doc, "style")) {
    const id = val(style, "styleId");
    if (!id) continue;
    const name = val(child(style, "name"), "val") ?? id;
    const outlineText = val(child(child(style, "pPr"), "outlineLvl"), "val");
    const outline = outlineText == null ? null : Number(outlineText) + 1;
    result.set(id, {
      basedOn: val(child(style, "basedOn"), "val"),
      name,
      heading: isHeadingStyle(id, name),
      outline: Number.isFinite(outline) ? outline : null,
      pPr: child(style, "pPr"),
      rPr: child(style, "rPr"),
    });
  }
  return result;
}
function resolveStyle(
  id: string | null,
  styles: Map<string, StyleInfo>,
): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const visited = new Set<string>();
  let current = id;
  while (current && !visited.has(current) && chain.length < 12) {
    visited.add(current);
    const info = styles.get(current);
    if (!info) break;
    chain.unshift(info);
    current = info.basedOn;
  }
  return chain;
}
type NumLevel = {
  fmt: string;
  text: string;
  start: number;
  left: number;
  hanging: number;
};
function parseNumbering(doc: Document | null): {
  nums: Map<string, string>;
  levels: Map<string, NumLevel>;
} {
  const nums = new Map<string, string>();
  const levels = new Map<string, NumLevel>();
  if (!doc) return { nums, levels };
  for (const abs of elementsNS(doc, "abstractNum")) {
    const absId = val(abs, "abstractNumId");
    if (absId == null) continue;
    for (const lvl of children(abs, "lvl")) {
      const ix = Number(val(lvl, "ilvl") ?? 0);
      const pPr = child(lvl, "pPr");
      const ind = child(pPr, "ind");
      levels.set(`${absId}:${ix}`, {
        fmt: val(child(lvl, "numFmt"), "val") ?? "bullet",
        text: val(child(lvl, "lvlText"), "val") ?? "•",
        start: Number(val(child(lvl, "start"), "val") ?? 1),
        left: twipsPx(val(ind, "left")),
        hanging: twipsPx(val(ind, "hanging")),
      });
    }
  }
  for (const num of elementsNS(doc, "num")) {
    const id = val(num, "numId");
    const abs = val(child(num, "abstractNumId"), "val");
    if (id && abs) nums.set(id, abs);
  }
  return { nums, levels };
}
function roman(value: number): string {
  if (value < 1 || value > 3999) return String(value);
  const pairs: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let n = value;
  let out = "";
  for (const [v, s] of pairs)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}
function letter(value: number): string {
  let n = Math.max(1, value);
  let s = "";
  while (n) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
function listMarker(level: NumLevel, value: number): string {
  const number =
    level.fmt === "lowerLetter"
      ? letter(value)
      : level.fmt === "upperLetter"
        ? letter(value).toUpperCase()
        : level.fmt === "lowerRoman"
          ? roman(value).toLowerCase()
          : level.fmt === "upperRoman"
            ? roman(value)
            : String(value);
  return level.fmt === "bullet"
    ? level.text.replace(/%\d+/g, "•")
    : level.text.replace(/%\d+/g, number);
}
function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // The ADE browser accepts only web/mail links from a document. In
    // particular, reject script, file and data URLs from untrusted packages.
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function paragraphText(p: WordParagraph): string {
  return p.runs.map((r) => r.text).join("");
}
function blockText(block: WordBlock): string {
  if (block.kind === "paragraph") return paragraphText(block);
  if (block.kind === "table")
    return block.rows
      .flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map(blockText)))
      .join(" ");
  return "";
}

function cellBorders(cell: Element): WordTableCell["borders"] {
  const out: WordTableCell["borders"] = {};
  const borders = child(child(cell, "tcPr"), "tcBorders");
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const edge = child(borders, side);
    if (!edge || val(edge, "val") === "nil" || val(edge, "val") === "none")
      continue;
    out[side] = {
      color: safeColor(val(edge, "color")) ?? "#d1d5db",
      width: Math.max(1, Math.min(4, Number(val(edge, "sz") ?? 4) / 4)),
    };
  }
  return out;
}

/** Read the supported WordprocessingML parts into a bounded display model. */
export async function openDocx(bytes: Uint8Array): Promise<WordDocument> {
  const zip = await openOoxmlZip(bytes);
  const documentXml = await zip.readText("word/document.xml");
  if (!documentXml)
    throw new OoxmlError(
      "invalid",
      "This package has no word/document.xml — it is not a .docx document.",
    );
  const doc = parseXml(documentXml);
  if (!doc)
    throw new OoxmlError("invalid", "word/document.xml is not valid XML.");
  const stylesXml = await zip.readText("word/styles.xml");
  const numberingXml = await zip.readText("word/numbering.xml");
  const styles = readStyles(stylesXml ? parseXml(stylesXml) : null);
  const numbering = parseNumbering(
    numberingXml ? parseXml(numberingXml) : null,
  );
  // External targets are kept for hyperlinks; media loading separately
  // requires an internal relationship, so linked images are never fetched.
  const rels = parseRelationships(
    await zip.readText("word/_rels/document.xml.rels"),
    "word",
    { keepExternal: true },
  );
  const body = firstElementNS(doc, "body");
  if (!body)
    throw new OoxmlError("invalid", "This document has no readable body.");
  const sect =
    child(body, "sectPr") ?? elementsNS(body, "sectPr").at(-1) ?? null;
  const pgSz = child(sect, "pgSz");
  const pgMar = child(sect, "pgMar");
  const widthIn = Number(val(pgSz, "w") ?? 12240) / TWIPS_PER_INCH;
  const heightIn = Number(val(pgSz, "h") ?? 15840) / TWIPS_PER_INCH;
  const pageWidthPx = Math.max(
    240,
    Math.min(2000, (Number.isFinite(widthIn) ? widthIn : 8.5) * 96),
  );
  const pageHeightPx = Math.max(
    320,
    Math.min(3000, (Number.isFinite(heightIn) ? heightIn : 11) * 96),
  );
  const marginsPx = {
    top: twipsPx(val(pgMar, "top"), 96),
    right: twipsPx(val(pgMar, "right"), 96),
    bottom: twipsPx(val(pgMar, "bottom"), 96),
    left: twipsPx(val(pgMar, "left"), 96),
  };
  const notices: WordNotices = {
    charts: 0,
    textBoxes: 0,
    shapes: 0,
    footnotes: 0,
    endnotes: 0,
    comments: 0,
    headers: 0,
    footers: 0,
    unsupportedImages: 0,
    trimmedTables: 0,
  };
  notices.charts = elementsNS(doc, "chart").length;
  notices.textBoxes = elementsNS(doc, "txbxContent").length;
  notices.shapes = elementsNS(doc, "sp").length;
  // A part that is missing or not valid XML counts as nothing to show. Word
  // also writes separator and continuation-separator entries into the
  // footnote and endnote parts; those carry a `w:type`, real notes do not.
  const countInPart = async (path: string, name: string, notesOnly = false) => {
    if (!zip.entries.has(path)) return 0;
    const part = parseXml((await zip.readText(path)) ?? "");
    if (!part) return 0;
    const found = elementsNS(part, name);
    return notesOnly ? found.filter((element) => !val(element, "type")).length : found.length;
  };
  notices.footnotes = await countInPart("word/footnotes.xml", "footnote", true);
  notices.endnotes = await countInPart("word/endnotes.xml", "endnote", true);
  notices.comments = await countInPart("word/comments.xml", "comment");
  notices.headers = Array.from(zip.entries.keys()).filter((name) =>
    /^word\/header\d+\.xml$/.test(name),
  ).length;
  notices.footers = Array.from(zip.entries.keys()).filter((name) =>
    /^word\/footer\d+\.xml$/.test(name),
  ).length;
  // Raster-only: ADE renders media through <img>, never file-derived SVG.
  const imageMimeType = (path: string) =>
    ooxmlMediaMimeType(path, { browserRasterOnly: true });
  const blocks: WordBlock[] = [];
  const headings: WordHeading[] = [];
  const counters = new Map<string, number>();
  let textChars = 0;
  let truncated = false;
  let sinceYield = 0;
  let tableCells = 0;
  let headingSeq = 0;

  const push = (block: WordBlock) => {
    if (blocks.length >= WORD_PREVIEW_MAX_BLOCKS) {
      truncated = true;
      return;
    }
    blocks.push(block);
  };
  const runModel = (
    run: Element,
    href: string | null,
    inheritedRPr: Element | null,
  ): WordRun[] => {
    const rPr = child(run, "rPr") ?? inheritedRPr;
    const output: WordRun[] = [];
    for (const node of Array.from(run.childNodes)) {
      if (node.nodeType === 3) continue;
      if (!(node instanceof Element)) continue;
      const name = node.localName;
      let text: string | null = null;
      if (name === "t" || name === "delText" || name === "instrText")
        text = node.textContent ?? "";
      else if (name === "tab" || name === "ptab") text = "\t";
      else if (name === "br" || name === "cr")
        text = val(node, "type") === "page" ? "\u000c" : "\n";
      else if (name === "sym") {
        const hex = val(node, "char");
        if (hex && /^[0-9a-f]{1,4}$/i.test(hex))
          text = String.fromCharCode(parseInt(hex, 16));
      }
      if (!text) continue;
      if (text === "\u000c") {
        output.push({
          text,
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          vertical: null,
          color: null,
          highlight: null,
          sizePt: null,
          family: "sans-serif",
          href: null,
        });
        continue;
      }
      const vert = val(child(rPr, "vertAlign"), "val");
      const underline = val(child(rPr, "u"), "val");
      const sizePt = runSizePt(rPr);
      output.push({
        text,
        bold: on(child(rPr, "b"), "val"),
        italic: on(child(rPr, "i"), "val"),
        underline: underline != null && underline !== "none" && underline !== "0",
        strike:
          on(child(rPr, "strike"), "val") || on(child(rPr, "dstrike"), "val"),
        vertical:
          vert === "superscript"
            ? "superscript"
            : vert === "subscript"
              ? "subscript"
              : null,
        color: safeColor(val(child(rPr, "color"), "val")),
        highlight: safeColor(val(child(rPr, "highlight"), "val")),
        sizePt,
        family: fontFamily(rPr),
        href,
      });
    }
    return output;
  };
  const parseParagraph = (p: Element, cell: boolean): WordParagraph => {
    const pPr = child(p, "pPr");
    const styleId = val(child(pPr, "pStyle"), "val");
    const chain = resolveStyle(styleId, styles);
    const styleInfo = chain.at(-1);
    const outlineText = val(child(pPr, "outlineLvl"), "val");
    const outlineValue = outlineText == null ? Number.NaN : Number(outlineText);
    const inheritedHeading = [...chain]
      .reverse()
      .find((style) => style.heading != null || style.outline != null);
    const headingLevel =
      Number.isFinite(outlineValue) && outlineValue >= 0 && outlineValue <= 8
        ? outlineValue + 1
        : (inheritedHeading?.heading ?? inheritedHeading?.outline ?? null);
    const styleName = `${styleId ?? ""} ${styleInfo?.name ?? ""}`.toLowerCase();
    const style: WordParagraph["style"] = /subtitle/.test(styleName)
      ? "subtitle"
      : /title/.test(styleName)
        ? "title"
        : headingLevel != null
          ? "heading"
          : "normal";
    const pPrEffective =
      child(pPr, "ind") ?? child(styleInfo?.pPr ?? null, "ind");
    const spacing =
      child(pPr, "spacing") ?? child(styleInfo?.pPr ?? null, "spacing");
    const rawAlign =
      val(child(pPr, "jc"), "val") ??
      val(child(styleInfo?.pPr ?? null, "jc"), "val");
    const align =
      rawAlign === "center"
        ? "center"
        : rawAlign === "right" || rawAlign === "end"
          ? "right"
          : rawAlign === "both" || rawAlign === "distribute"
            ? "justify"
            : "left";
    const bookmarks = Array.from(
      new Set(
        elementsNS(p, "bookmarkStart").flatMap((bookmark) => {
          const name = val(bookmark, "name");
          return name ? [name] : [];
        }),
      ),
    );
    const id = !cell && headingLevel ? `heading-${headingSeq++}` : null;
    const runs: WordRun[] = [];
    const collect = (parent: Element, href: string | null = null) => {
      for (const item of Array.from(parent.children)) {
        if (item.localName === "hyperlink") {
          const relId = relationshipId(item, "id");
          const rel = relId ? rels.get(relId) : null;
          const target = rel?.external ? safeHref(rel.target) : null;
          const anchor = val(item, "anchor");
          collect(
            item,
            target ?? (anchor ? `#${encodeURIComponent(anchor)}` : href),
          );
        } else if (
          item.localName === "r" ||
          item.localName === "smartTag" ||
          item.localName === "sdt"
        ) {
          if (item.localName === "r")
            runs.push(
              ...runModel(
                item,
                href,
                child(item, "rPr") ??
                  chain
                    .map((s) => s.rPr)
                    .filter(Boolean)
                    .at(-1) ??
                  null,
              ),
            );
          else collect(item, href);
        }
      }
    };
    collect(p);
    // Adjacent equal formatting becomes one selectable text run.
    const merged: WordRun[] = [];
    for (const run of runs) {
      textChars += run.text.length;
      if (textChars > MAX_TEXT_CHARS) {
        truncated = true;
        break;
      }
      const prev = merged.at(-1);
      if (
        prev &&
        Object.keys(run).every(
          (key) =>
            key === "text" ||
            run[key as keyof WordRun] === prev[key as keyof WordRun],
        )
      )
        prev.text += run.text;
      else merged.push({ ...run });
    }
    const numPr = child(pPr, "numPr");
    const numId = val(child(numPr, "numId"), "val");
    const levelIndex = Math.max(
      0,
      Math.min(8, Number(val(child(numPr, "ilvl"), "val") ?? 0)),
    );
    let list: WordParagraph["list"] = null;
    let listLeftPx = 0;
    let listHangingPx = 0;
    if (numId && numId !== "0") {
      const absId = numbering.nums.get(numId);
      const lvl = absId
        ? numbering.levels.get(`${absId}:${levelIndex}`)
        : undefined;
      if (lvl) {
        const key = `${numId}:${levelIndex}`;
        const value = (counters.get(key) ?? lvl.start - 1) + 1;
        counters.set(key, value);
        for (const old of Array.from(counters.keys()))
          if (
            old.startsWith(`${numId}:`) &&
            old !== key &&
            Number(old.split(":")[1]) > levelIndex
          )
            counters.delete(old);
        list = { marker: listMarker(lvl, value), level: levelIndex };
        listLeftPx = lvl.left;
        listHangingPx = lvl.hanging;
      }
    }
    return {
      kind: "paragraph",
      id,
      bookmarks,
      headingLevel,
      style,
      align,
      indentLeftPx: twipsPx(val(pPrEffective, "left"), listLeftPx),
      indentFirstPx: pPrEffective
        ? twipsPx(val(pPrEffective, "firstLine")) -
          twipsPx(val(pPrEffective, "hanging"))
        : -listHangingPx,
      indentRightPx: twipsPx(val(pPrEffective, "right")),
      beforePx: twipsPx(val(spacing, "before")),
      afterPx: twipsPx(val(spacing, "after"), cell ? 2 : 8),
      lineHeight: Number(val(spacing, "line")) / 240 || null,
      runs: merged,
      list,
    };
  };
  const parseTable = async (
    table: Element,
    depth: number,
  ): Promise<WordTable> => {
    const rows: WordTableRow[] = [];
    const trPrs = children(table, "tr");
    let headerRows = 0;
    const shownRows = Math.min(trPrs.length, MAX_TABLE_ROWS);
    for (const [rowIndex, tr] of trPrs.slice(0, shownRows).entries()) {
      if (rowIndex > 0 && rowIndex % 50 === 0) await yieldToEventLoop();
      const trPr = child(tr, "trPr");
      const isHeader = children(trPr, "tblHeader").some((el) => on(el, "val"));
      if (rows.length === headerRows && isHeader) headerRows += 1;
      const cells: WordTableCell[] = [];
      // Grid column where the next cell starts, counting skipped continuation
      // cells too, so a vertical merge follows its own column.
      let column = gridBefore(tr);
      for (const tc of children(tr, "tc").slice(0, MAX_TABLE_COLS)) {
        if (tableCells >= MAX_TABLE_CELLS) break;
        const tcPr = child(tc, "tcPr");
        const span = gridSpan(tc);
        const startColumn = column;
        column += span;
        const vMerge = child(tcPr, "vMerge");
        let rowSpan = 1;
        if (vMerge && val(vMerge, "val") !== "restart") continue;
        if (vMerge) {
          for (let next = rowIndex + 1; next < shownRows; next += 1) {
            const same = cellAtGridColumn(trPrs[next]!, startColumn);
            const merge = child(child(same, "tcPr"), "vMerge");
            if (!merge || val(merge, "val") === "restart") break;
            rowSpan += 1;
          }
        }
        const blocks: WordBlock[] = [];
        for (const block of Array.from(tc.children)) {
          if (block.localName === "p") blocks.push(parseParagraph(block, true));
          else if (block.localName === "tbl" && depth < MAX_NESTING)
            blocks.push(await parseTable(block, depth + 1));
        }
        // A nested table's drawings belong to its own cells.
        for (const drawing of elementsNS(tc, "drawing"))
          if (nearestAncestor(drawing, "tc") === tc)
            blocks.push(parseImage(drawing));
        cells.push({
          blocks,
          colSpan: span,
          rowSpan,
          fill: safeColor(val(child(tcPr, "shd"), "fill")),
          borders: cellBorders(tc),
        });
        tableCells += 1;
        if (textChars > MAX_TEXT_CHARS) break;
      }
      rows.push({ cells });
      if (textChars > MAX_TEXT_CHARS || tableCells >= MAX_TABLE_CELLS) break;
    }
    if (
      trPrs.length > MAX_TABLE_ROWS ||
      trPrs.some((tr) => children(tr, "tc").length > MAX_TABLE_COLS) ||
      tableCells >= MAX_TABLE_CELLS
    )
      notices.trimmedTables += 1;
    return { kind: "table", rows, headerRows };
  };
  const parseImage = (drawing: Element): WordImage => {
    const blip = firstElementNS(drawing, "blip");
    const relId = relationshipId(blip, "embed");
    const rel = relId ? rels.get(relId) : null;
    const path =
      rel && !rel.external && rel.type.includes("/image") ? rel.target : null;
    const extent = firstElementNS(drawing, "extent");
    const cx = Number(extent?.getAttribute("cx"));
    const cy = Number(extent?.getAttribute("cy"));
    const descr =
      firstElementNS(drawing, "docPr")?.getAttribute("descr") ??
      firstElementNS(drawing, "docPr")?.getAttribute("name") ??
      "Document image";
    const shownPath = path && imageMimeType(path) ? path : null;
    if (!shownPath) notices.unsupportedImages += 1;
    return {
      kind: "image",
      path: shownPath,
      widthPx: Number.isFinite(cx)
        ? Math.max(0, Math.min(1600, (cx / EMU_PER_INCH) * 96))
        : 0,
      heightPx: Number.isFinite(cy)
        ? Math.max(0, Math.min(1600, (cy / EMU_PER_INCH) * 96))
        : 0,
      alt: descr.slice(0, 300),
    };
  };
  for (const item of Array.from(body.children)) {
    if (blocks.length >= WORD_PREVIEW_MAX_BLOCKS) {
      truncated = true;
      break;
    }
    if (item.localName === "p") {
      const pPr = child(item, "pPr");
      if (on(child(pPr, "pageBreakBefore"), "val")) push({ kind: "pageBreak" });
      const p = parseParagraph(item, false);
      push(p);
      const headingText = paragraphText(p).trim();
      if (p.id && p.headingLevel && headingText && headings.length < 500)
        headings.push({
          id: p.id,
          text: headingText.slice(0, 200),
          level: p.headingLevel,
          blockIndex: blocks.length - 1,
        });
      for (const drawing of elementsNS(item, "drawing"))
        push(parseImage(drawing));
      if (
        elementsNS(item, "br").some((br) => val(br, "type") === "page") ||
        p.runs.some((run) => run.text.includes("\u000c"))
      )
        push({ kind: "pageBreak" });
    } else if (item.localName === "tbl") push(await parseTable(item, 0));
    if (textChars > MAX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    if (++sinceYield >= BLOCKS_PER_YIELD) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  const plain = blocks.map(blockText).join(" ");
  const wordCount = (plain.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .length;
  return {
    blocks,
    headings,
    pageWidthPx,
    pageHeightPx,
    marginsPx,
    truncated,
    wordCount,
    notices,
    async loadMedia(path: string) {
      const mimeType = imageMimeType(path);
      if (!mimeType) return null;
      const data = await zip.readBytes(path, ZIP_MAX_MEDIA_BYTES);
      return data ? { bytes: data, mimeType } : null;
    },
  };
}
