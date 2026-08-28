/**
 * Search vocabulary shared by Work's cached session list, the desktop command
 * palette, and the ADE TUI. Keep the parser deliberately small: users get
 * quoted phrases, whitespace-separated any-order terms, and the facets Work
 * can actually explain in a result row.
 */

export const WORK_SEARCH_FILTER_KEYS = [
  "lane",
  "provider",
  "status",
  "type",
  "machine",
] as const;

export type WorkSearchFilterKey = (typeof WORK_SEARCH_FILTER_KEYS)[number];

export type WorkSearchFilterToken = {
  key: WorkSearchFilterKey;
  value: string;
  raw: string;
  /** Position within a comma-separated filter token. */
  valueIndex: number;
};

export type ParsedWorkSearch = {
  /** Bare words and quoted phrases, already lowercased. */
  terms: string[];
  /** Facets are OR-ed within a key and AND-ed across keys. */
  filters: Record<WorkSearchFilterKey, string[]>;
  filterTokens: WorkSearchFilterToken[];
  /** Existing universal-search aliases plus free text, minus local-only facets. */
  backendQuery: string;
  /** One backend query per lane so repeated lane: values retain OR semantics. */
  backendQueries: string[];
  /** Legacy Work-only alias retained for the inline list. */
  tracked: string | null;
};

type ParsedToken = {
  raw: string;
  key: string | null;
  value: string;
};

const TOKEN_RE =
  /(?:(lane|provider|status|type|machine|kind|since|session|tracked):)?(?:"([^"]+)"|(\S+))/gi;
const WORK_FACET_KEY_SET = new Set<string>(WORK_SEARCH_FILTER_KEYS);

