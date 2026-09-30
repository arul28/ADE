/**
 * Router efficiency: what the router would have saved, measured against what
 * really ran.
 *
 * Threads come from the turn ledger, so the report covers history from the
 * first day, not only the time since the router shipped. A thread is one chat
 * session. The router may switch a thread's route only at a free switch point,
 * where the prompt cache is cold anyway and a switch costs no extra rebuild:
 * - the thread's first turn;
 * - the turn after a context compaction;
 * - a turn that starts after the cache expired (idle longer than its TTL);
 * - a turn where the user changed the model or effort (the cache rebuilt anyway).
 * The turns from one switch point to the next are a segment. Each segment gets
 * one decision from routerCore, and its list-price cost scales by the picked
 * route's cost per task over the reference route's.
 *
 * Subagents come from the shadow log, which records one decision per subagent
 * as it starts. Claude reports no per-subagent price, so their saving is
 * weighted by tokens instead of dollars.
 *
 * Pure: no I/O, no clock reads.
 */
import type { AdeTurnUsageRecord } from "../../../shared/types/turnUsage";
import { findReferenceRoute, routeBillingFor, routeHarnessOf, type ModelRoute, type RouteBilling } from "./routeCatalog";
import { pickRoute, type PlanState, type RouterDecision, type RouterTaskKind } from "./routerCore";

export type RouterSwitchPoint = "thread_start" | "compaction" | "cache_expired" | "route_changed";

/** Claude's long cache, and every other provider's (their caches are gone well within an hour). */
const CACHE_TTL_LONG_MS = 3_600_000;
/** Claude's default cache, for a thread that writes only 5-minute cache. */
const CACHE_TTL_SHORT_MS = 5 * 60_000;
const TOP_LIMIT = 10;

export type ThreadSegment = {
  sessionId: string;
  parentSessionId: string | null;
  provider: string;
  /** The model the thread asked for; the router routes requests, not what a gateway served. */
  model: string | null;
  effort: string | null;
  startsAt: RouterSwitchPoint;
  turns: AdeTurnUsageRecord[];
};

function turnStartMs(turn: AdeTurnUsageRecord): number {
  const started = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  return Number.isFinite(started) ? started : Date.parse(turn.at);
}

/**
 * How long a thread's cache outlives its last turn. A Claude thread that wrote
 * cache but never the 1-hour kind runs on the 5-minute cache; every other
 * thread gets an hour, which is the conservative side: fewer free switch points.
 */
function cacheTtlMs(thread: readonly AdeTurnUsageRecord[]): number {
  if (thread[0]?.provider !== "claude") return CACHE_TTL_LONG_MS;
  const knowsLongWrites = thread.some((turn) => turn.cacheWrite1hTokens != null);
  const writesLong = thread.some((turn) => (turn.cacheWrite1hTokens ?? 0) > 0);
  const writes = thread.some((turn) => (turn.cacheWriteTokens ?? 0) > 0);
  return knowsLongWrites && writes && !writesLong ? CACHE_TTL_SHORT_MS : CACHE_TTL_LONG_MS;
}

/** Splits every thread in the ledger at its free switch points. */
export function segmentThreads(turns: readonly AdeTurnUsageRecord[]): ThreadSegment[] {
  const threads = new Map<string, AdeTurnUsageRecord[]>();
  for (const turn of turns) {
    const list = threads.get(turn.sessionId) ?? [];
    list.push(turn);
    threads.set(turn.sessionId, list);
  }
  const segments: ThreadSegment[] = [];
  for (const [sessionId, thread] of threads) {
    thread.sort((a, b) => turnStartMs(a) - turnStartMs(b));
    const ttl = cacheTtlMs(thread);
    let current: ThreadSegment | null = null;
    let previous: AdeTurnUsageRecord | null = null;
    for (const turn of thread) {
      const model = turn.requestedModel ?? turn.servedModel;
      const effort = turn.reasoningEffort;
      let reason: RouterSwitchPoint | null = null;
      if (!previous || !current) reason = "thread_start";
      else if (previous.compactions > 0) reason = "compaction";
      else if (turnStartMs(turn) - Date.parse(previous.at) > ttl) reason = "cache_expired";
      else if (turn.provider !== current.provider || model !== current.model || effort !== current.effort) reason = "route_changed";
      if (reason) {
        current = {
          sessionId,
          parentSessionId: turn.parentSessionId,
          provider: turn.provider,
          model,
          effort,
          startsAt: reason,
          turns: [],
        };
        segments.push(current);
      }
      current!.turns.push(turn);
      previous = turn;
    }
  }
  return segments;
}

