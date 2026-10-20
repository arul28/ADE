/**
 * A tsup plugin that keeps a bundle's source text pure ASCII.
 *
 * Node and V8 keep a script's source for the life of the process. Pure ASCII
 * takes a one-byte fast path; one character past it, even a Latin-1 section
 * sign, stores the whole text at two bytes per character. A few hundred
 * dashes and arrows were enough: the 22M-character brain bundle held 44 MB for
 * its source and Electron main's 18.7M-character bundle 37 MB.
 *
 * `charset: "ascii"` makes esbuild escape such characters in strings, template
 * literals and identifiers. It leaves comments and regular-expression literals
 * alone, so those are escaped here: `\uXXXX` per UTF-16 unit means the same
 * character in a regex (with or without the `u` flag) and is inert in a
 * comment. A character right after a backslash would change meaning, so that
 * fails the build instead.
 *
 * Each escape adds five columns, so the plugin returns a source map from the
 * escaped chunk back to esbuild's, with a segment at every position esbuild's
 * map has one; tsup composes the two.
 */
type EsbuildOptionsLike = { charset?: string };
type RawMap = { mappings: string };

const NON_ASCII = /[^\x00-\x7f]/g;
const ESCAPE_GROWTH = "\\u0000".length - 1;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((char, index) => [char, index]));

function encodeVlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** The generated column of each segment, line by line (the first field, relative within a line). */
function segmentColumns(mappings: string): number[][] {
  return mappings.split(";").map((line) => {
    const columns: number[] = [];
    let column = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      let shift = 0;
      let value = 0;
      for (const char of segment) {
        const digit = BASE64_VALUE.get(char) ?? 0;
        value += (digit & 31) << shift;
        if (!(digit & 32)) break;
        shift += 5;
      }
      column += value & 1 ? -(value >>> 1) : value >>> 1;
      columns.push(column);
    }
    return columns;
  });
}

/** Maps the escaped code back to the code esbuild produced, one segment per esbuild segment. */
function escapeMap(path: string, original: RawMap, escapedColumnsByLine: Map<number, number[]>) {
  let previousSourceLine = 0;
  let previousSourceColumn = 0;
  const lines = segmentColumns(original.mappings).map((columns, line) => {
    const escapedColumns = escapedColumnsByLine.get(line) ?? [];
    let previousColumn = 0;
    return columns.map((column) => {
      let growth = 0;
      for (const escaped of escapedColumns) if (escaped < column) growth += ESCAPE_GROWTH;
      const segment = encodeVlq(column + growth - previousColumn) + encodeVlq(0)
        + encodeVlq(line - previousSourceLine) + encodeVlq(column - previousSourceColumn);
      previousColumn = column + growth;
      previousSourceLine = line;
      previousSourceColumn = column;
      return segment;
    }).join(",");
  });
  return { version: 3, file: path, sources: [path], names: [], mappings: lines.join(";") };
}

export function asciiBundleSource() {
  return {
    name: "ascii-bundle-source",
    esbuildOptions(options: EsbuildOptionsLike) {
      options.charset = "ascii";
    },
    renderChunk(code: string, chunk: { path: string; map?: unknown }) {
      if (!/\.[cm]?js$/.test(chunk.path)) return undefined;
      const escapedColumnsByLine = new Map<number, number[]>();
      let line = 0;
      let lineStart = 0;
      let scanned = 0;
      const escaped = code.replace(NON_ASCII, (char, offset: number) => {
        if (code[offset - 1] === "\\") {
          throw new Error(`${chunk.path}: escaped character U+${char.charCodeAt(0).toString(16)} at offset ${offset} cannot be rewritten safely`);
        }
        for (; scanned < offset; scanned += 1) {
          if (code.charCodeAt(scanned) === 10) {
            line += 1;
            lineStart = scanned + 1;
          }
        }
        const columns = escapedColumnsByLine.get(line) ?? [];
        columns.push(offset - lineStart);
        escapedColumnsByLine.set(line, columns);
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      });
      if (!escapedColumnsByLine.size) return undefined;
      const original = typeof chunk.map === "string" ? JSON.parse(chunk.map) as RawMap : chunk.map as RawMap | null | undefined;
      return original?.mappings
        ? { code: escaped, map: escapeMap(chunk.path, original, escapedColumnsByLine) }
        : { code: escaped };
    },
  };
}
