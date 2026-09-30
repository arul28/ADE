/**
 * The router's decision: which route should run a task.
 *
 * Inputs: the rated routes (routeCatalog), the task, the route the task would
 * run on anyway (the reference), the live plan windows, and which models this
 * machine has run enough to trust. Output: the cheapest route that keeps the
 * expected quality within the task kind's tolerance and is not much slower.
 *
 * Cost is priced in the currency of each route's billing:
 * - A plan route costs a share of the plan. ADE's quota ledger knows what one
 *   percent of each plan window has cost in list-price dollars
 *   (`usdPerPercent`), so a task's list-price cost converts to plan percent.
 *   The percent is then weighted by pressure: how fast the window is being
 *   used against how much of it has passed. A window close to its limit
 *   blocks its plan's routes.
 * - A metered route costs its dollars.
 * - A free route costs nothing, and is offered only when trusted.
 *
 * Pure: no I/O, no clock reads; `nowMs` comes in.
 */
import type { AdeQuotaBurnRate } from "../../../shared/types/turnUsage";
import type { ModelRoute, RouteBilling } from "./routeCatalog";
import { registryFamilyForModelId } from "./routeCatalog";

/**
 * `lead` is a main chat thread: it plans, delegates, and edits, so it keeps
 * the strictest tolerance. The keyword classifier never returns it.
 */
export type RouterTaskKind = "read_only" | "review" | "test_run" | "light_edit" | "heavy_edit" | "lead" | "unknown";

/** How far below the reference's expected score a kind may go, on the 0 to 1 agent scale. */
export const ROUTER_QUALITY_TOLERANCE: Record<RouterTaskKind, number> = {
  read_only: 0.1,
  test_run: 0.1,
  review: 0.05,
  light_edit: 0.05,
  heavy_edit: 0.02,
  lead: 0.02,
  unknown: 0.02,
};

/** A route may take at most this many times the reference's time per task. */
export const ROUTER_MAX_SLOWDOWN = 1.5;
/** Own turns on a model before the router trusts a route it has never run. */
export const ROUTER_TRUST_MIN_TURNS = 30;
/**
 * What one percent of a weekly plan is worth in dollars when converting plan
 * percent to a common unit. An assumption, not a fact: about a $200/month plan.
 * It only matters when plans compete with metered routes.
 */
export const ROUTER_PLAN_PERCENT_USD = 0.5;
/** A window at or above this share used blocks its plan. */
const WINDOW_BLOCK_SHARE = 0.95;

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

const EDIT_WORDS = /\b(fix|implement|edit|write|refactor|add|change|update|build|create|migrate|rename|remove|delete|port|wire|patch|apply)\b/i;
const HEAVY_WORDS = /\b(implement|build|refactor|migrate|rewrite|feature|port|redesign|overhaul|phase)\b/i;
const READ_WORDS = /\b(research|investigate|find|search|read|explore|summari[sz]e|look (up|into|at)|map|trace|explain|inventory|survey|locate|list|scan|understand|analy[sz]e)\b/i;
const REVIEW_WORDS = /\b(review|audit|verify|check|critique|second opinion|assess)\b/i;
const TEST_WORDS = /\b(run (the )?(tests?|suite|ci)|typecheck|lint|test shard|flaky)\b/i;

/** A task's kind from its description and agent type. Keyword rules; unknown when nothing matches. */
export function classifyRouterTask(description: string, agentType?: string | null): RouterTaskKind {
  const type = agentType?.toLowerCase() ?? "";
  if (type === "explore" || type.includes("search") || type.includes("research")) return "read_only";
  if (type.includes("review") || type.includes("verif")) return "review";
  const text = description.slice(0, 2_000);
  const edits = EDIT_WORDS.test(text);
  if (TEST_WORDS.test(text) && !HEAVY_WORDS.test(text)) return "test_run";
  if (REVIEW_WORDS.test(text) && !edits) return "review";
  if (READ_WORDS.test(text) && !edits) return "read_only";
  if (edits) return HEAVY_WORDS.test(text) ? "heavy_edit" : "light_edit";
  return "unknown";
}

export type PlanState = {
  plan: string;
  /** The account the router would draw on: the one with the most headroom. */
  accountId: string | null;
  /** List-price dollars per percent of the plan's longest known window. */
  usdPerPercent: number | null;
  /**
   * How much quota movement the burn rate rests on. The rate counts ADE turns
   * only, so use of the same plan outside ADE makes the plan look dearer than
   * it is; a pick moves to ANOTHER plan only when both rates are at least
   * `medium`.
   */
  burnConfidence: AdeQuotaBurnRate["confidence"];
  /** Window used faster than time passing (above 1) or slower (below 1). */
  pressure: number;
  blockedReason: string | null;
  windows: Array<{ windowType: string; percentUsed: number | null; resetsAt: string | null }>;
};

/** Quota providers are named after the harness; OpenCode's windows are the Go plan's. */
function quotaProviderForPlan(plan: string): string {
  return plan === "opencode-go" ? "opencode" : plan;
}

