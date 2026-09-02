/**
 * The markdown subset the `markdown` node renders — as DATA, not as HTML.
 *
 * A plugin that shows an issue body or a comment thread needs prose with
 * structure, and `text` cannot carry it: `text` is one string with one variant
 * and it renders literally on every client. This module is the smallest thing
 * that fixes that without handing a plugin a document format.
 *
 * ## Why an AST rather than sanitized markdown source
 *
 * The obvious shape was "strip the dangerous parts and hand the string to each
 * client's markdown renderer". Desktop ships `react-markdown` + `remark-gfm`,
 * iOS has `AttributedString(markdown:)`, and the TUI has neither — so that shape
 * defines the subset three times, in three grammars, and the subset is then
 * whatever those three happen to agree on. They do not agree: remark-gfm
 * autolinks bare URLs and draws tables, Apple's parser does neither, and a
 * terminal does not have the concept. One schema would have rendered a table on
 * desktop and a row of pipes on a phone.
 *
 * So the subset is defined HERE, once, as a bounded tree of blocks and inline
 * runs. Every TS client calls {@link parseVocabMarkdown} — literally the same
 * function — and iOS mirrors it in `PluginVocabularyMarkdown.swift`. What each
 * client then does with a `heading` or a `strong` run is its own business, which
 * is rule 3 of the vocabulary applied one level down: the shared code decides
 * WHAT is there, the client decides what it looks like.
 *
 * ## The security line: there is no HTML path
 *
 * This parser never produces markup. It produces text runs with boolean flags,
 * so `<script>alert(1)</script>` in a source document is a `text` run whose
 * content is that string — React escapes it, SwiftUI's `Text` escapes it, Ink
 * escapes it. There is no raw-HTML pass-through to disable, no sanitizer schema
 * to keep in step with a renderer, and no client that can opt out. That is
 * deliberately stronger than an allowlist: an allowlist is a list someone has to
 * maintain, and this is a shape that cannot express the attack.
 *
 * Links and markdown images are the two places a document reaches outside
 * itself, and both pass the same gate the `{openUrl}` action verb passes —
 * {@link httpsUrl}, `https:` only, with a host. A `javascript:` or `data:`
 * destination loses the link (or the picture) and keeps its text.
 *
 * ## What is NOT in the subset, and why
 *
 * - **Raw HTML.** See above.
 * - **Bare-URL autolinking.** Three clients, three URL-detection regexes, three
 *   answers about where `https://x.com/a.` ends. Write `[text](url)`.
 * - **Setext headings and indented code.** `===` under a line and a four-space
 *   indent are both things people produce by accident; `#` and a fence are not.
 * - **`data:` images.** Markdown images pass the same `https:` gate as links. A
 *   self-contained thumbnail still belongs on the `image` node, which is the
 *   one place a `data:` URI has a source ceiling.
 */

import { PLUGIN_URL_MAX_CHARS, httpsUrl } from "./parse";

/**
 * One run of inline text and how it is drawn.
 *
 * Flags rather than nesting: `**bold _and italic_**` is one run carrying both,
 * not a tree. A phone builds `AttributedString` runs, a terminal sets Ink's
 * `bold`/`italic` props and the desktop nests `<strong><em>` — all three read
 * the same flat list, and none of them has to walk a tree to find the text.
 */
export type VocabMarkdownSpan = {
  text: string;
  bold?: true;
  italic?: true;
  strike?: true;
  /** Inline code. Monospace, and never carries emphasis or a link. */
  code?: true;
  /** An `https:` destination, already normalized by {@link httpsUrl}. */
  href?: string;
  /**
   * An `https:` image source, already normalized by {@link httpsUrl}.
   *
   * `text` is the alt. A refused destination (anything but `https:` with a host)
   * never sets this — the alt stays as prose, the same way a refused link keeps
   * its words.
   */
  src?: string;
};

/** Column alignment of a GFM pipe table, one entry per kept column. */
export type VocabMarkdownTableAlign = "left" | "center" | "right";