/**
 * What a pick costs as a share of the reference: the ratio of their list-price
 * cost per task, or the router's own saving when a price is missing.
 */
function costRatio(pick: RouterDecision | null, reference: RouterDecision | null): number {
  if (!pick) return 1;
  const pickUsd = pick.route.costPerIndexTaskUsd;
  const refUsd = reference?.route.costPerIndexTaskUsd;
  if (pickUsd != null && refUsd != null && refUsd > 0) return pickUsd / refUsd;
  return pick.savingShare != null ? 1 - pick.savingShare : 1;
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;
const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((1 - part / whole) * 1000) / 1000 : null);

/**
 * Where the cost lands, by who bills it. The router picks in plan terms, not
 * list dollars: a plan route costs a share of the plan window. So a move from
 * a metered route onto a plan can raise list dollars and still be the cheaper
 * pick. This view shows both currencies side by side.
 */
export type RouterBillingEfficiency = {
  /** `claude plan`, `codex plan`, `metered (opencode-zen)`, `free`, or `unrouted`. */
  billing: string;
  plan: string | null;
  actualUsd: number;
  sameHarnessUsd: number;
  anyHarnessUsd: number;
  /** List dollars per percent of the plan's longest window, from the quota ledger; null for non-plan billing. */
  usdPerPercent: number | null;
  /** Percent of the plan's longest window (weekly for Claude and Codex). Null without a burn rate. */
  actualPercent: number | null;
  sameHarnessPercent: number | null;
  anyHarnessPercent: number | null;
};

export type RouterEfficiencyMove = { from: string; to: string; segments: number; actualUsd: number; routedUsd: number };

export type RouterThreadEfficiency = {
  threads: number;
  /** Threads that another chat started (ADE subagent chats). */
  childThreads: number;
  turns: number;
  segments: number;
  segmentsByStart: Record<RouterSwitchPoint, number>;
  /** Turns with a list price. Unpriced turns add no dollars on either side. */
  pricedTurns: number;
  actualUsd: number;
  /** The same turns if each segment had run on the router's pick inside its own harness. */
  sameHarnessUsd: number;
  /** The same turns if each segment had run on the router's pick in any harness. */
  anyHarnessUsd: number;
  sameHarnessSaving: number | null;
  anyHarnessSaving: number | null;
  switchedSegments: { sameHarness: number; anyHarness: number };
  byBilling: RouterBillingEfficiency[];
  /** Why segments kept their route, weighted by what they cost. */
  kept: Array<{ reason: string; segments: number; turns: number; actualUsd: number }>;
  topMoves: { sameHarness: RouterEfficiencyMove[]; anyHarness: RouterEfficiencyMove[] };
  topThreads: Array<{
    sessionId: string;
    parentSessionId: string | null;
    provider: string;
    model: string | null;
    turns: number;
    segments: number;
    actualUsd: number;
    sameHarnessUsd: number;
    anyHarnessUsd: number;
  }>;
};

export type ThreadReplayInput = {
  turns: readonly AdeTurnUsageRecord[];
  routes: readonly ModelRoute[];
  plans: ReadonlyMap<string, PlanState>;
  trusted: ReadonlySet<string>;
};

/**
 * Replays the router over every thread. Plans are taken as they are now, with
 * no window blocked: a replay asks which route was cheaper at equal quality,
 * and today's quota state says nothing about a window that reset since.
 */