function accountState(plan: string, accountId: string, windows: readonly AdeQuotaBurnRate[], nowMs: number): PlanState {
  let pressure = 1;
  let blockedReason: string | null = null;
  let usdPerPercent: number | null = null;
  let burnConfidence: AdeQuotaBurnRate["confidence"] = "none";
  let longest = 0;
  for (const window of windows) {
    const duration = WINDOW_MS[window.windowType];
    const used = window.latestPercentUsed != null ? window.latestPercentUsed / 100 : null;
    const resetsInMs = window.latestResetsAt ? Date.parse(window.latestResetsAt) - nowMs : null;
    if (duration && window.usdPerPercent != null && window.confidence !== "none" && duration > longest) {
      longest = duration;
      usdPerPercent = window.usdPerPercent;
      burnConfidence = window.confidence;
    }
    if (used == null || !duration || resetsInMs == null || resetsInMs <= 0) continue;
    // A short window that resets soon is only a wait, not a price.
    if (used >= WINDOW_BLOCK_SHARE && !(window.windowType === "five_hour" && resetsInMs < 20 * 60_000)) {
      blockedReason = `${plan} ${window.windowType} window is ${Math.round(used * 100)}% used`;
    }
    if (window.windowType === "five_hour") continue;
    const elapsed = Math.max(0.05, 1 - resetsInMs / duration);
    pressure = Math.max(pressure, Math.min(4, Math.max(0.25, used / elapsed)));
  }
  return {
    plan,
    accountId,
    usdPerPercent,
    burnConfidence,
    pressure,
    blockedReason,
    windows: windows.map((window) => ({
      windowType: window.windowType,
      percentUsed: window.latestPercentUsed,
      resetsAt: window.latestResetsAt,
    })),
  };
}

/**
 * The live state of each plan, from the quota ledger's burn rates. A plan with
 * several accounts is as good as its best account: unblocked first, then the
 * lowest pressure. A burn rate learned on one account stands in for another
 * account of the same plan that has none yet.
 */
export function planStatesFromBurnRates(rates: readonly AdeQuotaBurnRate[], nowMs: number): Map<string, PlanState> {
  const states = new Map<string, PlanState>();
  for (const plan of ["claude", "codex", "cursor", "opencode-go"]) {
    const byAccount = new Map<string, AdeQuotaBurnRate[]>();
    for (const rate of rates) {
      if (rate.provider !== quotaProviderForPlan(plan)) continue;
      const list = byAccount.get(rate.accountId) ?? [];
      list.push(rate);
      byAccount.set(rate.accountId, list);
    }
    const accounts = [...byAccount].map(([accountId, windows]) => accountState(plan, accountId, windows, nowMs));
    const shared = accounts.find((state) => state.usdPerPercent != null);
    for (const state of accounts) {
      if (state.usdPerPercent != null || !shared) continue;
      state.usdPerPercent = shared.usdPerPercent;
      state.burnConfidence = shared.burnConfidence;
    }
    accounts.sort((a, b) => Number(Boolean(a.blockedReason)) - Number(Boolean(b.blockedReason)) || a.pressure - b.pressure);
    states.set(plan, accounts[0] ?? { plan, accountId: null, usdPerPercent: null, burnConfidence: "none", pressure: 1, blockedReason: null, windows: [] });
  }
  return states;
}

export type RouteCost = {
  /** Comparable cost of one AA index task on this route; null when it cannot be priced yet. */
  units: number | null;
  /** Plan percent one index task would use, for plan routes with a burn rate. */
  planPercent: number | null;
  blockedReason: string | null;
  note: string | null;
};

export function routeCost(route: ModelRoute, plans: ReadonlyMap<string, PlanState>): RouteCost {
  const usd = route.costPerIndexTaskUsd;
  if (route.billing.kind === "free") return { units: 0, planPercent: null, blockedReason: null, note: "free" };
  if (usd == null) return { units: null, planPercent: null, blockedReason: null, note: "no public cost data" };
  if (route.billing.kind === "metered") return { units: usd, planPercent: null, blockedReason: null, note: route.billing.channel };
  const state = plans.get(route.billing.plan);
  if (!state) return { units: null, planPercent: null, blockedReason: null, note: "unknown plan" };
  if (state.usdPerPercent == null) {
    return { units: null, planPercent: null, blockedReason: state.blockedReason, note: `no burn rate for the ${state.plan} plan yet` };
  }
  const planPercent = usd / state.usdPerPercent;
  return {
    units: planPercent * ROUTER_PLAN_PERCENT_USD * state.pressure,
    planPercent,
    blockedReason: state.blockedReason,
    note: state.pressure !== 1 ? `${state.plan} pressure ${state.pressure.toFixed(2)}` : null,
  };
}

export type RouterDecision = {
  route: ModelRoute;
  cost: RouteCost;
  /** 1 − units/reference units; null when the reference has no price. */
  savingShare: number | null;
  qualityDelta: number | null;
};

