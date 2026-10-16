/**
 * JSON with comments, which is what a VS Code theme file usually is.
 *
 * The VS Code ecosystem writes `.json` files that hold line comments, block
 * comments, a byte-order mark, and trailing commas. `JSON.parse` refuses all
 * of them, so a theme that VS Code loads happily failed here with "not valid
 * JSON". This reads that dialect: it strips comments and trailing commas
 * outside of strings, then hands the result to `JSON.parse`, so a real syntax
 * error still throws.
 */

/** Remove comments and a leading byte-order mark. String contents are kept as they are. */
function stripComments(text: string): string {
  let out = "";
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
    } else if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      // A comment separates tokens the way whitespace does.
      out += " ";
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Remove a comma that is followed only by whitespace and a closing bracket. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        index += 1;
        if (index < text.length) out += text[index]!;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let probe = index + 1;
      while (probe < text.length && /\s/.test(text[probe]!)) probe += 1;
      if (text[probe] === "}" || text[probe] === "]") continue;
    }
    out += char;
  }
  return out;
}

/** Parse JSON that may carry comments and trailing commas. Throws `SyntaxError` on anything else. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}