export function replayThreads(input: ThreadReplayInput): RouterThreadEfficiency {
  const plans = new Map([...input.plans].map(([plan, state]) => [plan, { ...state, blockedReason: null }]));
  const segments = segmentThreads(input.turns);
  const segmentsByStart: Record<RouterSwitchPoint, number> = { thread_start: 0, compaction: 0, cache_expired: 0, route_changed: 0 };
  const kept = new Map<string, { segments: number; turns: number; actualUsd: number }>();
  const moves = { sameHarness: new Map<string, RouterEfficiencyMove>(), anyHarness: new Map<string, RouterEfficiencyMove>() };
  const threads = new Map<string, RouterThreadEfficiency["topThreads"][number]>();
  const billing = new Map<string, { plan: string | null; actualUsd: number; sameHarnessUsd: number; anyHarnessUsd: number }>();
  const addBilling = (route: RouteBilling | null, side: "actualUsd" | "sameHarnessUsd" | "anyHarnessUsd", usd: number) => {
    const label = !route ? "unrouted" : route.kind === "plan" ? `${route.plan} plan` : route.kind === "metered" ? `metered (${route.channel})` : "free";
    const entry = billing.get(label) ?? { plan: route?.kind === "plan" ? route.plan : null, actualUsd: 0, sameHarnessUsd: 0, anyHarnessUsd: 0 };
    entry[side] += usd;
    billing.set(label, entry);
  };
  let pricedTurns = 0;
  let actualUsd = 0;
  let sameHarnessUsd = 0;
  let anyHarnessUsd = 0;
  const switched = { sameHarness: 0, anyHarness: 0 };

  const noteMove = (bucket: Map<string, RouterEfficiencyMove>, from: string, to: string, actual: number, routed: number) => {
    const key = `${from} → ${to}`;
    const move = bucket.get(key) ?? { from, to, segments: 0, actualUsd: 0, routedUsd: 0 };
    move.segments += 1;
    move.actualUsd += actual;
    move.routedUsd += routed;
    bucket.set(key, move);
  };

  for (const segment of segments) {
    segmentsByStart[segment.startsAt] += 1;
    let segmentUsd = 0;
    for (const turn of segment.turns) {
      if (turn.apiEquivalentUsd == null) continue;
      pricedTurns += 1;
      segmentUsd += turn.apiEquivalentUsd;
    }
    const harness = routeHarnessOf(segment.provider);
    const kind: RouterTaskKind = segment.parentSessionId ? "unknown" : "lead";
    const pick = harness
      ? pickRoute({
          routes: input.routes,
          reference: findReferenceRoute(input.routes, harness, segment.model, segment.effort),
          kind,
          plans,
          trusted: input.trusted,
        })
      : null;
    const sameUsd = segmentUsd * costRatio(pick?.sameHarness ?? null, pick?.reference ?? null);
    const anyUsd = segmentUsd * costRatio(pick?.anyHarness ?? null, pick?.reference ?? null);
    actualUsd += segmentUsd;
    sameHarnessUsd += sameUsd;
    anyHarnessUsd += anyUsd;

    const refBilling = pick?.reference?.route.billing ?? (harness && segment.model ? routeBillingFor(harness, segment.model) : null);
    addBilling(refBilling, "actualUsd", segmentUsd);
    addBilling(pick?.sameHarness?.route.billing ?? refBilling, "sameHarnessUsd", sameUsd);
    addBilling(pick?.anyHarness?.route.billing ?? refBilling, "anyHarnessUsd", anyUsd);

    const from = pick?.reference?.route.id ?? `${segment.provider}|${segment.model ?? "?"}|${segment.effort ?? "-"}`;
    if (pick?.sameHarness) {
      switched.sameHarness += 1;
      noteMove(moves.sameHarness, from, pick.sameHarness.route.id, segmentUsd, sameUsd);
    }
    if (pick?.anyHarness) {
      switched.anyHarness += 1;
      noteMove(moves.anyHarness, from, pick.anyHarness.route.id, segmentUsd, anyUsd);
    }
    if (!pick?.anyHarness) {
      const reason = !harness ? `the ${segment.provider} harness is not routed` : pick?.keptBecause ?? "kept";
      const entry = kept.get(reason) ?? { segments: 0, turns: 0, actualUsd: 0 };
      entry.segments += 1;
      entry.turns += segment.turns.length;
      entry.actualUsd += segmentUsd;
      kept.set(reason, entry);
    }

    const thread = threads.get(segment.sessionId) ?? {
      sessionId: segment.sessionId,
      parentSessionId: segment.parentSessionId,
      provider: segment.provider,
      model: segment.model,
      turns: 0,
      segments: 0,
      actualUsd: 0,
      sameHarnessUsd: 0,
      anyHarnessUsd: 0,
    };
    thread.turns += segment.turns.length;
    thread.segments += 1;
    thread.actualUsd += segmentUsd;
    thread.sameHarnessUsd += sameUsd;
    thread.anyHarnessUsd += anyUsd;
    threads.set(segment.sessionId, thread);
  }

  const topMoves = (bucket: Map<string, RouterEfficiencyMove>) => [...bucket.values()]
    .sort((a, b) => b.actualUsd - a.actualUsd)
    .slice(0, TOP_LIMIT)
    .map((move) => ({ ...move, actualUsd: cents(move.actualUsd), routedUsd: cents(move.routedUsd) }));

  return {
    threads: threads.size,
    childThreads: [...threads.values()].filter((thread) => thread.parentSessionId).length,
    turns: input.turns.length,
    segments: segments.length,
    segmentsByStart,
    pricedTurns,
    actualUsd: cents(actualUsd),
    sameHarnessUsd: cents(sameHarnessUsd),
    anyHarnessUsd: cents(anyHarnessUsd),
    sameHarnessSaving: share(sameHarnessUsd, actualUsd),
    anyHarnessSaving: share(anyHarnessUsd, actualUsd),
    switchedSegments: switched,
    byBilling: [...billing]
      .sort((a, b) => b[1].actualUsd - a[1].actualUsd || b[1].anyHarnessUsd - a[1].anyHarnessUsd)
      .map(([label, entry]) => {
        const usdPerPercent = entry.plan ? plans.get(entry.plan)?.usdPerPercent ?? null : null;
        const percent = (usd: number): number | null => (usdPerPercent ? Math.round((usd / usdPerPercent) * 100) / 100 : null);
        return {
          billing: label,
          plan: entry.plan,
          actualUsd: cents(entry.actualUsd),
          sameHarnessUsd: cents(entry.sameHarnessUsd),
          anyHarnessUsd: cents(entry.anyHarnessUsd),
          usdPerPercent,
          actualPercent: percent(entry.actualUsd),
          sameHarnessPercent: percent(entry.sameHarnessUsd),
          anyHarnessPercent: percent(entry.anyHarnessUsd),
        };
      }),
    kept: [...kept]
      .sort((a, b) => b[1].actualUsd - a[1].actualUsd)
      .map(([reason, entry]) => ({ reason, ...entry, actualUsd: cents(entry.actualUsd) })),
    topMoves: { sameHarness: topMoves(moves.sameHarness), anyHarness: topMoves(moves.anyHarness) },
    topThreads: [...threads.values()]
      .sort((a, b) => b.actualUsd - a.actualUsd)
      .slice(0, TOP_LIMIT)
      .map((thread) => ({
        ...thread,
        actualUsd: cents(thread.actualUsd),
        sameHarnessUsd: cents(thread.sameHarnessUsd),
        anyHarnessUsd: cents(thread.anyHarnessUsd),
      })),
  };
}