/** One row of a `list` block. */
export type VocabMarkdownItem = {
  /**
   * Present only for a task-list row (`- [ ]` / `- [x]`).
   *
   * Rendered INERT on every client: a checkbox in a panel is a control the
   * plugin declared no action for, so a reader who ticked it would change
   * nothing and be told nothing. It is a picture of the source document's state.
   */
  task?: "checked" | "unchecked";
  blocks: VocabMarkdownBlock[];
};

export type VocabMarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; spans: VocabMarkdownSpan[] }
  | { kind: "paragraph"; spans: VocabMarkdownSpan[] }
  /** A fenced block. `language` is the info string's first word, lowercased. */
  | { kind: "code"; language?: string; text: string }
  | { kind: "quote"; blocks: VocabMarkdownBlock[] }
  | { kind: "list"; ordered: boolean; start: number; items: VocabMarkdownItem[] }
  | { kind: "rule" }
  | {
      kind: "table";
      align: VocabMarkdownTableAlign[];
      header: VocabMarkdownSpan[][];
      rows: VocabMarkdownSpan[][][];
    };

export type VocabMarkdownDocument = {
  blocks: VocabMarkdownBlock[];
  /**
   * True when a ceiling stopped the walk and blocks were dropped.
   *
   * The renderer says so rather than ending mid-document: a panel that silently
   * stops halfway reads as a plugin that stopped writing.
   */
  truncated: boolean;
};

/**
 * The bounds of a parsed document.
 *
 * Spread into `VOCAB_LIMITS` so a schema author reads one table, and declared
 * here so the parser and the ceilings it enforces live together.
 *
 * `maxMarkdownChars` is 16,000 — four Linear-sized issue bodies, a quarter of
 * the 65,536-byte panel budget. Matching `maxTextChars` (4,000) was the reason
 * an issue description dumped as plain source: the body was over the cap, the
 * cut landed inside a fence, and every client refused to format it. A `text`
 * node is still a paragraph and keeps 4,000; a `markdown` node is a document.
 *
 * A source over the cap is cut at the last complete line in the window (see
 * {@link clampVocabMarkdownSource}) and still parsed as markdown. The renderer
 * says the rest is not shown rather than dumping the source as monospace.
 *
 * `maxMarkdownBlocks` exists because the character cap alone does not bound the
 * render tree: 16,000 characters of `- a\n- b\n…` is still thousands of list
 * rows, which is thousands of views on a phone. `maxMarkdownDepth` bounds the
 * same thing downwards — past it a `>` or a `-` is literal text rather than
 * another container.
 *
 * `maxListItemMarkdownChars` is the per-row ceiling. A comment thread drawn as
 * list rows must not parse 16 KiB of markdown a hundred times on a phone; 4,000
 * is one comment, and it does not count against `maxNodes`.
 */
export const VOCAB_MARKDOWN_LIMITS = {
  maxMarkdownChars: 16_000,
  maxMarkdownBlocks: 100,
  /** Container nesting. A top-level block is depth 1. */
  maxMarkdownDepth: 3,
  /** Runs in one block, after which the rest of the block is one plain run. */
  maxMarkdownSpans: 200,
  /** A link or markdown-image destination. The same ceiling `{openUrl}` uses. */
  maxMarkdownHrefChars: PLUGIN_URL_MAX_CHARS,
  /** A fence's info string, read down to its first word. */
  maxMarkdownLanguageChars: 32,
  /** GFM pipe-table columns. Matches `maxTableColumns` on the `table` node. */
  maxMarkdownTableColumns: 8,
  /**
   * Body rows of one pipe table. Tighter than `maxTableRows` (100): 16,000
   * characters of `|a|` would otherwise explode into a grid a phone cannot
   * draw, and a comment table is not a data table.
   */
  maxMarkdownTableRows: 40,
  /** Source on one list row's `markdown` field. */
  maxListItemMarkdownChars: 4_000,
} as const;

