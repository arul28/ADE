/**
 * Model search scoring.
 *
 * PROVENANCE: ported from
 * `apps/desktop/src/renderer/components/shared/ModelPicker/modelPickerSearch.ts`.
 * The scoring behaviour (exact > prefix > word-boundary > substring > fuzzy
 * subsequence, per-field bases, multi-token AND) is carried over unchanged; the
 * only edits are dropping the ADE `ProviderFamily` import in favour of a plain
 * provider id, and dropping the favourites boost (this package has no
 * favourites store).
 */

import type { ModelDescriptor, ProviderStatus } from "../sdkTypes";

export type SearchableModel = {
  displayName: string;
  shortName?: string;
  subProvider?: string;
  aliases?: string[];
  providerId: string;
  providerDisplayName?: string;
};

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
      const valueLengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + valueLengthPenalty;
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

function resolveProviderDisplayName(item: SearchableModel): string {
  return item.providerDisplayName ?? item.providerId;
}

function buildModelSearchText(item: SearchableModel): string {
  return normalizeSearchQuery(
    [item.displayName, item.shortName, item.subProvider, item.providerId, resolveProviderDisplayName(item)]
      .concat(item.aliases ?? [])
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

function getSearchFields(item: SearchableModel): string[] {
  return [
    normalizeSearchQuery(item.displayName),
    ...(item.shortName ? [normalizeSearchQuery(item.shortName)] : []),
    ...(item.aliases ?? []).map((alias) => normalizeSearchQuery(alias)).filter(Boolean),
    ...(item.subProvider ? [normalizeSearchQuery(item.subProvider)] : []),
    normalizeSearchQuery(item.providerId),
    normalizeSearchQuery(resolveProviderDisplayName(item)),
    buildModelSearchText(item),
  ];
}

function scoreToken(field: string, token: string, fieldBase: number): number | null {
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

/** Lower is better. Null means "no match" — every token must hit some field. */
export function scoreModelSearch(item: SearchableModel, query: string): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return 0;

  const fields = getSearchFields(item);
  let score = 0;

  for (const token of tokens) {
    const tokenScores = fields
      .map((field, index) => scoreToken(field, token, index * 10))
      .filter((fieldScore): fieldScore is number => fieldScore !== null);

    if (tokenScores.length === 0) return null;

    score += Math.min(...tokenScores);
  }

  return score;
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

export type ProviderModelGroup = {
  providerId: string;
  providerLabel: string;
  status: ProviderStatus | null;
  /** False when the provider is not installed or not authenticated. */
  enabled: boolean;
  models: ModelDescriptor[];
};

function searchable(model: ModelDescriptor, status: ProviderStatus | null): SearchableModel {
  return {
    displayName: model.displayName,
    ...(model.shortName ? { shortName: model.shortName } : {}),
    ...(model.subProvider ? { subProvider: model.subProvider } : {}),
    ...(model.aliases ? { aliases: model.aliases } : {}),
    providerId: model.providerId,
    ...(status?.displayName ? { providerDisplayName: status.displayName } : {}),
  };
}

/** A provider can be selected from only when it is installed and authed. */
export function isProviderUsable(status: ProviderStatus | null | undefined): boolean {
  return Boolean(status?.installed && status.authenticated);
}

/** Model rows are disabled when their provider is unusable or `available: false`. */
export function isModelSelectable(
  model: ModelDescriptor,
  status: ProviderStatus | null | undefined,
): boolean {
  if (model.available === false) return false;
  return isProviderUsable(status);
}

/**
 * Group models by provider, filtering and ordering by search score. Providers
 * keep a stable order (the order they appear in `statuses`, then any provider
 * seen only in the model list), so the rail does not reshuffle as you type.
 */
export function groupModelsByProvider(input: {
  models: readonly ModelDescriptor[];
  statuses: readonly ProviderStatus[];
  query?: string;
}): ProviderModelGroup[] {
  const statusById = new Map(input.statuses.map((status) => [status.id, status]));
  const query = input.query?.trim() ?? "";

  const order: string[] = [];
  for (const status of input.statuses) if (!order.includes(status.id)) order.push(status.id);
  for (const model of input.models) if (!order.includes(model.providerId)) order.push(model.providerId);

  const scored = new Map<string, { model: ModelDescriptor; score: number }[]>();
  for (const model of input.models) {
    const status = statusById.get(model.providerId) ?? null;
    const score = query ? scoreModelSearch(searchable(model, status), query) : 0;
    if (score === null) continue;
    const bucket = scored.get(model.providerId) ?? [];
    bucket.push({ model, score });
    scored.set(model.providerId, bucket);
  }

  const groups: ProviderModelGroup[] = [];
  for (const providerId of order) {
    const bucket = scored.get(providerId);
    if (!bucket || bucket.length === 0) continue;
    const status = statusById.get(providerId) ?? null;
    // Stable sort: equal scores keep catalog order.
    const models = bucket
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => (a.score - b.score) || (a.index - b.index))
      .map((entry) => entry.model);
    groups.push({
      providerId,
      providerLabel: status?.displayName ?? providerId,
      status,
      enabled: isProviderUsable(status),
      models,
    });
  }
  return groups;
}