export type RouterPick = {
  kind: RouterTaskKind;
  reference: RouterDecision | null;
  /** Best route in the reference's harness: what ADE could switch to today. */
  sameHarness: RouterDecision | null;
  /** Best route in any allowed harness. */
  anyHarness: RouterDecision | null;
  /** Why the router kept the reference, when it did. */
  keptBecause: string | null;
};

export type RouterPickInput = {
  routes: readonly ModelRoute[];
  reference: ModelRoute | null;
  kind: RouterTaskKind;
  plans: ReadonlyMap<string, PlanState>;
  /** `harness|family` keys with at least `ROUTER_TRUST_MIN_TURNS` own turns. */
  trusted: ReadonlySet<string>;
  /** Billing kinds a pick may use. Default: plans only. */
  allowBilling?: ReadonlySet<RouteBilling["kind"]>;
};

const SOLID_BURN = new Set<AdeQuotaBurnRate["confidence"]>(["medium", "high"]);

/**
 * Two routes' costs are comparable when they bill the same plan, or when both
 * plans' burn rates are solid. Metered and free routes compare in dollars.
 */
function comparableBilling(a: RouteBilling, b: RouteBilling, plans: ReadonlyMap<string, PlanState>): boolean {
  if (a.kind !== "plan" || b.kind !== "plan" || a.plan === b.plan) return true;
  return SOLID_BURN.has(plans.get(a.plan)?.burnConfidence ?? "none") && SOLID_BURN.has(plans.get(b.plan)?.burnConfidence ?? "none");
}

export function trustKey(route: Pick<ModelRoute, "harness" | "modelId">): string {
  return `${route.harness}|${registryFamilyForModelId(route.modelId)}`;
}

function decision(route: ModelRoute, cost: RouteCost, reference: RouterDecision | null): RouterDecision {
  const refUnits = reference?.cost.units;
  const refScore = reference?.route.quality.score;
  return {
    route,
    cost,
    savingShare: refUnits != null && refUnits > 0 && cost.units != null ? 1 - cost.units / refUnits : null,
    qualityDelta: refScore != null && route.quality.score != null ? route.quality.score - refScore : null,
  };
}

export function pickRoute(input: RouterPickInput): RouterPick {
  const allow = input.allowBilling ?? new Set<RouteBilling["kind"]>(["plan"]);
  const ref = input.reference;
  const refDecision = ref ? decision(ref, routeCost(ref, input.plans), null) : null;
  const keep = (why: string): RouterPick => ({ kind: input.kind, reference: refDecision, sameHarness: null, anyHarness: null, keptBecause: why });
  if (!ref || !refDecision) return keep("the task's model is not in the catalog");
  if (ref.quality.score == null) return keep("no public quality data for the task's model");
  const floor = ref.quality.score - ROUTER_QUALITY_TOLERANCE[input.kind];
  const refSeconds = ref.secondsPerIndexTask;
  const refFamily = trustKey(ref);
  const candidates: RouterDecision[] = [];
  for (const route of input.routes) {
    if (route.id === ref.id) continue;
    if (!allow.has(route.billing.kind)) continue;
    if (route.quality.score == null || route.quality.score < floor) continue;
    const trusted = input.trusted.has(trustKey(route)) || trustKey(route) === refFamily || route.quality.source === "aa_agent_row";
    if (!trusted) continue;
    if (refSeconds != null && route.secondsPerIndexTask != null && route.secondsPerIndexTask > refSeconds * ROUTER_MAX_SLOWDOWN) continue;
    const cost = routeCost(route, input.plans);
    if (cost.units == null || cost.blockedReason) continue;
    if (!comparableBilling(ref.billing, route.billing, input.plans)) continue;
    candidates.push(decision(route, cost, refDecision));
  }
  const cheapest = (list: RouterDecision[]): RouterDecision | null => {
    let best: RouterDecision | null = null;
    for (const item of list) {
      if (!best || item.cost.units! < best.cost.units! || (item.cost.units === best.cost.units && (item.route.quality.score ?? 0) > (best.route.quality.score ?? 0))) {
        best = item;
      }
    }
    return best;
  };
  const refUnits = refDecision.cost.units;
  // Keep the reference unless a candidate is cheaper, or the reference cannot run (blocked plan).
  const better = (item: RouterDecision | null): RouterDecision | null =>
    item && (refDecision.cost.blockedReason || refUnits == null || item.cost.units! < refUnits) ? item : null;
  const sameHarness = better(cheapest(candidates.filter((item) => item.route.harness === ref.harness)));
  const anyHarness = better(cheapest(candidates));
  return {
    kind: input.kind,
    reference: refDecision,
    sameHarness,
    anyHarness,
    keptBecause: sameHarness || anyHarness
      ? null
      : refUnits == null
        ? refDecision.cost.note ?? "the task's route has no price"
        : "no cheaper trusted route keeps the quality",
  };
}