/** One shadow decision and its outcome, as the efficiency report reads them. */
export type SubagentShadowRecord = {
  sameHarnessSaving: number | null;
  anyHarnessSaving: number | null;
  picked: { sameHarness: boolean; anyHarness: boolean };
  outcome: { totalTokens: number | null; costUsd: number | null } | null;
};

export type RouterSubagentEfficiency = {
  decisions: number;
  withOutcome: number;
  sameHarnessPicks: number;
  anyHarnessPicks: number;
  /** Tokens of the finished subagents that reported them. */
  tokens: number;
  /** Saving weighted by each subagent's tokens; a kept route saves nothing. */
  sameHarnessSaving: number | null;
  anyHarnessSaving: number | null;
  /** Subagents whose runtime reported a price (OpenCode today). */
  pricedSubagents: number;
  actualUsd: number;
  sameHarnessUsd: number;
  anyHarnessUsd: number;
};

export function summarizeSubagents(records: readonly SubagentShadowRecord[]): RouterSubagentEfficiency {
  let withOutcome = 0;
  let sameHarnessPicks = 0;
  let anyHarnessPicks = 0;
  let tokens = 0;
  let sameTokens = 0;
  let anyTokens = 0;
  let pricedSubagents = 0;
  let actualUsd = 0;
  let sameHarnessUsd = 0;
  let anyHarnessUsd = 0;
  for (const record of records) {
    if (record.picked.sameHarness) sameHarnessPicks += 1;
    if (record.picked.anyHarness) anyHarnessPicks += 1;
    if (!record.outcome) continue;
    withOutcome += 1;
    const sameKeep = 1 - (record.picked.sameHarness ? record.sameHarnessSaving ?? 0 : 0);
    const anyKeep = 1 - (record.picked.anyHarness ? record.anyHarnessSaving ?? 0 : 0);
    const used = record.outcome.totalTokens;
    if (used != null && used > 0) {
      tokens += used;
      sameTokens += used * sameKeep;
      anyTokens += used * anyKeep;
    }
    const cost = record.outcome.costUsd;
    if (cost != null) {
      pricedSubagents += 1;
      actualUsd += cost;
      sameHarnessUsd += cost * sameKeep;
      anyHarnessUsd += cost * anyKeep;
    }
  }
  return {
    decisions: records.length,
    withOutcome,
    sameHarnessPicks,
    anyHarnessPicks,
    tokens,
    sameHarnessSaving: share(sameTokens, tokens),
    anyHarnessSaving: share(anyTokens, tokens),
    pricedSubagents,
    actualUsd: cents(actualUsd),
    sameHarnessUsd: cents(sameHarnessUsd),
    anyHarnessUsd: cents(anyHarnessUsd),
  };
}