/**
 * Cut a document to `maxChars` at the last complete line in the window.
 *
 * A hard slice lands wherever it lands — inside a fence, a link, a table row —
 * and the markdown of that string is not the document's markdown. Trimming to
 * the last newline in the second half of the window keeps every complete line
 * the cap could hold. No newline in that half means one run of prose, and the
 * hard slice is honest. Never an ellipsis: it would render as content.
 *
 * The host calls this before {@link parseVocabMarkdown}. The parser itself does
 * not clamp; it formats what it is given.
 */
export function clampVocabMarkdownSource(
  source: string,
  maxChars: number = VOCAB_MARKDOWN_LIMITS.maxMarkdownChars,
): { text: string; truncated: boolean } {
  if (source.length <= maxChars) return { text: source, truncated: false };
  const slice = source.slice(0, maxChars);
  const newline = slice.lastIndexOf("\n");
  const cut = newline >= Math.floor(maxChars / 2) ? newline : maxChars;
  return { text: slice.slice(0, cut), truncated: true };
}

/* ── Inline ─────────────────────────────────────────────────────────────── */

type SpanStyle = { bold?: true; italic?: true; strike?: true; href?: string; src?: string };

/**
 * Append a run, merging it into the previous one when nothing about it changed.
 *
 * Emphasis parsing naturally produces neighbours with identical flags — `a*b*c`
 * with the emphasis stripped would be three runs saying the same thing. Merging
 * here keeps the tree small enough that a phone draws a paragraph as one
 * `AttributedString` rather than as a stack of labels.
 */
function pushSpan(spans: VocabMarkdownSpan[], text: string, style: SpanStyle, code?: true): void {
  if (text.length === 0) return;
  const last = spans[spans.length - 1];
  if (
    last
    && last.bold === style.bold
    && last.italic === style.italic
    && last.strike === style.strike
    &&     last.href === style.href
    && last.src === style.src
    && last.code === code
  ) {
    last.text += text;
    return;
  }
  spans.push({
    text,
    ...(style.bold ? { bold: style.bold } : {}),
    ...(style.italic ? { italic: style.italic } : {}),
    ...(style.strike ? { strike: style.strike } : {}),
    ...(code ? { code } : {}),
    ...(style.href !== undefined ? { href: style.href } : {}),
    ...(style.src !== undefined ? { src: style.src } : {}),
  });
}

/** ASCII punctuation a backslash may escape, per CommonMark. */
const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|~<>\"'$%&,/:;=?@^");

/**
 * A closing delimiter run of exactly `marker`, ignoring escaped characters.
 * `-1` when the run never closes, which makes the opener literal text.
 *
 * A closer may not sit against whitespace on its inner side — the flanking half
 * of CommonMark's emphasis rule, kept because without it `2 * 3 and *4` reads
 * as emphasis around " 3 and ". The opener half is in {@link emphasisMarker}.
 */
function findCloser(source: string, from: number, marker: string): number {
  for (let index = from; index <= source.length - marker.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (!source.startsWith(marker, index)) continue;
    if (index > from && !/\s/.test(source[index - 1] ?? " ")) return index;
  }
  return -1;
}

/** A code span's closer: a backtick run of exactly `length`. */
function findCodeCloser(source: string, from: number, length: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] !== "`") continue;
    let end = index;
    while (end < source.length && source[end] === "`") end += 1;
    if (end - index === length) return index;
    index = end - 1;
  }
  return -1;
}

/**
 * Inline runs for one block's text.
 *
 * Ordered by precedence, and the order IS the subset: a code span swallows
 * everything inside it (so `` `**a**` `` is four literal characters, not bold),
 * a link's text is parsed for emphasis but never for another link, and anything
 * whose delimiter does not close is the literal characters the author typed.
 */
