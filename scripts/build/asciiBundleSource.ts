/**
 * A tsup plugin that keeps a bundle's source text pure ASCII.
 *
 * Node and V8 keep a script's source for the life of the process. Pure ASCII
 * takes a one-byte fast path; one character past it, even a Latin-1 `§`, stores
 * the whole text at two bytes per character. A few hundred dashes and arrows
 * were enough: the 22M-character brain bundle held 44 MB for its source and
 * Electron main's 18.7M-character bundle 37 MB.
 *
 * `charset: "ascii"` makes esbuild escape such characters in strings, template
 * literals and identifiers. It leaves comments and regular-expression literals
 * alone, so those are escaped here: `\uXXXX` per UTF-16 unit means the same
 * character in a regex (with or without the `u` flag) and is inert in a
 * comment. A character right after a backslash would change meaning, so that
 * fails the build instead.
 */
type EsbuildOptionsLike = { charset?: string };

const NON_ASCII = /[^\x00-\x7f]/g;

export function asciiBundleSource() {
  return {
    name: "ascii-bundle-source",
    esbuildOptions(options: EsbuildOptionsLike) {
      options.charset = "ascii";
    },
    renderChunk(code: string, chunk: { path: string }) {
      if (!/\.[cm]?js$/.test(chunk.path)) return undefined;
      let changed = false;
      const escaped = code.replace(NON_ASCII, (char, offset: number) => {
        if (code[offset - 1] === "\\") {
          throw new Error(`${chunk.path}: escaped character U+${char.charCodeAt(0).toString(16)} at offset ${offset} cannot be rewritten safely`);
        }
        changed = true;
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      });
      return changed ? { code: escaped } : undefined;
    },
  };
}
