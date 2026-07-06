import { isSearchDocKind, type SearchDocKind } from "../../../shared/types/search";

/**
 * Parsed universal-search query. Bare terms AND together, quoted phrases match
 * exactly, and `kind:` / `lane:` / `session:` / `since:` filters narrow the
 * candidate set. Parsing is deterministic; `since:` durations resolve against
 * the caller-provided `now` so tests can pin time.
 */
export type ParsedSearchQuery = {
  /** Bare terms; each must match (AND). Matched as FTS5 prefix tokens. */
  terms: string[];
  /** Quoted phrases; each must match exactly (AND). */
  phrases: string[];
  /** `kind:` filter values (union). Empty = all kinds. */
  kinds: SearchDocKind[];
  /** `lane:` filter — lane id or name, resolved by the caller. */
  lane: string | null;
  /** `session:` filter — terminal_sessions row id. */
  sessionId: string | null;
  /** `since:` filter resolved to an ISO timestamp, or null. */
  sinceIso: string | null;
  /** Filter values that did not parse (unknown kind, bad since). */
  invalidFilters: string[];
};

const FILTER_PREFIXES = ["kind", "lane", "session", "since"] as const;
type FilterPrefix = (typeof FILTER_PREFIXES)[number];

const DURATION_RE = /^(\d+)([mhdw])$/i;

const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000
};

function parseSince(raw: string, now: Date): string | null {
  const durationMatch = DURATION_RE.exec(raw);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unitMs = DURATION_MS[durationMatch[2]!.toLowerCase()] ?? 0;
    if (!Number.isFinite(amount) || unitMs === 0) return null;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Tokenize a raw query into bare tokens and quoted phrases. Quotes group
 * whitespace; an unterminated quote runs to the end of the string. Filter
 * prefixes (`kind:` etc.) are only recognized on unquoted tokens.
 */
function tokenize(raw: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = [];
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const end = raw.indexOf('"', i + 1);
      const body = end < 0 ? raw.slice(i + 1) : raw.slice(i + 1, end);
      if (body.trim().length > 0) out.push({ text: body.trim(), quoted: true });
      i = end < 0 ? len : end + 1;
      continue;
    }
    let j = i;
    while (j < len && !" \t\n\r".includes(raw[j]!)) {
      // A filter value may itself be quoted (kind:"chat"); keep it in the token.
      if (raw[j] === '"') {
        const end = raw.indexOf('"', j + 1);
        j = end < 0 ? len : end + 1;
        continue;
      }
      j += 1;
    }
    out.push({ text: raw.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

function splitFilter(token: string): { prefix: FilterPrefix; value: string } | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const prefix = token.slice(0, colon).toLowerCase();
  if (!(FILTER_PREFIXES as readonly string[]).includes(prefix)) return null;
  let value = token.slice(colon + 1);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return { prefix: prefix as FilterPrefix, value };
}

export function parseSearchQuery(raw: string, options?: { now?: Date }): ParsedSearchQuery {
  const now = options?.now ?? new Date();
  const parsed: ParsedSearchQuery = {
    terms: [],
    phrases: [],
    kinds: [],
    lane: null,
    sessionId: null,
    sinceIso: null,
    invalidFilters: []
  };

  for (const token of tokenize(raw)) {
    if (token.quoted) {
      parsed.phrases.push(token.text);
      continue;
    }
    const filter = splitFilter(token.text);
    if (!filter) {
      parsed.terms.push(token.text);
      continue;
    }
    if (filter.value.length === 0) {
      parsed.invalidFilters.push(token.text);
      continue;
    }
    switch (filter.prefix) {
      case "kind": {
        for (const value of filter.value.split(/[,|]/)) {
          const kind = value.trim().toLowerCase();
          if (!kind) continue;
          if (isSearchDocKind(kind)) {
            if (!parsed.kinds.includes(kind)) parsed.kinds.push(kind);
          } else if (kind === "issue" || kind === "issues") {
            // Ergonomic alias: `kind:issue` means Linear issues.
            if (!parsed.kinds.includes("linear")) parsed.kinds.push("linear");
          } else {
            parsed.invalidFilters.push(`kind:${kind}`);
          }
        }
        break;
      }
      case "lane":
        parsed.lane = filter.value;
        break;
      case "session":
        parsed.sessionId = filter.value;
        break;
      case "since": {
        const sinceIso = parseSince(filter.value, now);
        if (sinceIso) parsed.sinceIso = sinceIso;
        else parsed.invalidFilters.push(token.text);
        break;
      }
    }
  }

  return parsed;
}

/** True when the query has no positive text to match (filters only / empty). */
export function isMatchAllQuery(parsed: ParsedSearchQuery): boolean {
  return parsed.terms.length === 0 && parsed.phrases.length === 0;
}

function escapeFtsString(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * Build a deterministic FTS5 MATCH expression: every bare term is a quoted
 * prefix token, every phrase is a quoted phrase, all AND-ed. Returns null for
 * match-all queries (callers must not run FTS at all in that case).
 * Pass `options.column` to scope every part to one FTS column (e.g. only
 * title matches).
 */
export function buildFtsMatchExpression(
  parsed: ParsedSearchQuery,
  options?: { column?: string }
): string | null {
  const prefix = options?.column ? `${options.column} : ` : "";
  const parts: string[] = [];
  for (const term of parsed.terms) {
    const cleaned = term.trim();
    if (!cleaned) continue;
    parts.push(`${prefix}"${escapeFtsString(cleaned)}"*`);
  }
  for (const phrase of parsed.phrases) {
    const cleaned = phrase.trim();
    if (!cleaned) continue;
    parts.push(`${prefix}"${escapeFtsString(cleaned)}"`);
  }
  if (parts.length === 0) return null;
  return parts.join(" AND ");
}