function parseInline(source: string, style: SpanStyle = {}, depth = 0): VocabMarkdownSpan[] {
  const spans: VocabMarkdownSpan[] = [];
  let plain = "";
  let index = 0;

  const flush = () => {
    pushSpan(spans, plain, style);
    plain = "";
  };

  while (index < source.length) {
    const char = source[index]!;

    // An escape is literal, and is what lets a document write `\*` or `\<`.
    if (char === "\\" && index + 1 < source.length && ESCAPABLE.has(source[index + 1]!)) {
      plain += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      let run = index;
      while (run < source.length && source[run] === "`") run += 1;
      const length = run - index;
      const close = findCodeCloser(source, run, length);
      if (close >= 0) {
        flush();
        // CommonMark's one-space strip, so `` ` `a` ` `` reads as `` `a` ``.
        let content = source.slice(run, close);
        if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ")) {
          content = content.slice(1, -1);
        }
        // A code run never carries emphasis or a link: it is a quotation of
        // characters, and styling it would be styling the quotation marks.
        pushSpan(spans, content, style.href !== undefined ? { href: style.href } : {}, true);
        index = close + length;
        continue;
      }
    }

    // `![alt](url)` — https images become a span with `src`; anything else
    // keeps the alt as prose, the same way a refused link keeps its words.
    if (char === "!" && source[index + 1] === "[") {
      const parsed = readLink(source, index + 1);
      if (parsed) {
        flush();
        const src = httpsUrl(parsed.url, VOCAB_MARKDOWN_LIMITS.maxMarkdownHrefChars);
        if (src !== null) {
          pushSpan(spans, parsed.text.length > 0 ? parsed.text : "image", { ...style, src });
        } else {
          for (const span of parseInline(parsed.text, style, depth + 1)) spans.push(span);
        }
        index = parsed.end;
        continue;
      }
    }

    // A link inside a link is not a thing, so `style.href` being set makes `[`
    // literal — the reader would have no way to tell which destination they were
    // pressing.
    if (char === "[" && style.href === undefined && depth < VOCAB_MARKDOWN_LIMITS.maxMarkdownDepth) {
      const parsed = readLink(source, index);
      if (parsed) {
        flush();
        const href = httpsUrl(parsed.url, VOCAB_MARKDOWN_LIMITS.maxMarkdownHrefChars);
        // A refused destination keeps the words and loses the link. Dropping the
        // text too would delete a sentence over a bad URL, and rendering the
        // link would be the whole point of the gate.
        const nested = parseInline(
          parsed.text,
          href === null ? style : { ...style, href },
          depth + 1,
        );
        for (const span of nested) spans.push(span);
        index = parsed.end;
        continue;
      }
    }

    // `<https://…>` — the one autolink form, because its bounds are written
    // down rather than guessed at by a regex.
    if (char === "<" && style.href === undefined) {
      const close = source.indexOf(">", index + 1);
      const inner = close > index ? source.slice(index + 1, close) : "";
      const href = inner.includes(" ") ? null : httpsUrl(inner, VOCAB_MARKDOWN_LIMITS.maxMarkdownHrefChars);
      if (href !== null) {
        flush();
        pushSpan(spans, inner, { ...style, href });
        index = close + 1;
        continue;
      }
    }

    if (depth < VOCAB_MARKDOWN_LIMITS.maxMarkdownDepth) {
      const marker = emphasisMarker(source, index, style);
      if (marker) {
        const close = findCloser(source, index + marker.token.length, marker.token);
        if (close > index + marker.token.length) {
          flush();
          const inner = source.slice(index + marker.token.length, close);
          const nested = parseInline(inner, { ...style, ...marker.style }, depth + 1);
          for (const span of nested) spans.push(span);
          index = close + marker.token.length;
          continue;
        }
      }
    }

    plain += char;
    index += 1;
  }

  flush();
  return capSpans(spans);
}

/** The emphasis delimiter starting at `index`, if one does and is not already in force. */
function emphasisMarker(
  source: string,
  index: number,
  style: SpanStyle,
): { token: string; style: SpanStyle } | null {
  /** An opener sits against the text it opens: `* 3` is arithmetic, `*3` is not. */
  const opens = (length: number) => {
    const next = source[index + length];
    return next !== undefined && !/\s/.test(next);
  };
  if (source.startsWith("~~", index)) {
    return style.strike || !opens(2) ? null : { token: "~~", style: { strike: true } };
  }
  if (source.startsWith("**", index) || source.startsWith("__", index)) {
    if (style.bold || !opens(2)) return null;
    return { token: source.slice(index, index + 2), style: { bold: true } };
  }
  const char = source[index];
  if ((char === "*" || char === "_") && !opens(1)) return null;
  if (char === "*" || char === "_") {
    // `snake_case_names` are not emphasis. A `_` between two word characters is
    // a word, which is the one intraword rule worth keeping: `*` stays greedy
    // because `a*b*c` in prose really is emphasis.
    if (char === "_" && /\w/.test(source[index - 1] ?? "") && /\w/.test(source[index + 1] ?? "")) {
      return null;
    }
    return style.italic ? null : { token: char, style: { italic: true } };
  }
  return null;
}

