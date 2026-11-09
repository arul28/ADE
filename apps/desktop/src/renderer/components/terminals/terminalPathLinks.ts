import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { logRendererDebugEvent } from "../../lib/debugLog";
import {
  looksLikeWorkspacePath,
  parseWorkspacePathLocation,
  probeTerminalPath,
  type ChatWorkspacePathOpener,
  type WorkspacePathLocation,
} from "../chat/chatWorkspacePaths";

/**
 * File paths in terminal output, as links.
 *
 * `provideLinks` runs only for the row under the pointer, so nothing here costs
 * anything while a terminal floods. The scan is one forward pass over the row:
 * a pattern with nested repeats went quadratic on long runs of `]`.
 */

const MAX_LINE_CHARS = 4_000;
const MAX_TOKEN_CHARS = 1_024;
/** How far ahead a `[` or `(` looks for its partner. */
const GROUP_LOOKAHEAD = 128;
const MAX_WRAPPED_ROWS = 8;
const MAX_PROBED_TOKENS = 4;
const HOVER_PROBE_DELAY_MS = 80;
const PROBE_TTL_MS = 30_000;
const PROBE_CACHE_MAX = 200;

export type TerminalPathToken = {
  /** Offsets into the scanned text, end exclusive, including any `:line:col`. */
  start: number;
  end: number;
  location: WorkspacePathLocation;
};

function isPathChar(code: number): boolean {
  return (code >= 48 && code <= 57) // 0-9
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 97 && code <= 122) // a-z
    || code === 45 || code === 46 || code === 47 // - . /
    || code === 92 || code === 95 || code === 64 // \ _ @
    || code === 43 || code === 36 || code === 126 // + $ ~
    || code > 127;
}

/** End of a balanced `[…]` or `[[…]]` group starting at `open`, or -1. */
function closeBracketGroup(text: string, open: number, limit: number): number {
  let depth = 0;
  const stop = Math.min(limit, open + GROUP_LOOKAHEAD);
  for (let i = open; i < stop; i += 1) {
    const char = text[i];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (!isPathChar(text.charCodeAt(i))) return -1;
  }
  return -1;
}

/**
 * End of a `(…)` route segment at `open`, or -1. It must be followed by `/`, so
 * `src/foo.ts(3,10): error` still ends at the file.
 */
function closeRouteGroup(text: string, open: number, limit: number): number {
  const stop = Math.min(limit, open + GROUP_LOOKAHEAD);
  for (let i = open + 1; i < stop; i += 1) {
    if (text[i] === ")") return text[i + 1] === "/" ? i + 1 : -1;
    if (!isPathChar(text.charCodeAt(i))) return -1;
  }
  return -1;
}

const POSITION_COLON = /:(\d{1,7})(?::(\d{1,7}))?/y;
const POSITION_PAREN = /\((\d{1,7})(?:,\s?(\d{1,7}))?\)/y;

/** A `:12:5` or `(12,5)` right after a path; both are compiler and stack-trace forms. */
function readPosition(text: string, at: number): { end: number; suffix: string } | null {
  for (const pattern of [POSITION_COLON, POSITION_PAREN]) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (match) {
      return { end: pattern.lastIndex, suffix: `:${match[1]}${match[2] ? `:${match[2]}` : ""}` };
    }
  }
  return null;
}

function isRejectedToken(token: string): boolean {
  // Network paths never become links: resolving one can make Windows hand the
  // user's credentials to that server.
  // Either slash counts: Windows reads `/\host` as one too.
  if (/^[\\/]{2}/.test(token)) return true;
  if (/^[-@$+~]/.test(token)) return true;
  // Dates and fractions (`2026/11/09`, `1/2`), not files.
  return /^[\d/\\.]+$/.test(token);
}

