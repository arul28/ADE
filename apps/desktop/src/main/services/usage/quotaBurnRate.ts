import type { AdeQuotaBurnRate, AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import { localUsageAccountId } from "./usageAccountId";

/**
 * Learns what one percent of a subscription window costs on this machine.
 *
 * A subscription says "you have used 42% of this week", never in dollars or
 * tokens. A router has to compare that headroom with an API key's dollars, so
 * this pairs the quota readings with the ledger rows between them: each window
 * instance (one reset time) that moved from p0 to p1 while ADE turns worth $X
 * ran gives X / (p1 - p0) dollars per percent.
 *
 * The ledger sees ADE turns only. Other clients on the same login also move
 * the percent, so the result is a lower bound on dollars per percent. That
 * keeps a headroom estimate on the safe side.
 */

/** How far back a burn rate reads quota readings and ledger rows. */
export const DEFAULT_BURN_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Reset times that differ by less than this are one window instance. Providers
 * round them, and Claude's `resets_at` moves by microseconds on every poll.
 */
const RESET_JITTER_MS = 5 * 60 * 1000;

type WindowSpan = {
  first: AdeQuotaSample;
  last: AdeQuotaSample;
};

/** One quota window of one account: the key both the ledger writer and this estimator group readings by. */
export function quotaSampleKey(sample: Pick<AdeQuotaSample, "provider" | "accountId" | "windowType">): string {
  return `${sample.provider}|${sample.accountId}|${sample.windowType}`;
}

/** True when two readings name the same window instance (the same reset, give or take the jitter). */
export function sameResetInstance(a: Pick<AdeQuotaSample, "resetsAt">, b: Pick<AdeQuotaSample, "resetsAt">): boolean {
  const left = Date.parse(a.resetsAt);
  const right = Date.parse(b.resetsAt);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return a.resetsAt === b.resetsAt;
  return Math.abs(left - right) <= RESET_JITTER_MS;
}

/** Splits one window's readings, oldest first, into its reset instances. */
function windowSpans(samples: AdeQuotaSample[]): WindowSpan[] {
  const spans: WindowSpan[] = [];
  let current: WindowSpan | null = null;
  for (const sample of samples) {
    if (current && sameResetInstance(current.last, sample) && sample.percentUsed >= current.last.percentUsed) {
      current.last = sample;
      continue;
    }
    current = { first: sample, last: sample };
    spans.push(current);
  }
  return spans;
}

/**
 * The turns that paid into a quota window. A turn with the same account key
 * always counts. When the provider has one account in the readings, every turn
 * of that provider counts, because older hosts and single-login providers do
 * not name the account on either side. This includes a turn keyed
 * `<provider>:local` when the one account has a name.
 */
function turnMatchesWindow(turn: AdeTurnUsageRecord, sample: AdeQuotaSample, singleAccountProvider: boolean): boolean {
  if (turn.provider !== sample.provider) return false;
  if (turn.accountKey === sample.accountId) return true;
  return singleAccountProvider;
}

/**
 * False for a turn that cannot have moved a subscription window: one billed to
 * an API key, one served by a local model, and one the runtime says it routed
 * away from the provider's plan (`routedAway`: a keyed preset, a redirected
 * endpoint, or a cloud route such as Bedrock). `upstream` names only the model
 * vendor, so it says nothing about who paid. A row with no account comes from
 * an older host and still counts.
 */
function drawsOnSubscription(turn: AdeTurnUsageRecord): boolean {
  const account = turn.account;
  if (!account) return true;
  if (account.routedAway) return false;
  return account.kind !== "api_key" && account.kind !== "local";
}

/**
 * How many accounts each provider has in the readings. A `<provider>:local`
 * reading does not count when the provider also has a named account: the
 * poller writes it when an identity call fails (after a restart or a token
 * refresh), so it is the same login without its name. Counted as a second
 * account, it would stop every turn from matching the named window.
 */
function accountCountsByProvider(samples: AdeQuotaSample[]): Map<string, number> {
  const accountsByProvider = new Map<string, Set<string>>();
  for (const sample of samples) {
    const accounts = accountsByProvider.get(sample.provider) ?? new Set<string>();
    accounts.add(sample.accountId);
    accountsByProvider.set(sample.provider, accounts);
  }
  const counts = new Map<string, number>();
  for (const [provider, accounts] of accountsByProvider) {
    const hasLocal = accounts.has(localUsageAccountId(provider));
    counts.set(provider, hasLocal && accounts.size > 1 ? accounts.size - 1 : accounts.size);
  }
  return counts;
}

/** True when the row reports at least one token. A row without tokens costs $0; it is not unpriced. */
function turnHasTokens(turn: AdeTurnUsageRecord): boolean {
  return [turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens, turn.reasoningTokens]
    .some((count) => count != null && count > 0);
}

function confidenceFor(observedPercent: number, observedTurns: number): AdeQuotaBurnRate["confidence"] {
  if (observedPercent <= 0 || observedTurns === 0) return "none";
  if (observedPercent < 5) return "low";
  if (observedPercent < 20) return "medium";
  return "high";
}

/**
 * The burn rate of each quota window as of `nowMs`. Readings and turns after
 * `nowMs` are left out, so a caller can ask what the rate was at a past moment
 * (the daily research report asks at the end of each day).
 */
export function estimateQuotaBurnRates(args: {
  samples: AdeQuotaSample[];
  turns: AdeTurnUsageRecord[];
  nowMs: number;
  lookbackMs?: number;
}): AdeQuotaBurnRate[] {
  const sinceMs = args.nowMs - (args.lookbackMs ?? DEFAULT_BURN_LOOKBACK_MS);
  const inSpan = (at: string): boolean => {
    const atMs = Date.parse(at);
    return atMs >= sinceMs && atMs <= args.nowMs;
  };
  const recent = args.samples
    .filter((sample) => inSpan(sample.at))
    .sort((a, b) => a.at.localeCompare(b.at));
  const byWindow = new Map<string, AdeQuotaSample[]>();
  for (const sample of recent) {
    const key = quotaSampleKey(sample);
    const list = byWindow.get(key) ?? [];
    list.push(sample);
    byWindow.set(key, list);
  }
  const accountCounts = accountCountsByProvider(recent);
  const turns = args.turns
    .filter((turn) => inSpan(turn.at) && drawsOnSubscription(turn))
    .map((turn) => ({ turn, atMs: Date.parse(turn.at) }));

  const rates: AdeQuotaBurnRate[] = [];
  for (const samples of byWindow.values()) {
    const head = samples[0]!;
    const latest = samples[samples.length - 1]!;
    const singleAccountProvider = accountCounts.get(head.provider) === 1;
    let observedPercent = 0;
    let observedUsd = 0;
    let observedTurns = 0;
    for (const span of windowSpans(samples)) {
      const moved = span.last.percentUsed - span.first.percentUsed;
      if (moved <= 0) continue;
      const fromMs = Date.parse(span.first.at);
      const toMs = Date.parse(span.last.at);
      let spanUsd = 0;
      let spanTurns = 0;
      let spanHasUnpricedTurn = false;
      for (const { turn, atMs } of turns) {
        if (atMs <= fromMs || atMs > toMs) continue;
        if (!turnMatchesWindow(turn, span.first, singleAccountProvider)) continue;
        spanTurns += 1;
        if (turn.apiEquivalentUsd != null) spanUsd += turn.apiEquivalentUsd;
        else if (turnHasTokens(turn)) spanHasUnpricedTurn = true;
      }
      // A span with no ADE turn moved for reasons ADE cannot see, and a span
      // with a turn that used tokens at no known price has an unknown dollar
      // figure. Counting either would drag the rate toward zero for no
      // information. A turn with no tokens at all cost $0 and still counts.
      if (spanTurns === 0 || spanHasUnpricedTurn) continue;
      observedPercent += moved;
      observedUsd += spanUsd;
      observedTurns += spanTurns;
    }
    const usdPerPercent = observedPercent > 0 && observedUsd > 0 ? observedUsd / observedPercent : null;
    // A reading whose window already reset says nothing about today's headroom.
    const latestFresh = Date.parse(latest.resetsAt) > args.nowMs;
    const latestPercentUsed = latestFresh ? latest.percentUsed : null;
    rates.push({
      provider: head.provider,
      accountId: head.accountId,
      windowType: head.windowType,
      usdPerPercent: usdPerPercent != null ? Math.round(usdPerPercent * 10_000) / 10_000 : null,
      turnsPerPercent: observedPercent > 0 ? Math.round((observedTurns / observedPercent) * 100) / 100 : null,
      observedPercent: Math.round(observedPercent * 100) / 100,
      observedUsd: Math.round(observedUsd * 10_000) / 10_000,
      observedTurns,
      latestPercentUsed,
      latestResetsAt: latestFresh ? latest.resetsAt : null,
      headroomUsd: usdPerPercent != null && latestPercentUsed != null
        ? Math.round(Math.max(0, 100 - latestPercentUsed) * usdPerPercent * 100) / 100
        : null,
      confidence: usdPerPercent == null ? "none" : confidenceFor(observedPercent, observedTurns),
    });
  }
  return rates.sort((a, b) => a.provider.localeCompare(b.provider) || a.accountId.localeCompare(b.accountId) || a.windowType.localeCompare(b.windowType));
}
