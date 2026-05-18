import type { ProviderFamily } from "../../../../shared/modelRegistry";

export type ModelPickerSearchableItem = {
  /** Display name. Either `name` or `displayName` must be set. */
  name?: string;
  /** Alias accepted to ease passing `ModelDescriptor`-shaped values directly. */
  displayName?: string;
  shortName?: string;
  subProvider?: string;
  family: ProviderFamily;
  /** Provider display label. Falls back to `family` when omitted. */
  providerDisplayName?: string;
  isFavorite?: boolean;
};

function resolveName(item: ModelPickerSearchableItem): string {
  return item.name ?? item.displayName ?? "";
}

function resolveProviderDisplayName(item: ModelPickerSearchableItem): string {
  return item.providerDisplayName ?? item.family;
}

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

function normalizeSearchQuery(input: string): string {
  const trimmed = input.trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[],
): number | null {
  let bestIndex: number | null = null;
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) bestIndex = matchIndex;
  }
  return bestIndex;
}

function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) return null;

  if (value === query) return input.exactBase;

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/"],
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) return input.fuzzyBase + fuzzyScore;
  }

  return null;
}

function getModelPickerSearchFields(item: ModelPickerSearchableItem): string[] {
  return [
    normalizeSearchQuery(resolveName(item)),
    ...(item.shortName ? [normalizeSearchQuery(item.shortName)] : []),
    ...(item.subProvider ? [normalizeSearchQuery(item.subProvider)] : []),
    normalizeSearchQuery(item.family),
    normalizeSearchQuery(resolveProviderDisplayName(item)),
    buildModelPickerSearchText(item),
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(item: ModelPickerSearchableItem): string {
  return normalizeSearchQuery(
    [resolveName(item), item.shortName, item.subProvider, item.family, resolveProviderDisplayName(item)]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  item: ModelPickerSearchableItem,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return 0;

  const fields = getModelPickerSearchFields(item);
  let score = 0;

  for (const token of tokens) {
    const tokenScores = fields
      .map((field, index) => scoreModelPickerSearchToken(field, token, index * 10))
      .filter((fieldScore): fieldScore is number => fieldScore !== null);

    if (tokenScores.length === 0) return null;

    score += Math.min(...tokenScores);
  }

  return item.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}
