/**
 * Math in chat replies: which `$` mean math.
 *
 * Models write TeX four ways: `$x$`, `$$x$$`, `\(x\)` and `\[x\]`. The parser
 * (`remark-math`) runs with single-dollar math OFF, because prose is full of
 * dollars that are money ("between $5 and $10" would otherwise typeset
 * "5 and "). This pass rewrites the other three spellings into `$$`, which the
 * parser does take, so each one gets one decision made here:
 *
 * - `$x$` is math only by Pandoc's rule: the opening `$` has a non-space right
 *   after it, the closing `$` has a non-space right before it and no digit
 *   right after it, and they are on one line. Prices fail the closing test.
 * - `\(x\)` is always inline math, `\[x\]` always display math.
 * - A line that is nothing but `$$x$$` is display math, not an inline formula
 *   that happens to fill a paragraph.
 *
 * Code is never touched: fenced blocks and backtick spans pass through as
 * written, so a shell snippet's `$HOME` stays a shell variable. Indented code
 * blocks (four spaces or a tab) are not recognised: telling one from an
 * indented list paragraph needs the whole block structure, and math in list
 * paragraphs is the commoner case, so those lines are read as prose.
 */

import { fencedLineMask } from "../../../shared/chatScene";

/** Cheap gate: no `$` and no `\(`/`\[` means there is nothing to rewrite. */
const MAYBE_MATH = /\$|\\\(|\\\[/;

/** Rewrite every math spelling into `$$` form; see the module comment. */
export function normalizeMathDelimiters(markdown: string): string {
  if (!MAYBE_MATH.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  // Fences are read by the one shared scanner, so this pass and the renderer
  // never disagree about what is code.
  const fenced = fencedLineMask(markdown);
  const out: string[] = [];
  // Inside a display block (`$$` … `$$`, or `\[` … `\]`), lines are TeX.
  let mathBlock: "$$" | "\\]" | null = null;
  /** The open display block's opener: its line index (in `lines` and `out`, one entry per line) and text. */
  let opener: { index: number; line: string } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fenced[index]) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (mathBlock) {
      if (trimmed === mathBlock) {
        out.push(line.replace(trimmed, () => "$$"));
        mathBlock = null;
        opener = null;
      } else {
        out.push(line);
      }
      continue;
    }
    if (trimmed === "$$" || trimmed === "\\[") {
      mathBlock = trimmed === "$$" ? "$$" : "\\]";
      opener = { index, line };
      out.push(line.replace(trimmed, () => "$$"));
      continue;
    }
    out.push(rewriteLine(line));
  }
  // A display block that never closes (half-streamed, or a stray `$$`) would
  // swallow the rest of the message, prose and code included, into one
  // formula. Its opener stays literal text until the closer arrives.
  if (opener) {
    out[opener.index] = opener.line.replace(/\$\$|\\\[/, (found) => (found === "$$" ? "\\$\\$" : "\\\\["));
    // The lines after it are prose again, so their inline math still counts.
    for (let line = opener.index + 1; line < lines.length; line += 1) {
      if (!fenced[line]) out[line] = rewriteLine(lines[line]!);
    }
  }
  return out.join("\n");
}

function rewriteLine(line: string): string {
  const indent = line.match(/^\s*/)![0];
  const body = line.slice(indent.length);
  const trimmed = body.trimEnd();
  // One display formula as a whole line: `\[x\]` or `$$x$$`.
  const whole = trimmed.match(/^\\\[(.+)\\\]$/) ?? trimmed.match(/^\$\$(?!\$)(.+?)(?<!\$)\$\$$/);
  if (whole && whole[1]!.trim() && !whole[1]!.includes("$$")) {
    return `${indent}$$\n${indent}${whole[1]!.trim()}\n${indent}$$`;
  }
  if (!MAYBE_MATH.test(line)) return line;
  // Rewrite only the text between backtick code spans.
  let result = "";
  let index = 0;
  while (index < line.length) {
    const tick = line.indexOf("`", index);
    if (tick === -1) {
      result += rewriteText(line.slice(index));
      break;
    }
    result += rewriteText(line.slice(index, tick));
    const run = line.slice(tick).match(/^`+/)![0];
    const close = line.indexOf(run, tick + run.length);
    if (close === -1) {
      // An unclosed run is literal backticks, not a code span.
      result += run;
      index = tick + run.length;
      continue;
    }
    result += line.slice(tick, close + run.length);
    index = close + run.length;
  }
  return result;
}

function isEscaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Rewrite `\(x\)`, `\[x\]` and Pandoc-valid `$x$` in a run of plain text. */
function rewriteText(text: string): string {
  if (!MAYBE_MATH.test(text)) return text;
  const withParens = text
    .replace(/\\\((.+?)\\\)/g, (_match, tex: string) => (tex.trim() ? `$$${tex}$$` : _match))
    .replace(/\\\[(.+?)\\\]/g, (_match, tex: string) => (tex.trim() ? `$$${tex}$$` : _match));
  if (!withParens.includes("$")) return withParens;
  let result = "";
  let i = 0;
  while (i < withParens.length) {
    const ch = withParens[i]!;
    if (ch !== "$" || isEscaped(withParens, i)) {
      result += ch;
      i += 1;
      continue;
    }
    // `$$` (already math, or a stray pair) is left for the parser as written.
    if (withParens[i + 1] === "$") {
      const run = withParens.slice(i).match(/^\$+/)![0];
      result += run;
      i += run.length;
      continue;
    }
    const close = findSingleDollarClose(withParens, i);
    if (close === -1) {
      result += ch;
      i += 1;
      continue;
    }
    result += `$$${withParens.slice(i + 1, close)}$$`;
    i = close + 1;
  }
  return result;
}

/** Where the `$` opened at `open` closes by Pandoc's rule, or -1. */
function findSingleDollarClose(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] !== "$" || isEscaped(text, i)) continue;
    // A `$$` inside is not this formula's end; give up on this opener.
    if (text[i + 1] === "$") return -1;
    const before = text[i - 1]!;
    const after = text[i + 1];
    if (/\s/.test(before) || (after !== undefined && /\d/.test(after))) return -1;
    return i;
  }
  return -1;
}