function emptyFilters(): Record<WorkSearchFilterKey, string[]> {
  return {
    lane: [],
    provider: [],
    status: [],
    type: [],
    machine: [],
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokenValue(value: string): string {
  return normalize(value).replace(/\s+/g, " ");
}

function isWorkSearchFilterKey(key: string): key is WorkSearchFilterKey {
  return WORK_FACET_KEY_SET.has(key);
}

function renderBackendFacetValue(value: string): string {
  return /[\s,]/.test(value)
    ? `"${value.replace(/"/g, "")}"`
    : value;
}

function parseTokens(query: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  for (const match of query.matchAll(TOKEN_RE)) {
    const raw = match[0] ?? "";
    const key = match[1]?.toLowerCase() ?? null;
    const value = match[2] ?? match[3] ?? "";
    if (raw && value) tokens.push({ raw, key, value });
  }
  return tokens;
}

/** Parse the user-facing Work query without losing phrase boundaries. */
export function parseWorkSearchQuery(query: string): ParsedWorkSearch {
  const filters = emptyFilters();
  const terms: string[] = [];
  const filterTokens: WorkSearchFilterToken[] = [];
  const backendTokens: string[] = [];
  const laneValues: string[] = [];
  let tracked: string | null = null;

  for (const token of parseTokens(query.trim())) {
    const value = tokenValue(token.value);
    if (!value) continue;

    if (token.key && isWorkSearchFilterKey(token.key)) {
      const key = token.key;
      const values = value.split(",").map(tokenValue).filter(Boolean);
      for (const [valueIndex, filterValue] of values.entries()) {
        filters[key].push(filterValue);
        filterTokens.push({
          key,
          value: filterValue,
          raw: token.raw,
          valueIndex,
        });
      }
      // `lane:` is understood by the universal index too. Keep each value so
      // the backend can be queried once per lane; its parser stores one lane
      // value, while Work's user-facing contract is OR within a facet.
      if (key === "lane") laneValues.push(...values);
      continue;
    }

    // `kind:` is an existing universal-search alias. Work treats it as its
    // type facet as well, so cached rows obey the same restriction as content
    // hits instead of treating "chat" as ordinary free text.
    if (token.key === "kind") {
      const values = value.split(",").map(tokenValue).filter(Boolean);
      for (const [valueIndex, filterValue] of values.entries()) {
        filters.type.push(filterValue);
        filterTokens.push({
          key: "type",
          value: filterValue,
          raw: token.raw,
          valueIndex,
        });
      }
      backendTokens.push(token.raw);
      continue;
    }

    if (token.key === "tracked") {
      tracked = value;
      continue;
    }

    // These are valid universal-search filters, but Work does not have a
    // local representation for their semantics. Preserve them for the
    // backend without making values such as "7d" or a session id required
    // words in cached Work rows.
    if (token.key === "since" || token.key === "session") {
      backendTokens.push(token.raw);
      continue;
    }

    terms.push(value);
    backendTokens.push(token.raw);
  }

  const backendBase = backendTokens.join(" ");
  const backendQueries = laneValues.length > 0
    ? [...new Set(laneValues)].map((lane) => `${backendBase} lane:${renderBackendFacetValue(lane)}`.trim())
    : [backendBase];

  return {
    terms,
    filters,
    filterTokens,
    backendQuery: backendQueries[0] ?? "",
    backendQueries,
    tracked,
  };
}

/** Every bare word/phrase must be present somewhere in the indexed fields. */
export function matchesWorkSearchTerms(
  terms: readonly string[],
  fields: readonly (string | null | undefined)[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = fields
    .filter(
      (field): field is string => typeof field === "string" && field.length > 0,
    )
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Score TUI-style labels while retaining its established subsequence fallback.
 * Desktop Work rows use the stricter matcher above; the TUI command palette has
 * historically let short queries such as "nch" find "/new chat".
 */
export function scoreWorkSearchTerms(
  terms: readonly string[],
  fields: readonly (string | null | undefined)[],
): number | null {
  if (terms.length === 0) return 0;
  const haystack = fields
    .filter(
      (field): field is string => typeof field === "string" && field.length > 0,
    )
    .join(" ")
    .toLowerCase();
  let total = 0;
  for (const term of terms) {
    const exactIndex = haystack.indexOf(term);
    if (exactIndex >= 0) {
      total += exactIndex;
      continue;
    }
    let cursor = 0;
    let fuzzyScore = 0;
    for (const char of term) {
      const found = haystack.indexOf(char, cursor);
      if (found < 0) return null;
      fuzzyScore += found - cursor;
      cursor = found + 1;
    }
    total += fuzzyScore + haystack.length;
  }
  return total;
}

function valueMatchesFacet(value: string, wanted: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedWanted = normalize(wanted);
  return (
    normalizedValue === normalizedWanted ||
    normalizedValue.includes(normalizedWanted)
  );
}

/** Apply the facet contract: OR within one facet, AND across facets. */
export function matchesWorkSearchFilters(
  filters: ParsedWorkSearch["filters"],
  facets: Partial<Record<WorkSearchFilterKey, readonly string[]>>,
): boolean {
  for (const key of WORK_SEARCH_FILTER_KEYS) {
    const wanted = filters[key];
    if (wanted.length === 0) continue;
    const available = facets[key] ?? [];
    if (
      !wanted.some((candidate) =>
        available.some((value) => valueMatchesFacet(value, candidate)),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Remove one typed facet occurrence when its inline chip is dismissed. */
export function removeWorkSearchFilterToken(
  query: string,
  token: WorkSearchFilterToken,
): string {
  const index = query.toLowerCase().indexOf(token.raw.toLowerCase());
  if (index < 0) return query;

  const colon = token.raw.indexOf(":");
  const rawValues = colon >= 0 ? token.raw.slice(colon + 1).split(",") : [];
  if (rawValues.length > 1) {
    const valueIndex = Math.min(token.valueIndex, rawValues.length - 1);
    const valueStart = index + colon + 1;
    const partStart = valueStart
      + rawValues
        .slice(0, valueIndex)
        .reduce((offset, part) => offset + part.length + 1, 0);
    const partEnd = partStart + rawValues[valueIndex]!.length;
    const removeStart = valueIndex === rawValues.length - 1
      ? partStart - 1
      : partStart;
    const removeEnd = valueIndex === rawValues.length - 1
      ? partEnd
      : partEnd + 1;
    return `${query.slice(0, removeStart)}${query.slice(removeEnd)}`
      .replace(/\s+/g, " ")
      .trim();
  }

  return `${query.slice(0, index)} ${query.slice(index + token.raw.length)}`
    .replace(/\s+/g, " ")
    .trim();
}

/** Add a facet from the palette picker while keeping free text intact. */
export function appendWorkSearchFilter(
  query: string,
  key: WorkSearchFilterKey,
  value: string,
): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) return query;
  const renderedValue = /[\s,]/.test(normalizedValue)
    ? `"${normalizedValue.replace(/"/g, "")}"`
    : normalizedValue;
  return `${query.trim()}${query.trim() ? " " : ""}${key}:${renderedValue}`;
}