/** `[text](url)` starting at `[`. `null` when either half does not close. */
function readLink(source: string, start: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  let index = start;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || source[index + 1] !== "(") return null;
  // Balanced, not the first `)`. `[x](javascript:alert(1))` closes at the LAST
  // one, so the destination reaching {@link httpsUrl} is the whole thing rather
  // than a prefix — and the stray `)` does not leak into the prose as text.
  let close = index + 2;
  let open = 0;
  for (; close < source.length; close += 1) {
    const char = source[close];
    if (char === "\\") {
      close += 1;
      continue;
    }
    if (char === "(") open += 1;
    else if (char === ")") {
      if (open === 0) break;
      open -= 1;
    }
  }
  if (close >= source.length) return null;
  return {
    text: source.slice(start + 1, index),
    url: source.slice(index + 2, close).trim(),
    end: close + 1,
  };
}

/**
 * Fold everything past the span ceiling into one plain run.
 *
 * A pathological document — 4,000 alternating `*` — would otherwise produce a
 * run per character. The text survives; only the styling past the ceiling does
 * not, which is the right thing to lose.
 */
function capSpans(spans: VocabMarkdownSpan[]): VocabMarkdownSpan[] {
  const max = VOCAB_MARKDOWN_LIMITS.maxMarkdownSpans;
  if (spans.length <= max) return spans;
  const kept = spans.slice(0, max - 1);
  kept.push({ text: spans.slice(max - 1).map((span) => span.text).join("") });
  return kept;
}

/* ── Blocks ─────────────────────────────────────────────────────────────── */

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

type BlockWalk = { blocks: VocabMarkdownBlock[]; budget: number; truncated: boolean };

/**
 * Split a GFM table row into cells. `null` when the line has no pipe, so a
 * paragraph of prose cannot become a one-cell table by accident.
 *
 * Leading and trailing pipes are the delimiter, not cells. `\|` is a pipe
 * inside a cell. Column count is decided later against the delimiter row.
 */
function splitTableCells(line: string): string[] | null {
  const raw = line.trim();
  if (!raw.includes("|")) return null;
  const cells: string[] = [];
  let current = "";
  let index = raw.startsWith("|") ? 1 : 0;
  for (; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      current += raw[index + 1];
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (!(raw.endsWith("|") && current.length === 0 && !raw.endsWith("\\|"))) {
    cells.push(current.trim());
  }
  return cells.length > 0 ? cells : null;
}

function readTableAlign(cells: readonly string[]): VocabMarkdownTableAlign[] | null {
  if (cells.length === 0) return null;
  const align: VocabMarkdownTableAlign[] = [];
  for (const cell of cells) {
    const token = cell.replace(/\s/g, "");
    if (!/^:?-{3,}:?$/.test(token)) return null;
    const left = token.startsWith(":");
    const right = token.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : "left");
  }
  return align;
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = splitTableCells(lines[index] ?? "");
  const next = lines[index + 1];
  if (!header || next === undefined) return false;
  const delimiter = splitTableCells(next);
  return delimiter !== null && readTableAlign(delimiter) !== null;
}

function tableCellsToSpans(cells: readonly string[], columns: number): VocabMarkdownSpan[][] {
  const out: VocabMarkdownSpan[][] = [];
  for (let index = 0; index < columns; index += 1) {
    out.push(parseInline(cells[index] ?? ""));
  }
  return out;
}

