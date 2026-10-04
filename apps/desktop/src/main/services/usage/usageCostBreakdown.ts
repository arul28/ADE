import type {
  AdeTurnUsageRecord,
  AdeUsageCostBreakdown,
  AdeUsageCostBreakdownBy,
  AdeUsageCostBreakdownRow,
  AdeUsageCostBreakdownTotals,
} from "../../../shared/types";

/**
 * `usage.getCostBreakdown`: ADE's per-turn ledger ranked by chat, lane, or
 * account. Pure: the caller reads the ledger rows for the range and supplies
 * the names, so the arithmetic is the same on every host.
 */

export const COST_BREAKDOWN_DEFAULT_LIMIT = 50;
const DELETED_KEY = "deleted";
export const COST_BREAKDOWN_MAX_LIMIT = 200;

export type CostBreakdownLabels = {
  /** A chat's title and lane, or null when the chat is gone. */
  chat(sessionId: string): { title: string | null; laneId: string | null } | null;
  /** A lane's name, or null when the lane is gone. */
  lane(laneId: string): string | null;
};

/**
 * The turn's value at public list prices. A row with no list price falls back
 * to the provider's own figure, which is the only number it has.
 */
function rowValueUsd(row: AdeTurnUsageRecord): number {
  const value = row.apiEquivalentUsd ?? row.costUsd ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The part of a turn someone was charged money for. An API key, or a
 * subscription harness routed to another bill (a keyed preset, a redirected
 * endpoint, Bedrock), pays per token: its provider-reported cost when the
 * provider sent one, else the list price. An account whose kind is unknown
 * counts only when the provider itself reported a bill.
 */
function rowBilledUsd(row: AdeTurnUsageRecord): number {
  const kind = row.account?.kind ?? "unknown";
  const paysPerToken = kind === "api_key" || Boolean(row.account?.routedAway);
  if (paysPerToken) {
    const billed = row.costSource === "provider" ? row.costUsd : null;
    return Math.max(0, billed ?? rowValueUsd(row));
  }
  if (kind === "unknown" && row.costSource === "provider") return Math.max(0, row.costUsd ?? 0);
  return 0;
}

function rowPlanValueUsd(row: AdeTurnUsageRecord): number {
  if (row.account?.kind !== "subscription" || row.account.routedAway) return 0;
  return rowValueUsd(row);
}

function rowTokens(row: AdeTurnUsageRecord): number {
  return (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function accountLabel(row: AdeTurnUsageRecord): { label: string; detail: string | null } {
  const provider = titleCase(row.account?.provider ?? row.provider);
  const kind = row.account?.kind ?? "unknown";
  const email = row.account?.email?.trim();
  const plan = row.account?.plan?.trim();
  const how = row.account?.routedAway
    ? `routed via ${row.account.routedAway}`
    : kind === "api_key" ? "API key" : kind === "local" ? "local model" : kind === "subscription" ? (plan || "subscription") : null;
  return {
    label: email ? `${provider} · ${email}` : `${provider}${how ? ` · ${how}` : ""}`,
    detail: email ? how : null,
  };
}

function emptyTotals(): AdeUsageCostBreakdownTotals {
  return { turns: 0, totalTokens: 0, costUsd: 0, billedUsd: 0, planValueUsd: 0 };
}

function addRow(target: AdeUsageCostBreakdownTotals, row: AdeTurnUsageRecord): void {
  target.turns += 1;
  target.totalTokens += rowTokens(row);
  target.costUsd += rowValueUsd(row);
  target.billedUsd += rowBilledUsd(row);
  target.planValueUsd += rowPlanValueUsd(row);
}

function roundTotals<T extends AdeUsageCostBreakdownTotals>(totals: T): T {
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return { ...totals, costUsd: round(totals.costUsd), billedUsd: round(totals.billedUsd), planValueUsd: round(totals.planValueUsd) };
}

export function buildCostBreakdown(input: {
  rows: readonly AdeTurnUsageRecord[];
  by: AdeUsageCostBreakdownBy;
  range: { since: string | null; until: string };
  labels: CostBreakdownLabels;
  laneId?: string | null;
  limit?: number;
}): AdeUsageCostBreakdown {
  const { by, labels } = input;
  const limit = Math.min(COST_BREAKDOWN_MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? COST_BREAKDOWN_DEFAULT_LIMIT)));
  const laneFilter = input.laneId?.trim() || null;
  const groups = new Map<string, AdeUsageCostBreakdownRow>();
  const totals = emptyTotals();
  // Deleted chats and lanes leave no name behind (a lane's tombstone keeps
  // counters only), so they fold into one row each rather than a column of
  // identical "Deleted lane" rows. The count says how many went into it.
  const deletedKeys = new Map<string, Set<string>>();

  for (const row of input.rows) {
    const chat = by === "account" ? null : labels.chat(row.sessionId);
    // A chat that moved lanes is counted under the lane it is in now; one
    // whose session is gone keeps the lane its turns recorded.
    const laneId = chat?.laneId ?? row.laneId ?? null;
    if (laneFilter && laneId !== laneFilter) continue;
    addRow(totals, row);

    let key: string;
    let seed: Omit<AdeUsageCostBreakdownRow, keyof AdeUsageCostBreakdownTotals>;
    if (by === "chat") {
      const laneName = laneId ? labels.lane(laneId) : null;
      if (!chat) {
        key = DELETED_KEY;
        (deletedKeys.get(key) ?? deletedKeys.set(key, new Set()).get(key)!).add(row.sessionId);
        seed = { key, label: "Deleted chats", laneId: laneFilter };
      } else {
        key = row.sessionId;
        seed = {
          key,
          label: chat.title?.trim() || "Untitled chat",
          detail: laneName ?? (laneId ? "Deleted lane" : null),
          laneId,
          sessionId: row.sessionId,
          provider: row.provider,
        };
      }
    } else if (by === "lane") {
      const laneName = laneId ? labels.lane(laneId) : null;
      if (laneId && !laneName) {
        key = DELETED_KEY;
        (deletedKeys.get(key) ?? deletedKeys.set(key, new Set()).get(key)!).add(laneId);
        seed = { key, label: "Deleted lanes", laneId: null };
      } else {
        key = laneId ?? "";
        seed = { key, label: laneName ?? "No lane", laneId };
      }
    } else {
      // One login is one row, as on the live limits: the same email reached
      // through two provider instances (or before and after ADE learned the
      // instance) is the same account.
      const email = row.account?.email?.trim().toLowerCase();
      key = email ? `${row.account?.provider ?? row.provider}:${email}` : row.accountKey;
      const { label, detail } = accountLabel(row);
      seed = { key, label, detail, provider: row.account?.provider ?? row.provider, accountKind: row.account?.kind ?? "unknown" };
    }
    let group = groups.get(key);
    if (!group) {
      group = { ...seed, ...emptyTotals() };
      groups.set(key, group);
    }
    addRow(group, row);
  }

  for (const [key, members] of deletedKeys) {
    const group = groups.get(key);
    if (group) group.label = `${group.label} (${members.size})`;
  }
  const ranked = [...groups.values()].sort((a, b) => (b.costUsd - a.costUsd) || (b.totalTokens - a.totalTokens) || a.label.localeCompare(b.label));
  const shown = ranked.slice(0, limit).map(roundTotals);
  const tail = ranked.slice(limit);
  let other: AdeUsageCostBreakdown["other"] = null;
  if (tail.length) {
    const folded = emptyTotals();
    for (const group of tail) {
      folded.turns += group.turns;
      folded.totalTokens += group.totalTokens;
      folded.costUsd += group.costUsd;
      folded.billedUsd += group.billedUsd;
      folded.planValueUsd += group.planValueUsd;
    }
    other = { ...roundTotals(folded), count: tail.length };
  }
  return { by, range: input.range, available: true, rows: shown, other, totals: roundTotals(totals) };
}
