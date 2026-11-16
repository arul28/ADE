import { parseAst, type Plugin } from "vite";
import { shiftMap, type RawMap } from "../../scripts/build/asciiBundleSource";

/*
 * Keeps the renderer's JavaScript chunks pure ASCII, as `asciiBundleSource`
 * does for main and the brain.
 *
 * Blink keeps each loaded module's source for the life of the page. A source
 * with even one character past ASCII is stored at two bytes per character, and
 * a few hundred dashes, arrows and middle dots in copy put most of the loaded
 * chunks there: at rest the renderer held 18 MB of sources that would be 9 MB
 * in one byte each.
 *
 * Each such character becomes a `\uXXXX` escape, which means the same
 * character in a string, a template literal, a regular expression (with or
 * without the `u` flag) and an identifier, and is inert in a comment. Where an
 * escape would not mean the same, the chunk is left as it is, and the build
 * says so: the raw text of a tagged template (`String.raw` reads the
 * backslash), a character right after a backslash, and a surrogate pair in an
 * identifier. Runs in `generateBundle`, after the minifier, which would print
 * the escapes back as characters.
 */

const NON_ASCII = /[^\x00-\x7f]/g;
const HAS_NON_ASCII = /[^\x00-\x7f]/;

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

/** Ranges where an escape would change the program: tagged template text, and identifiers (for surrogates). */
function sensitiveRanges(code: string): { tagged: Array<[number, number]>; identifiers: Array<[number, number]> } {
  const tagged: Array<[number, number]> = [];
  const identifiers: Array<[number, number]> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (typeof node.type === "string") {
      if (node.type === "TaggedTemplateExpression") {
        const quasi = node.quasi as AstNode | undefined;
        if (quasi && HAS_NON_ASCII.test(code.slice(quasi.start, quasi.end))) tagged.push([quasi.start, quasi.end]);
      } else if ((node.type === "Identifier" || node.type === "PrivateIdentifier") && HAS_NON_ASCII.test(String(node.name ?? ""))) {
        identifiers.push([node.start, node.end]);
      }
    }
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end" || key === "range" || key === "loc") continue;
      visit(node[key]);
    }
  };
  visit(parseAst(code));
  return { tagged, identifiers };
}

const inside = (ranges: Array<[number, number]>, offset: number): boolean =>
  ranges.some(([start, end]) => offset >= start && offset < end);

/** The escaped code and the escaped columns per line, or why the chunk must stay as it is. */
export function escapeChunkToAscii(code: string): { code: string; escapedColumnsByLine: Map<number, number[]> } | { skipped: string } | null {
  if (!HAS_NON_ASCII.test(code)) return null;
  let ranges: ReturnType<typeof sensitiveRanges>;
  try {
    ranges = sensitiveRanges(code);
  } catch (error) {
    return { skipped: `it did not parse (${error instanceof Error ? error.message : String(error)})` };
  }
  let skipped: string | null = null;
  const escapedColumnsByLine = new Map<number, number[]>();
  let line = 0;
  let lineStart = 0;
  let scanned = 0;
  const escaped = code.replace(NON_ASCII, (char, offset: number) => {
    if (skipped) return char;
    const unit = char.charCodeAt(0);
    if (code[offset - 1] === "\\") skipped = `U+${unit.toString(16)} at ${offset} follows a backslash`;
    else if (inside(ranges.tagged, offset)) skipped = `U+${unit.toString(16)} at ${offset} is in a tagged template's raw text`;
    else if (unit >= 0xd800 && unit <= 0xdfff && inside(ranges.identifiers, offset)) skipped = `a surrogate at ${offset} is in an identifier`;
    if (skipped) return char;
    for (; scanned < offset; scanned += 1) {
      if (code.charCodeAt(scanned) === 10) {
        line += 1;
        lineStart = scanned + 1;
      }
    }
    const columns = escapedColumnsByLine.get(line) ?? [];
    columns.push(offset - lineStart);
    escapedColumnsByLine.set(line, columns);
    return `\\u${unit.toString(16).padStart(4, "0")}`;
  });
  if (skipped) return { skipped };
  return { code: escaped, escapedColumnsByLine };
}

/*
 * Stylesheets too: Blink stores a sheet with one character past ASCII at two
 * bytes per character (SettingsPage's 176 KB sheet held 352 KB for three
 * characters). In CSS, `\<hex>` plus one space means the same character in a
 * string, an identifier and a URL, and is inert in a comment. The space is
 * part of the escape, so a space that followed the character stays. A character right
 * after a backslash is already escaped text; the sheet is then left as it is.
 * The build writes no CSS source maps, so no columns need to move.
 */
const NON_ASCII_CODE_POINT = /[^\x00-\x7f]/gu;

/** The escaped sheet, or why it must stay as it is. Null when it is already ASCII. */
export function escapeCssToAscii(css: string): { css: string } | { skipped: string } | null {
  if (!HAS_NON_ASCII.test(css)) return null;
  let skipped: string | null = null;
  const escaped = css.replace(NON_ASCII_CODE_POINT, (char, offset: number) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (css[offset - 1] === "\\") skipped ??= `U+${codePoint.toString(16)} at ${offset} follows a backslash`;
    return `\\${codePoint.toString(16)} `;
  });
  return skipped ? { skipped } : { css: escaped };
}

export function asciiChunksPlugin(): Plugin {
  return {
    name: "ade-ascii-chunks",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "asset" && output.fileName.endsWith(".css") && typeof output.source === "string") {
          const sheet = escapeCssToAscii(output.source);
          if (sheet && "skipped" in sheet) {
            this.warn(`${output.fileName} keeps non-ASCII text (two bytes per character in the page): ${sheet.skipped}`);
          } else if (sheet) {
            output.source = sheet.css;
          }
          continue;
        }
        if (output.type !== "chunk" || !/\.[cm]?js$/.test(output.fileName)) continue;
        const result = escapeChunkToAscii(output.code);
        if (!result) continue;
        if ("skipped" in result) {
          this.warn(`${output.fileName} keeps non-ASCII text (two bytes per character in the page): ${result.skipped}`);
          continue;
        }
        output.code = result.code;
        // A hidden source map (release builds) must follow the moved columns.
        const mapAsset = bundle[`${output.fileName}.map`];
        const original: RawMap | null = output.map?.mappings
          ? (output.map as unknown as RawMap)
          : mapAsset?.type === "asset" && typeof mapAsset.source === "string"
            ? (JSON.parse(mapAsset.source) as RawMap)
            : null;
        if (!original) continue;
        const shifted = shiftMap(original, result.escapedColumnsByLine);
        if (output.map) (output.map as unknown as RawMap).mappings = shifted.mappings;
        if (mapAsset?.type === "asset") mapAsset.source = JSON.stringify(shifted);
      }
    },
  };
}