function isTableRowInterrupt(line: string, nestable: boolean): boolean {
  return HEADING.test(line) || RULE.test(line) || FENCE.test(line)
    || (nestable && (QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line)));
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** A container's continuation lines: blank, or indented past its marker. */
function isContinuation(line: string, indent: number): boolean {
  return isBlank(line) || line.length - line.trimStart().length >= indent;
}

function parseBlocks(lines: string[], depth: number, walk: BlockWalk): VocabMarkdownBlock[] {
  const blocks: VocabMarkdownBlock[] = [];
  const nestable = depth < VOCAB_MARKDOWN_LIMITS.maxMarkdownDepth;
  let index = 0;

  const push = (block: VocabMarkdownBlock): boolean => {
    if (walk.budget <= 0) return false;
    walk.budget -= 1;
    blocks.push(block);
    return true;
  };

  while (index < lines.length) {
    if (walk.budget <= 0) return blocks;
    const line = lines[index]!;

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!.trim();
        // A closer is the same character, at least as long, and carries nothing
        // else — so a line of prose that happens to start with backticks does
        // not end the block.
        if (candidate.startsWith(marker[0]!) && candidate.length >= marker.length
          && candidate.split("").every((char) => char === marker[0])) {
          index += 1;
          break;
        }
        body.push(lines[index]!);
        index += 1;
      }
      const language = fence[2]
        ? fence[2].toLowerCase().slice(0, VOCAB_MARKDOWN_LIMITS.maxMarkdownLanguageChars)
        : "";
      // An unclosed fence still renders. The alternative — treating the rest of
      // the document as prose — turns one missing line into a page of source.
      if (!push({ kind: "code", text: body.join("\n"), ...(language ? { language } : {}) })) break;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      if (!push({ kind: "heading", level, spans: parseInline(heading[2]?.trim() ?? "") })) break;
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      if (!push({ kind: "rule" })) break;
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headerCells = splitTableCells(line) ?? [];
      const delimiterCells = splitTableCells(lines[index + 1] ?? "") ?? [];
      const alignAll = readTableAlign(delimiterCells) ?? [];
      const columns = Math.min(
        Math.max(1, alignAll.length),
        VOCAB_MARKDOWN_LIMITS.maxMarkdownTableColumns,
      );
      const align = alignAll.slice(0, columns);
      const header = tableCellsToSpans(headerCells, columns);
      const rows: VocabMarkdownSpan[][][] = [];
      index += 2;
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (isBlank(candidate) || splitTableCells(candidate) === null) break;
        if (isTableRowInterrupt(candidate, nestable)) break;
        if (rows.length >= VOCAB_MARKDOWN_LIMITS.maxMarkdownTableRows) {
          walk.truncated = true;
          index += 1;
          while (index < lines.length) {
            const extra = lines[index]!;
            if (isBlank(extra) || splitTableCells(extra) === null) break;
            if (isTableRowInterrupt(extra, nestable)) break;
            index += 1;
          }
          break;
        }
        rows.push(tableCellsToSpans(splitTableCells(candidate) ?? [], columns));
        index += 1;
      }
      if (!push({ kind: "table", align, header, rows })) break;
      continue;
    }

    if (nestable && QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index]!);
        if (quoted) body.push(quoted[1] ?? "");
        else if (!isBlank(lines[index]!) && body.length > 0) body.push(lines[index]!);
        else break;
        index += 1;
      }
      // The quote itself costs a block, then its content is parsed at depth + 1
      // against the same budget — so a deeply quoted document cannot buy more
      // nodes by nesting them.
      if (walk.budget <= 0) break;
      walk.budget -= 1;
      blocks.push({ kind: "quote", blocks: parseBlocks(body, depth + 1, walk) });
      continue;
    }

    const bullet = nestable ? BULLET.exec(line) : null;
    const ordered = nestable && !bullet ? ORDERED.exec(line) : null;
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const start = ordered ? Number.parseInt(ordered[2]!, 10) : 1;
      const items: VocabMarkdownItem[] = [];
      if (walk.budget <= 0) break;
      walk.budget -= 1;
      while (index < lines.length) {
        const match = isOrdered ? ORDERED.exec(lines[index]!) : BULLET.exec(lines[index]!);
        if (!match) break;
        const indent = match[1]!.length + 2;
        const first = match[3]!;
        const body: string[] = [];
        index += 1;
        while (index < lines.length && isContinuation(lines[index]!, indent)) {
          // A blank line ends the item unless indented content follows it, which
          // is how a two-paragraph list row is written.
          if (isBlank(lines[index]!)) {
            const next = lines[index + 1];
            if (next === undefined || !isContinuation(next, indent) || isBlank(next)) break;
          }
          body.push(lines[index]!.slice(Math.min(indent, lines[index]!.length - lines[index]!.trimStart().length)));
          index += 1;
        }
        const task = TASK.exec(first);
        const content = [task ? task[2]! : first, ...body];
        items.push({
          ...(task ? { task: task[1]!.toLowerCase() === "x" ? "checked" as const : "unchecked" as const } : {}),
          blocks: parseBlocks(content, depth + 1, walk),
        });
        if (walk.budget <= 0) break;
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index]!)) {
      const next = lines[index]!;
      // A paragraph ends where another block begins, so a list right under a
      // sentence is a list rather than three more words.
      if (paragraph.length > 0 && (
        HEADING.test(next) || RULE.test(next) || FENCE.test(next)
        || (nestable && (QUOTE.test(next) || BULLET.test(next) || ORDERED.test(next)))
        || isTableStart(lines, index)
      )) break;
      paragraph.push(next.trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      // Newlines survive inside a paragraph, the same promise `text` makes with
      // `pre-wrap`: a plugin that wrote two lines meant two lines.
      if (!push({ kind: "paragraph", spans: parseInline(paragraph.join("\n")) })) break;
    }
  }

  return blocks;
}