/** Every path-shaped token in `text`, in order. Linear in the length of `text`. */
export function scanTerminalPathTokens(text: string): TerminalPathToken[] {
  const tokens: TerminalPathToken[] = [];
  let i = 0;
  const limit = Math.min(text.length, MAX_LINE_CHARS);
  while (i < limit) {
    if (!isPathChar(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    // `C:\x` and `C:/x`: the drive's colon is not a path character.
    if (/[A-Za-z]/.test(text[i]!) && text[i + 1] === ":" && (text[i + 2] === "\\" || text[i + 2] === "/")) {
      i += 3;
    }
    while (i < limit && i - start < MAX_TOKEN_CHARS) {
      const code = text.charCodeAt(i);
      if (isPathChar(code)) {
        i += 1;
        continue;
      }
      if (code === 91 /* [ */) {
        const end = closeBracketGroup(text, i, limit);
        if (end > 0) {
          i = end;
          continue;
        }
      } else if (code === 40 /* ( */) {
        const end = closeRouteGroup(text, i, limit);
        if (end > 0) {
          i = end;
          continue;
        }
      }
      break;
    }
    let tokenEnd = i;
    while (tokenEnd > start && text[tokenEnd - 1] === ".") tokenEnd -= 1;
    const raw = text.slice(start, tokenEnd);
    // The run ended at `:` and looks like a scheme (`https:`, `file:`).
    const isScheme = text[tokenEnd] === ":" && text[tokenEnd + 1] === "/" && text[tokenEnd + 2] === "/";
    if (raw.length > 0 && !isScheme && !isRejectedToken(raw)) {
      const position = tokenEnd === i ? readPosition(text, tokenEnd) : null;
      const candidate = `${raw}${position?.suffix ?? ""}`;
      if (looksLikeWorkspacePath(candidate)) {
        const location = parseWorkspacePathLocation(candidate);
        if (location) tokens.push({ start, end: position?.end ?? tokenEnd, location });
      }
    }
    // Always moves forward, whatever the token turned out to be.
    i = Math.max(i, start + 1);
  }
  return tokens;
}

type LogicalLine = {
  text: string;
  /** Where each terminal row starts in `text`, in order. */
  rows: { y: number; offset: number }[];
};

/** The row under the pointer plus the rows it wraps onto, as one string. */
function readLogicalLine(term: Terminal, lineIndex: number): LogicalLine | null {
  const buffer = term.buffer.active;
  let first = lineIndex;
  while (first > 0 && lineIndex - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1;
  const rows: LogicalLine["rows"] = [];
  let text = "";
  for (let y = first; y - first < MAX_WRAPPED_ROWS; y += 1) {
    const line = buffer.getLine(y);
    if (!line) break;
    const continues = Boolean(buffer.getLine(y + 1)?.isWrapped);
    rows.push({ y, offset: text.length });
    text += line.translateToString(!continues);
    if (!continues) break;
  }
  return rows.length ? { text, rows } : null;
}

/**
 * 1-based terminal cell for a text offset. A row's string and its columns part
 * at any wide character or combining mark, so this walks the row's cells, which
 * `translateToString` produced the string from. `lastColumn` is the cell's
 * right edge, for the end of a link on a double-width character.
 */
function cellForOffset(term: Terminal, line: LogicalLine, offset: number): { x: number; y: number; lastColumn: number } {
  let row = line.rows[0]!;
  for (const candidate of line.rows) {
    if (candidate.offset > offset) break;
    row = candidate;
  }
  const buffer = term.buffer.active;
  const cells = buffer.getLine(row.y);
  const reuse = buffer.getNullCell();
  let consumed = row.offset;
  for (let column = 0; cells && column < cells.length; column += 1) {
    const cell = cells.getCell(column, reuse);
    if (!cell || cell.getWidth() === 0) continue;
    const units = cell.getChars().length || 1;
    if (offset < consumed + units) {
      return { x: column + 1, y: row.y + 1, lastColumn: column + cell.getWidth() };
    }
    consumed += units;
  }
  const fallback = offset - row.offset + 1;
  return { x: fallback, y: row.y + 1, lastColumn: fallback };
}

export type TerminalPathLinkContext = {
  runtimePin: OpenProjectBinding | null;
  /** Set from the session on the first hover. */
  laneId: string | null;
  /** From OSC 7, when the shell reports it. */
  cwd: string | null;
  openWorkspacePath: ChatWorkspacePathOpener | null;
  ensureLaneId: (() => Promise<string | null>) | null;
};

type ProbeResult = { openable: boolean; path: string };

const probeCache = new Map<string, { result: ProbeResult; expiresAt: number }>();

async function probeWithCache(context: TerminalPathLinkContext, location: WorkspacePathLocation): Promise<ProbeResult> {
  const key = `${context.runtimePin?.key ?? ""}\0${context.laneId ?? ""}\0${context.cwd ?? ""}\0${location.path}`;
  const cached = probeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = await probeTerminalPath({
    location,
    laneId: context.laneId,
    cwd: context.cwd,
    pin: context.runtimePin,
  });
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
  probeCache.set(key, { result, expiresAt: Date.now() + PROBE_TTL_MS });
  return result;
}

/** Links only what exists, checked on hover after the pointer rests on the row. */
export function createTerminalPathLinkProvider(term: Terminal, context: TerminalPathLinkContext): ILinkProvider {
  let hoverGeneration = 0;
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const generation = ++hoverGeneration;
      if (!context.openWorkspacePath) {
        callback(undefined);
        return;
      }
      const lineIndex = Math.max(0, bufferLineNumber - 1);
      const line = readLogicalLine(term, lineIndex);
      if (!line) {
        callback(undefined);
        return;
      }
      const tokens = scanTerminalPathTokens(line.text).slice(0, MAX_PROBED_TOKENS);
      if (tokens.length === 0) {
        callback(undefined);
        return;
      }
      window.setTimeout(() => {
        if (generation !== hoverGeneration) {
          callback(undefined);
          return;
        }
        void (async () => {
          // Asked every time: a remounted terminal keeps its lane here, and its
          // new opener still has to learn it.
          context.laneId = (await context.ensureLaneId?.()) ?? context.laneId;
          if (!context.laneId) return null;
          return Promise.all(tokens.map((token) => probeWithCache(context, token.location)));
        })()
          .then((results) => {
            if (!results || generation !== hoverGeneration) {
              callback(undefined);
              return;
            }
            const links: ILink[] = [];
            tokens.forEach((token, index) => {
              const result = results[index];
              if (!result?.openable) return;
              const start = cellForOffset(term, line, token.start);
              const last = cellForOffset(term, line, token.end - 1);
              const end = { x: last.lastColumn, y: last.y };
              links.push({
                text: line.text.slice(token.start, token.end),
                range: { start: { x: start.x, y: start.y }, end },
                decorations: { underline: true, pointerCursor: true },
                activate(event: MouseEvent) {
                  event.preventDefault();
                  context.openWorkspacePath?.({ ...token.location, path: result.path });
                },
              });
            });
            callback(links.length ? links : undefined);
          })
          .catch((error: unknown) => {
            logRendererDebugEvent("terminal.path_link_probe_failed", { error: error instanceof Error ? error.message : String(error) });
            callback(undefined);
          });
      }, HOVER_PROBE_DELAY_MS);
    },
  };
}

/** OSC 7 is `file://host/path`; keep the path. */
export function readOsc7Cwd(data: string): string | null {
  try {
    const url = new URL(data.trim());
    if (url.protocol !== "file:" || !url.pathname) return null;
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}
