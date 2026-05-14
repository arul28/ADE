import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import swift from "highlight.js/lib/languages/swift";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);

export type HighlightCategory =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "tag"
  | "meta";

export type HighlightedToken = {
  text: string;
  category?: HighlightCategory;
  bold?: boolean;
  italic?: boolean;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  htm: "xml",
};

const CATEGORY_MAP: Record<string, HighlightCategory> = {
  "hljs-keyword": "keyword",
  "hljs-built_in": "keyword",
  "hljs-literal": "keyword",
  "hljs-string": "string",
  "hljs-regexp": "string",
  "hljs-template-string": "string",
  "hljs-template-variable": "string",
  "hljs-number": "number",
  "hljs-comment": "comment",
  "hljs-doctag": "comment",
  "hljs-quote": "comment",
  "hljs-function": "function",
  "hljs-title": "function",
  "hljs-title_function": "function",
  "hljs-title_function_": "function",
  "hljs-class": "type",
  "hljs-type": "type",
  "hljs-title_class": "type",
  "hljs-title_class_": "type",
  "hljs-variable": "variable",
  "hljs-attr": "variable",
  "hljs-property": "variable",
  "hljs-params": "variable",
  "hljs-attribute": "variable",
  "hljs-tag": "tag",
  "hljs-name": "tag",
  "hljs-symbol": "tag",
  "hljs-selector-tag": "tag",
  "hljs-selector-class": "tag",
  "hljs-selector-id": "tag",
  "hljs-meta": "meta",
  "hljs-link": "meta",
  "hljs-strong": "meta",
  "hljs-emphasis": "meta",
};

const MAX_ENTRIES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

type CacheValue = {
  tokens: HighlightedToken[][];
  bytes: number;
};

const cache = new Map<string, CacheValue>();
let totalBytes = 0;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function resolveLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return undefined;
  const alias = LANGUAGE_ALIASES[normalized] ?? normalized;
  if (hljs.getLanguage(alias)) return alias;
  return undefined;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#x27|#39|apos);/g, (_, entity) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "#x27":
      case "#39":
      case "apos":
        return "'";
      default: return _;
    }
  });
}

function categoryForClass(className: string): HighlightCategory | undefined {
  if (CATEGORY_MAP[className]) return CATEGORY_MAP[className];
  const dotted = className.replace(/_/g, ".");
  if (CATEGORY_MAP[dotted]) return CATEGORY_MAP[dotted];
  // hljs sometimes nests via `hljs-title hljs-function`; we map first known class.
  const parts = className.split(/\s+/);
  for (const part of parts) {
    if (CATEGORY_MAP[part]) return CATEGORY_MAP[part];
  }
  return undefined;
}

type Span = { className?: string; text: string };

function parseHljsHtml(html: string): Span[] {
  const spans: Span[] = [];
  const stack: Array<HighlightCategory | undefined> = [];
  let i = 0;
  let buffer = "";

  const flush = (): void => {
    if (!buffer.length) return;
    const top = stack[stack.length - 1];
    spans.push({ className: top ? `hljs-${top}` : undefined, text: decodeEntities(buffer) });
    buffer = "";
  };

  while (i < html.length) {
    const ch = html[i] ?? "";
    if (ch === "<") {
      // tag start
      const closeIdx = html.indexOf(">", i + 1);
      if (closeIdx === -1) {
        buffer += html.slice(i);
        i = html.length;
        break;
      }
      const tag = html.slice(i + 1, closeIdx);
      flush();
      if (tag.startsWith("/")) {
        stack.pop();
      } else {
        // <span class="hljs-XXX [hljs-YYY ...]">
        const classMatch = /class="([^"]+)"/.exec(tag);
        const className = classMatch?.[1];
        const category = className ? categoryForClass(className) : undefined;
        stack.push(category);
      }
      i = closeIdx + 1;
    } else {
      buffer += ch;
      i += 1;
    }
  }
  flush();
  return spans;
}

function splitSpansByLine(spans: Span[]): HighlightedToken[][] {
  const lines: HighlightedToken[][] = [[]];
  for (const span of spans) {
    const text = span.text;
    if (!text.length) continue;
    const parts = text.split("\n");
    for (let p = 0; p < parts.length; p += 1) {
      const piece = parts[p] ?? "";
      if (piece.length) {
        const last = lines[lines.length - 1]!;
        const category = span.className ? categoryForClass(span.className) : undefined;
        last.push(category ? { text: piece, category } : { text: piece });
      }
      if (p < parts.length - 1) lines.push([]);
    }
  }
  return lines;
}

function plainLines(code: string): HighlightedToken[][] {
  return code.split("\n").map((line) => (line.length ? [{ text: line }] : []));
}

function estimateBytes(tokens: HighlightedToken[][]): number {
  let bytes = 0;
  for (const line of tokens) {
    for (const token of line) {
      bytes += token.text.length * 2 + 16;
    }
    bytes += 16;
  }
  return bytes;
}

export function highlightCode(code: string, language: string | undefined): HighlightedToken[][] {
  const resolved = resolveLanguage(language);
  const key = `${fnv1a32(code).toString(36)}:${code.length}:${resolved ?? "_plain"}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit.tokens;
  }

  let tokens: HighlightedToken[][];
  if (!resolved) {
    tokens = plainLines(code);
  } else {
    try {
      const html = hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
      const spans = parseHljsHtml(html);
      tokens = splitSpansByLine(spans);
      // Guard against highlight.js producing a different line count.
      const expected = code.split("\n").length;
      if (tokens.length !== expected) {
        // Fall back to plain rather than risk misalignment.
        tokens = plainLines(code);
      }
    } catch {
      tokens = plainLines(code);
    }
  }

  const bytes = estimateBytes(tokens);
  cache.set(key, { tokens, bytes });
  totalBytes += bytes;

  while (cache.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) totalBytes -= evicted.bytes;
    if (cache.size === 0) {
      totalBytes = 0;
      break;
    }
  }

  return tokens;
}

export function __clearHighlightCacheForTests(): void {
  cache.clear();
  totalBytes = 0;
}

export function __getHighlightCacheStatsForTests(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: totalBytes };
}