/**
 * Parse a markdown document into the subset above.
 *
 * Every TS client calls this one function, so the desktop, the web client and
 * the terminal cannot disagree about what a document contains — only about how
 * it looks. iOS mirrors it, arm for arm, in `PluginVocabularyMarkdown.swift`.
 *
 * Total work is bounded twice over: the caller has already clamped the source to
 * `maxMarkdownChars`, and the block budget stops the walk at
 * `maxMarkdownBlocks` however the characters are arranged.
 */
export function parseVocabMarkdown(source: string): VocabMarkdownDocument {
  const walk: BlockWalk = {
    blocks: [],
    budget: VOCAB_MARKDOWN_LIMITS.maxMarkdownBlocks,
    truncated: false,
  };
  // `\r\n` and a lone `\r` both mean one line break. A document written on
  // Windows must not render as one long line with visible control characters.
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  // A final newline TERMINATES the last line rather than starting an empty one.
  // Left in, it became a trailing blank line inside an unclosed code fence.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const blocks = parseBlocks(lines, 1, walk);
  return { blocks, truncated: walk.truncated || walk.budget <= 0 };
}

/**
 * A document's text with every mark dropped, for a surface that has no way to
 * draw one — a search index, a notification, an accessibility label.
 *
 * Not the TUI's degradation: the terminal draws the blocks, because a bullet
 * list flattened to a paragraph loses the thing that made it a list.
 */
export function vocabMarkdownPlainText(blocks: readonly VocabMarkdownBlock[]): string {
  const out: string[] = [];
  const walk = (list: readonly VocabMarkdownBlock[]) => {
    for (const block of list) {
      switch (block.kind) {
        case "heading":
        case "paragraph":
          out.push(block.spans.map((span) => span.text).join(""));
          break;
        case "code":
          out.push(block.text);
          break;
        case "quote":
          walk(block.blocks);
          break;
        case "list":
          for (const item of block.items) walk(item.blocks);
          break;
        case "table":
          out.push(block.header.map((cell) => cell.map((span) => span.text).join("")).join(" | "));
          for (const row of block.rows) {
            out.push(row.map((cell) => cell.map((span) => span.text).join("")).join(" | "));
          }
          break;
        case "rule":
          break;
        default: {
          const _exhaustive: never = block;
          void _exhaustive;
          break;
        }
      }
    }
  };
  walk(blocks);
  return out.join("\n");
}
