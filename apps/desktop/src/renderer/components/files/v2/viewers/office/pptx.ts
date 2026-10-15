// Read a `.pptx` deck into a small, bounded display model.
//
// A faithful slide renderer is a project of its own (layout inheritance,
// themes, SmartArt, embedded fonts, effects). This is a *preview*: text, the
// pictures, the tables, and their real positions — enough to know what is in
// the deck — and an honest count of what it chose not to draw. Three rules
// keep it useful and bounded:
//
//   1. **Placeholders resolve through the slide layout.** PowerPoint stores a
//      placeholder's position on the layout, not on the slide, so shapes
//      without their own `a:xfrm` look up their layout geometry by
//      type+index. Shapes that resolve nowhere are stacked rather than piled
//      at (0, 0) — the reference implementation's overlapping-title bug.
//   2. **Media loads per slide, on demand.** Slide XMLs are parsed up front
//      (they are small); pictures are read from the archive only while their
//      slide is on screen, and the viewer owns their object URLs.
//   3. **Nothing is silently dropped.** Charts, embedded media, grouped
//      shapes and pictures that could not be decoded are counted and surfaced
//      under the slide, so a missing table never reads as "this slide is
//      empty".
//
// Legacy binary `.ppt` (an OLE compound file) and `.pptx` are different
// formats; `.ppt` never reaches this parser — the viewer registry keeps it on
// the open-externally card.

import { OoxmlError } from "./ooxmlError";
import { attributeAnyNS, elementsNS, firstElementNS, parseXml, relationshipId, yieldToEventLoop } from "./ooxmlXml";
import { openOoxmlZip, ZIP_MAX_MEDIA_BYTES } from "./ooxmlZip";

/** Slides parsed per deck. Past this the deck lists what it read. */
export const PRESENTATION_PREVIEW_MAX_SLIDES = 300;
/** Shapes drawn per slide, bounding pathological decks. */
const MAX_SHAPES_PER_SLIDE = 120;

export type PptxBox = {
  /** Fractions of the slide, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PptxRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Point size as authored, or null to let the viewer pick by role. */
  sizePt: number | null;
  /** `#rrggbb`, or null for the viewer's ink default. */
  color: string | null;
};

export type PptxParagraph = {
  runs: PptxRun[];
  align: "left" | "center" | "right" | "justify";
  /** 0 for the first level. */
  level: number;
  /** Null means "whatever the shape's role implies". */
  bullet: boolean | null;
};

export type PptxTextShape = {
  kind: "text";
  box: PptxBox | null;
  anchor: "top" | "middle" | "bottom";
  isTitle: boolean;
  paragraphs: PptxParagraph[];
};

export type PptxTableShape = {
  kind: "table";
  box: PptxBox | null;
  rows: string[][];
  headerRow: boolean;
};

export type PptxImageShape = {
  kind: "image";
  box: PptxBox | null;
  /** Package path of the media part, or null when the picture is unsupported. */
  mediaPath: string | null;
};

export type PptxShape = PptxTextShape | PptxTableShape | PptxImageShape;

export type PptxSlideNotices = {
  /** Charts (any kind) — not drawn. */
  charts: number;
  /** Embedded audio/video — not played. */
  media: number;
  /** Grouped shapes — not recursed into. */
  groups: number;
  /** Pictures whose media is missing or in a format a browser cannot draw. */
  pictures: number;
};

export type PptxSlide = {
  /** 1-based position in the deck. */
  index: number;
  title: string;
  /** Every text line on the slide, in shape order: the outline view. */
  outline: string[];
  shapes: PptxShape[];
  notices: PptxSlideNotices;
};

export type PptxMedia = { bytes: Uint8Array<ArrayBuffer>; mimeType: string };

export type PptxDeck = {
  slideWidthEmu: number;
  slideHeightEmu: number;
  slides: PptxSlide[];
  /** True when the deck has more slides than the preview parsed. */
  truncated: boolean;
  /** Read one media part for a slide picture; null when absent or too large. */
  loadMedia(path: string): Promise<PptxMedia | null>;
};

const DEFAULT_THEME_COLORS: Record<string, string> = {
  dk1: "000000", lt1: "ffffff",
  dk2: "44546a", lt2: "e7e6e6",
  accent1: "4472c4", accent2: "ed7d31", accent3: "a5a5a5",
  accent4: "ffc000", accent5: "5b9bd5", accent6: "70ad47",
  hlink: "0563c1", folHlink: "954f72",
};

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/* ── Part paths and relationships ──────────────────────────────────────── */

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

type Relationship = { target: string; type: string };

function parseRelationships(relsXml: string | null, baseDir: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (!relsXml) return rels;
  const doc = parseXml(relsXml);
  if (!doc) return rels;
  for (const rel of elementsNS(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    // External relationships (a linked video on a share) name no package part.
    if ((rel.getAttribute("TargetMode") ?? "").toLowerCase() === "external") continue;
    rels.set(id, { target: resolvePartPath(baseDir, target), type: rel.getAttribute("Type") ?? "" });
  }
  return rels;
}

/* ── Geometry ──────────────────────────────────────────────────────────── */

function num(element: Element | null, attribute: string): number | null {
  if (!element) return null;
  const value = Number(element.getAttribute(attribute));
  return Number.isFinite(value) ? value : null;
}

function boxFromXfrm(xfrm: Element | null, slideWidthEmu: number, slideHeightEmu: number): PptxBox | null {
  const off = xfrm ? firstElementNS(xfrm, "off") : null;
  const ext = xfrm ? firstElementNS(xfrm, "ext") : null;
  const x = num(off, "x");
  const y = num(off, "y");
  const cx = num(ext, "cx");
  const cy = num(ext, "cy");
  if (x == null || y == null || cx == null || cy == null) return null;
  if (cx <= 0 || cy <= 0) return null;
  return {
    x: x / slideWidthEmu,
    y: y / slideHeightEmu,
    w: cx / slideWidthEmu,
    h: cy / slideHeightEmu,
  };
}

/* ── Theme colours ─────────────────────────────────────────────────────── */

function parseThemeColors(zipDoc: Document | null): Record<string, string> {
  const colors: Record<string, string> = { ...DEFAULT_THEME_COLORS };
  if (!zipDoc) return colors;
  const scheme = firstElementNS(zipDoc, "clrScheme");
  if (!scheme) return colors;
  for (const entry of Array.from(scheme.children)) {
    const name = entry.localName;
    if (!name) continue;
    const srgb = firstElementNS(entry, "srgbClr");
    const sys = firstElementNS(entry, "sysClr");
    const value = srgb?.getAttribute("val") ?? sys?.getAttribute("lastClr") ?? null;
    if (value && /^[0-9a-fA-F]{6}$/.test(value)) colors[name] = value.toLowerCase();
  }
  // PowerPoint's own aliases.
  colors.tx1 = colors.dk1 ?? colors.tx1!;
  colors.bg1 = colors.lt1 ?? colors.bg1!;
  colors.tx2 = colors.dk2 ?? colors.tx2!;
  colors.bg2 = colors.lt2 ?? colors.bg2!;
  return colors;
}

function runColor(rPr: Element | null, theme: Record<string, string>): string | null {
  if (!rPr) return null;
  const fill = firstElementNS(rPr, "solidFill");
  if (!fill) return null;
  const srgb = firstElementNS(fill, "srgbClr");
  const srgbValue = srgb?.getAttribute("val");
  if (srgbValue && /^[0-9a-fA-F]{6}$/.test(srgbValue)) return `#${srgbValue.toLowerCase()}`;
  const scheme = firstElementNS(fill, "schemeClr");
  const schemeValue = scheme?.getAttribute("val") ?? null;
  if (schemeValue) {
    const mapped = theme[schemeValue];
    if (mapped) return `#${mapped}`;
  }
  const sys = firstElementNS(fill, "sysClr");
  const sysValue = sys?.getAttribute("lastClr") ?? null;
  if (sysValue && /^[0-9a-fA-F]{6}$/.test(sysValue)) return `#${sysValue.toLowerCase()}`;
  return null;
}

/* ── Text ──────────────────────────────────────────────────────────────── */

function paragraphsFromTextBody(textBody: Element | null, theme: Record<string, string>, isTitle: boolean, isPlaceholder: boolean): PptxParagraph[] {
  if (!textBody) return [];
  const paragraphs: PptxParagraph[] = [];
  for (const paragraph of elementsNS(textBody, "p")) {
    const pPr = firstElementNS(paragraph, "pPr");
    const runs: PptxRun[] = [];
    for (const run of Array.from(paragraph.children)) {
      if (run.localName === "r" || run.localName === "fld") {
        const text = firstElementNS(run, "t")?.textContent ?? "";
        if (!text) continue;
        const rPr = firstElementNS(run, "rPr");
        const sz = num(rPr, "sz");
        runs.push({
          text,
          bold: attributeAnyNS(rPr, "b") === "1",
          italic: attributeAnyNS(rPr, "i") === "1",
          underline: (attributeAnyNS(rPr, "u") ?? "none") !== "none",
          sizePt: sz != null ? sz / 100 : null,
          color: runColor(rPr, theme),
        });
      } else if (run.localName === "br") {
        // A soft line break inside the paragraph.
        runs.push({ text: "\n", bold: false, italic: false, underline: false, sizePt: null, color: null });
      }
    }
    if (runs.length === 0) continue;
    const alignAttr = pPr?.getAttribute("algn") ?? null;
    const align = alignAttr === "ctr" ? "center" as const
      : alignAttr === "r" ? "right" as const
      : alignAttr === "just" ? "justify" as const
      : "left" as const;
    const level = num(pPr, "lvl") ?? 0;
    let bullet: boolean | null = null;
    if (pPr) {
      if (firstElementNS(pPr, "buNone")) bullet = false;
      else if (firstElementNS(pPr, "buChar") || firstElementNS(pPr, "buAutoNum")) bullet = true;
    }
    // A body placeholder inherits its bullet from the layout/master, which is
    // not read here; PowerPoint's own default fills the gap.
    if (bullet === null && !isTitle) bullet = isPlaceholder;
    paragraphs.push({ runs, align, level: Math.max(0, Math.min(8, level)), bullet });
  }
  return paragraphs;
}

function paragraphText(paragraph: PptxParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}

/* ── Layout placeholders ───────────────────────────────────────────────── */

type LayoutPlaceholderIndex = Map<string, PptxBox>;

function placeholderKey(type: string | null, idx: string | null): string[] {
  const normalizedType = (type ?? "body").trim();
  const keys = [`${normalizedType}:${idx ?? ""}`, `${normalizedType}:`, "body:"];
  return keys;
}

function parseLayoutPlaceholders(layoutXml: string, slideWidthEmu: number, slideHeightEmu: number): LayoutPlaceholderIndex {
  const index: LayoutPlaceholderIndex = new Map();
  const doc = parseXml(layoutXml);
  if (!doc) return index;
  for (const shape of elementsNS(doc, "sp")) {
    const ph = firstElementNS(shape, "ph");
    if (!ph) continue;
    const box = boxFromXfrm(firstElementNS(shape, "xfrm"), slideWidthEmu, slideHeightEmu);
    if (!box) continue;
    const keys = placeholderKey(ph.getAttribute("type"), ph.getAttribute("idx"));
    for (const key of keys) {
      if (!index.has(key)) index.set(key, box);
    }
  }
  return index;
}

/* ── Slide parsing ─────────────────────────────────────────────────────── */

type SlideParseContext = {
  slideWidthEmu: number;
  slideHeightEmu: number;
  theme: Record<string, string>;
  slideRels: Map<string, Relationship>;
  layoutPlaceholders: LayoutPlaceholderIndex;
};

function parseTextShape(shape: Element, ctx: SlideParseContext): PptxTextShape | null {
  const ph = firstElementNS(shape, "ph");
  const phType = ph?.getAttribute("type") ?? null;
  const isTitle = phType === "title" || phType === "ctrTitle";
  const isPlaceholder = ph !== null;
  const textBody = firstElementNS(shape, "txBody");
  const paragraphs = paragraphsFromTextBody(textBody, ctx.theme, isTitle, isPlaceholder);
  if (paragraphs.length === 0) return null;
  const xfrm = firstElementNS(shape, "xfrm");
  let box = boxFromXfrm(xfrm, ctx.slideWidthEmu, ctx.slideHeightEmu);
  if (!box && ph) {
    for (const key of placeholderKey(phType, ph.getAttribute("idx"))) {
      const fromLayout = ctx.layoutPlaceholders.get(key);
      if (fromLayout) {
        box = fromLayout;
        break;
      }
    }
  }
  const bodyPr = textBody ? firstElementNS(textBody, "bodyPr") : null;
  const anchorAttr = bodyPr?.getAttribute("anchor") ?? null;
  return {
    kind: "text",
    box,
    anchor: anchorAttr === "ctr" ? "middle" : anchorAttr === "b" ? "bottom" : "top",
    isTitle,
    paragraphs,
  };
}

function parseTableShape(shape: Element, ctx: SlideParseContext): PptxTableShape | null {
  const table = firstElementNS(shape, "tbl");
  if (!table) return null;
  const rows: string[][] = [];
  for (const row of elementsNS(table, "tr")) {
    const cells: string[] = [];
    for (const cell of elementsNS(row, "tc")) {
      const texts: string[] = [];
      for (const paragraph of elementsNS(cell, "p")) {
        const runs: string[] = [];
        for (const run of elementsNS(paragraph, "t")) {
          if (run.textContent) runs.push(run.textContent);
        }
        if (runs.length) texts.push(runs.join(""));
      }
      cells.push(texts.join(" "));
    }
    rows.push(cells);
  }
  if (rows.length === 0) return null;
  const tblPr = firstElementNS(table, "tblPr");
  const firstRowAttr = tblPr?.getAttribute("firstRow");
  return {
    kind: "table",
    box: boxFromXfrm(firstElementNS(shape, "xfrm"), ctx.slideWidthEmu, ctx.slideHeightEmu),
    rows,
    headerRow: firstRowAttr !== "0",
  };
}

function parsePictureShape(shape: Element, ctx: SlideParseContext): PptxImageShape {
  const blip = firstElementNS(shape, "blip");
  const relId = relationshipId(blip, "embed") ?? relationshipId(blip, "link");
  const rel = relId ? ctx.slideRels.get(relId) ?? null : null;
  // Only formats a browser can draw reach the image element; an EMF or WMF
  // picture keeps its box empty and is counted as not shown.
  const mediaPath = rel && rel.type.includes("/image") && mediaMimeType(rel.target) ? rel.target : null;
  return {
    kind: "image",
    box: boxFromXfrm(firstElementNS(shape, "xfrm"), ctx.slideWidthEmu, ctx.slideHeightEmu),
    mediaPath,
  };
}

/**
 * One level of a shape tree. `AlternateContent` recursion reuses this on its
 * fallback element (which holds shape children directly, with no `spTree`).
 */
function parseShapeChildren(container: Element, ctx: SlideParseContext, notices: PptxSlideNotices): PptxShape[] {
  const shapes: PptxShape[] = [];
  for (const child of Array.from(container.children)) {
    if (shapes.length >= MAX_SHAPES_PER_SLIDE) break;
    switch (child.localName) {
      case "sp": {
        const text = parseTextShape(child, ctx);
        if (text) shapes.push(text);
        break;
      }
      case "pic":
        shapes.push(parsePictureShape(child, ctx));
        break;
      case "graphicFrame": {
        const table = parseTableShape(child, ctx);
        if (table) {
          shapes.push(table);
          break;
        }
        const graphicData = firstElementNS(child, "graphicData");
        const uri = graphicData?.getAttribute("uri") ?? "";
        if (uri.includes("/chart") || firstElementNS(child, "chart")) notices.charts += 1;
        else notices.media += 1;
        break;
      }
      case "grpSp":
        notices.groups += 1;
        break;
      case "AlternateContent": {
        // Office wraps newer constructs in a choice/fallback pair; the
        // fallback (when it carries shapes) is what older viewers draw.
        const fallback = firstElementNS(child, "Fallback");
        if (fallback) {
          for (const shape of parseShapeChildren(fallback, ctx, notices)) {
            if (shapes.length >= MAX_SHAPES_PER_SLIDE) break;
            shapes.push(shape);
          }
        } else {
          notices.media += 1;
        }
        break;
      }
      case "cxnSp":
        // Connectors are lines between shapes; nothing to preview.
        break;
      default:
        break;
    }
  }
  return shapes;
}

function parseSlideShapes(root: Document | Element, ctx: SlideParseContext, notices: PptxSlideNotices): PptxShape[] {
  const spTree = firstElementNS(root, "spTree");
  if (!spTree) return [];
  return parseShapeChildren(spTree, ctx, notices);
}

function mediaMimeType(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MEDIA_MIME_BY_EXTENSION[ext] ?? null;
}

/* ── Deck ──────────────────────────────────────────────────────────────── */

export async function openPptx(bytes: Uint8Array): Promise<PptxDeck> {
  const zip = await openOoxmlZip(bytes);

  const presentationXml = await zip.readText("ppt/presentation.xml");
  if (!presentationXml) {
    throw new OoxmlError("invalid", "This package has no ppt/presentation.xml — it is not a .pptx deck.");
  }
  const presentationDoc = parseXml(presentationXml);
  if (!presentationDoc) throw new OoxmlError("invalid", "ppt/presentation.xml is not valid XML.");

  const sldSz = firstElementNS(presentationDoc, "sldSz");
  // Defaults are PowerPoint's modern 16:9 canvas (13.333in × 7.5in).
  const slideWidthEmu = num(sldSz, "cx") ?? 12_192_000;
  const slideHeightEmu = num(sldSz, "cy") ?? 6_858_000;

  const themeDoc = await (async () => {
    const themeXml = await zip.readText("ppt/theme/theme1.xml");
    return themeXml ? parseXml(themeXml) : null;
  })();
  const theme = parseThemeColors(themeDoc);

  const presentationRels = parseRelationships(
    await zip.readText("ppt/_rels/presentation.xml.rels"),
    "ppt",
  );

  // Slide order is the r:id order in `p:sldIdLst`, not the file numbering
  // (a reordered deck keeps `slide1.xml` where it was).
  const slidePaths: string[] = [];
  for (const sldId of elementsNS(presentationDoc, "sldId")) {
    const relId = relationshipId(sldId, "id");
    const rel = relId ? presentationRels.get(relId) ?? null : null;
    if (rel && (rel.type.includes("/slide") || rel.target.includes("/slides/"))) slidePaths.push(rel.target);
  }
  if (slidePaths.length === 0) {
    // Some producers write the list without relationships; fall back to the
    // parts themselves, numerically ordered.
    const fallback = Array.from(zip.entries.keys())
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
    slidePaths.push(...fallback);
  }
  if (slidePaths.length === 0) throw new OoxmlError("invalid", "This deck contains no slides.");

  const truncated = slidePaths.length > PRESENTATION_PREVIEW_MAX_SLIDES;
  const slidesToParse = slidePaths.slice(0, PRESENTATION_PREVIEW_MAX_SLIDES);
  const layoutCache = new Map<string, LayoutPlaceholderIndex>();
  const slides: PptxSlide[] = [];

  for (let position = 0; position < slidesToParse.length; position++) {
    const slidePath = slidesToParse[position]!;
    const slideXml = await zip.readText(slidePath);
    if (!slideXml) continue;
    const slideDoc = parseXml(slideXml);
    if (!slideDoc) continue;

    const slideDir = slidePath.slice(0, slidePath.lastIndexOf("/"));
    const slideFile = slidePath.slice(slidePath.lastIndexOf("/") + 1);
    const slideRels = parseRelationships(await zip.readText(`${slideDir}/_rels/${slideFile}.rels`), slideDir);

    let layoutPlaceholders: LayoutPlaceholderIndex = new Map();
    for (const rel of slideRels.values()) {
      if (!rel.type.includes("/slideLayout")) continue;
      const cached = layoutCache.get(rel.target);
      if (cached) {
        layoutPlaceholders = cached;
        break;
      }
      const layoutXml = await zip.readText(rel.target);
      if (!layoutXml) continue;
      const parsed = parseLayoutPlaceholders(layoutXml, slideWidthEmu, slideHeightEmu);
      layoutCache.set(rel.target, parsed);
      layoutPlaceholders = parsed;
      break;
    }

    const notices: PptxSlideNotices = { charts: 0, media: 0, groups: 0, pictures: 0 };
    const ctx: SlideParseContext = {
      slideWidthEmu,
      slideHeightEmu,
      theme,
      slideRels,
      layoutPlaceholders,
    };
    const shapes = parseSlideShapes(slideDoc, ctx, notices);
    for (const shape of shapes) {
      if (shape.kind === "image" && !shape.mediaPath) notices.pictures += 1;
    }

    const outline: string[] = [];
    let title = "";
    for (const shape of shapes) {
      if (shape.kind === "text") {
        for (const paragraph of shape.paragraphs) {
          const text = paragraphText(paragraph).trim();
          if (!text) continue;
          outline.push(text);
          if (!title && shape.isTitle) title = text;
        }
      } else if (shape.kind === "table") {
        // A table's cells are slide content; leaving them out of the outline
        // (and so out of the rail's summary) hid whole slides' worth of text.
        for (const row of shape.rows) {
          const line = row.filter(Boolean).join(" ").trim();
          if (line) outline.push(line);
        }
      }
    }
    if (!title) title = outline[0] ?? "";
    slides.push({
      index: position + 1,
      title: title.slice(0, 120),
      outline,
      shapes,
      notices,
    });

    if (position % 8 === 7) await yieldToEventLoop();
  }

  return {
    slideWidthEmu,
    slideHeightEmu,
    slides,
    truncated,
    async loadMedia(path: string): Promise<PptxMedia | null> {
      const mimeType = mediaMimeType(path);
      if (!mimeType) return null;
      const data = await zip.readBytes(path, ZIP_MAX_MEDIA_BYTES);
      if (!data) return null;
      return { bytes: data, mimeType };
    },
  };
}
