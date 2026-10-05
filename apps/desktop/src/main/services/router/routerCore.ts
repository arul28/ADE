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
 *   (`usdPerPercent`), so a task's list-price cost converts to plan percent,
 *   and the percent to dollars of the plan's own price (`planPercentUsd`).
 *   That is then weighted by pressure: how fast the window is being
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
 * What each plan costs a month, to price a percent of its window in dollars.
 * An assumption, not a fact: the common top tier of each plan (Claude Max,
 * ChatGPT Pro, Cursor Pro, OpenCode Go). It matters only when plans compete
 * with each other or with metered routes. One flat value for every plan made
 * a percent of a $10 monthly plan cost the same as a percent of a $200 weekly
 * one, so the router moved DeepSeek work on OpenCode Go onto Claude.
 */
/** The plans the router prices. */
const ROUTER_PLANS = ["claude", "codex", "cursor", "opencode-go"] as const;

export const ROUTER_PLAN_MONTHLY_USD: Record<string, number> = {
  claude: 200,
  codex: 200,
  cursor: 20,
  "opencode-go": 10,
};
/** The value of a percent when the plan or its window is unknown: a $200 plan's weekly percent. */
const FALLBACK_PERCENT_USD = 200 / (100 * (30 / 7));

/** Dollars one percent of the plan's burn-rate window is worth. */
export function planPercentUsd(state: Pick<PlanState, "plan" | "rateWindow">): number {
  const monthly = ROUTER_PLAN_MONTHLY_USD[state.plan];
  const windowMs = state.rateWindow ? WINDOW_MS[state.rateWindow] : undefined;
  if (monthly == null || !windowMs) return FALLBACK_PERCENT_USD;
  const windowsPerMonth = MONTH_MS / windowMs;
  return monthly / (100 * windowsPerMonth);
}
/** A window at or above this share used blocks its plan. */
const WINDOW_BLOCK_SHARE = 0.95;

const MONTH_MS = 30 * 86_400_000;
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: MONTH_MS,
};

const EDIT_WORDS = /\b(fix(es)?|implement|edit|write|refactor|add|change|update|build|create|migrate|rename|remove|delete|port|wire|patch|apply|split|extract|move|replace|convert|upgrade|bump|redesign|polish)\b/i;
const HEAVY_WORDS = /\b(implement|build|refactor|migrate|rewrite|feature|port|redesign|overhaul|phase|stage|unit \d|end-to-end)\b/i;
const READ_WORDS = /\b(research|investigate|find|search|read|explore|summari[sz]e|look (up|into|at)|map|trace|explain|inventory|survey|locate|list|scan|understand|analy[sz]e|classify|compare|diagnose|study|document|catalog(ue)?)\b/i;
const REVIEW_WORDS = /\b(re-?review|review(er)?|audit|verify|verification|check|critique|second opinion|assess|findings|track [abc]|correctness|maintainability|conformance)\b/i;
const TEST_WORDS = /\b(run (the )?(tests?|suite|ci)|typecheck|lint|test shard|flaky|ci shard|reproduce)\b/i;
/**
 * A brief that forbids all edits: the strongest signal a prompt carries. A
 * scoped ban ("do not edit anything under apps/ios", "never touch the owner's
 * machines") is an edit brief with a fence, so the object must be every file.
 */
const NO_EDIT_BAN = /\b(report[- ]only|research (task )?only|review only|you (only )?(review|report)|return (the )?findings|no edits|do not (build|generate) anything)|\b(do not|don't|never|must not)\s+(edit|modify|change|write)\s+(any\s+)?(repository\s+)?(files?|code|anything)\b(?!\s+(under|outside|in|beyond|other|except))/i;
/** "Read-only research", "read-only:": a no-edit rule, but often about one step ("start by doing read-only analysis"). */
const READ_ONLY_PHRASE = /(?<!\b(doing|by|with)\s)\bread[- ]only\s*(research|investigation|review|re-review|task|analysis|audit|forensics?|[:;—(])/i;
/** "Read-only" in a brief's opening lines is a whole-task rule; later it is about one command or file. */
const OPENING_READ_ONLY = /^[\s\S]{0,160}(?<!\b(doing|by|with)\s)\bread[- ]only\b/i;
const OPENING_READ_ONLY_WORD = /(?<!\b(doing|by|with)\s)\bread[- ]only\b/i;
/** Boilerplate every ADE brief carries; it says nothing about the task. */
const BRIEF_BOILERPLATE = /do not start subagents or parallel reviewers; do all the work yourself\.?/gi;
/** "Read /tmp/brief.md and follow it": an instruction to load the brief, not a read task. */
const READ_THE_BRIEF = /\bread\s+(the\s+(file\s+)?)?[\w./~-]+\.(md|txt|prompt)\b/gi;

/** Opening clauses that hand a worker code to change. */
const EDIT_BRIEF_WORDS = /\b(you\s+(are\s+)?(implement(ing)?|apply(ing)?|fix(ing)?|build(ing)?|writ(e|ing)|port(ing)?|refactor(ing)?|add(ing)?|own|updat(e|ing)|the\s+\w+\s+implementer)|implementer\b|implement\s+(the|a|an|part|unit|phase|stage)|apply\s+(the\s+|these\s+|verified\s+|final\s+)?(\/quality\s+)?(fix|finding|change|delta)|edit\s+(only|files only)|work\s+only\s+in|your\s+edits|allowlist|leave changes uncommitted)/i;
/** An imperative edit verb that opens a sentence: "Fix …", "Task: write …". */
const OPENING_EDIT_VERB = /(^|[.:!]\s+)(fix|implement|write|add|build|apply|port|refactor|update|rewrite|remove|migrate|redesign|create)\b/i;
const LIGHT_EDIT_WORDS = /\b(docs?|documentation|logging|tests?|rename|typo|copy)\b/i;

/** Where a kind came from, recorded so the shadow log can be audited. */
export type RouterTaskKindSource = "agent_type" | "prompt" | "description" | "none";

/**
 * A task's kind from its agent type, the short label the parent gave it, and
 * the brief itself. The label alone ("Quality Track A correctness") says too
 * little: the brief states whether the worker may edit, which is what decides
 * how far its quality may drop. Keyword rules; unknown when nothing matches.
 */
export function classifyRouterTaskDetailed(
  description: string,
  agentType?: string | null,
  prompt?: string | null,
): { kind: RouterTaskKind; source: RouterTaskKindSource } {
  const type = agentType?.toLowerCase() ?? "";
  if (type === "explore" || type.includes("search") || type.includes("research")) return { kind: "read_only", source: "agent_type" };
  if (type.includes("review") || type.includes("verif") || type.includes("audit")) return { kind: "review", source: "agent_type" };
  const label = description.slice(0, 300);
  const brief = (prompt ?? "").replace(BRIEF_BOILERPLATE, "").trim().slice(0, 4_000);
  const head = brief.slice(0, 1_500);
  const opening = brief.slice(0, 250);
  const labelVerb = /^\W*([a-z-]+)/i.exec(label)?.[1] ?? "";
  const editKind = (): RouterTaskKind => {
    const heavy = !LIGHT_EDIT_WORDS.test(label) && (HEAVY_WORDS.test(label) || (HEAVY_WORDS.test(head) && brief.length >= 4_000));
    return heavy ? "heavy_edit" : "light_edit";
  };
  // Precedence, first match wins:
  // 1. An edit clause in the opening 250 characters, when it comes before any
  //    no-edit rule ("Task: write read-only log extractors" is an edit, and
  //    "READ-ONLY: … Work only in the worktree" is not).
  // 2. A ban on every edit, or "read-only" in the opening lines.
  // 3. The label's own verb ("Fix …").
  // 4. A "read-only research/analysis" phrase anywhere in the head.
  // 5. An edit clause anywhere in the head ("…, then apply the fix").
  const editAt = firstIndex(opening, [EDIT_BRIEF_WORDS, OPENING_EDIT_VERB]);
  const noEditAt = firstIndex(head, [NO_EDIT_BAN, READ_ONLY_PHRASE, OPENING_READ_ONLY_WORD]);
  const noEditKind = (): RouterTaskKind => (REVIEW_WORDS.test(label) || REVIEW_WORDS.test(head) ? "review" : "read_only");
  const readOnlyOpening = OPENING_READ_ONLY.test(head);
  if (brief && editAt != null && (noEditAt == null || editAt < noEditAt)) return { kind: editKind(), source: "prompt" };
  if (brief && (NO_EDIT_BAN.test(head) || readOnlyOpening)) return { kind: noEditKind(), source: "prompt" };
  if (EDIT_WORDS.test(labelVerb)) return { kind: editKind(), source: "description" };
  if (brief && READ_ONLY_PHRASE.test(head)) return { kind: noEditKind(), source: "prompt" };
  if (brief && EDIT_BRIEF_WORDS.test(head)) return { kind: editKind(), source: "prompt" };
  const fromLabel = classifyText(label);
  if (fromLabel !== "unknown") return { kind: fromLabel, source: "description" };
  if (brief) {
    const fromBrief = classifyText(head.replace(READ_THE_BRIEF, ""));
    if (fromBrief !== "unknown") return { kind: fromBrief, source: "prompt" };
  }
  // A workflow agent is named for its job (`/root/quality_correctness`).
  const fromType = type.includes("/") || type.includes("_") ? classifyText(type.replace(/[/_-]+/g, " ").trim()) : "unknown";
  if (fromType !== "unknown") return { kind: fromType, source: "agent_type" };
  return { kind: "unknown", source: "none" };
}

/** Keyword rules over one short text. The first word decides a tie: a label is an imperative. */
function classifyText(text: string): RouterTaskKind {
  const firstWord = /^\W*([a-z-]+)/i.exec(text)?.[1] ?? "";
  const edits = EDIT_WORDS.test(text);
  if (REVIEW_WORDS.test(firstWord)) return "review";
  // "Read the file and fix the parser" is an edit that starts by reading.
  if (READ_WORDS.test(firstWord) && !edits) return "read_only";
  if (TEST_WORDS.test(text) && !HEAVY_WORDS.test(text)) return "test_run";
  if (EDIT_WORDS.test(firstWord)) return HEAVY_WORDS.test(text) ? "heavy_edit" : "light_edit";
  if (REVIEW_WORDS.test(text)) return "review";
  if (READ_WORDS.test(text) && !edits) return "read_only";
  if (edits) return HEAVY_WORDS.test(text) ? "heavy_edit" : "light_edit";
  return "unknown";
}

/** Where the earliest of the patterns matches, or null when none does. */
function firstIndex(text: string, patterns: readonly RegExp[]): number | null {
  let first: number | null = null;
  for (const pattern of patterns) {
    const at = pattern.exec(text)?.index;
    if (at != null && (first == null || at < first)) first = at;
  }
  return first;
}

/** A task's kind; see `classifyRouterTaskDetailed`. */
export function classifyRouterTask(description: string, agentType?: string | null, prompt?: string | null): RouterTaskKind {
  return classifyRouterTaskDetailed(description, agentType, prompt).kind;
}

export type PlanState = {
  plan: string;
  /** The account the router would draw on: the one with the most headroom. */
  accountId: string | null;
  /** List-price dollars per percent of the plan's longest known window. */
  usdPerPercent: number | null;
  /** The window `usdPerPercent` is measured on (`weekly`, `monthly`). */
  rateWindow: string | null;
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
export function quotaProviderForPlan(plan: string): string {
  return plan === "opencode-go" ? "opencode" : plan;
}

function accountState(plan: string, accountId: string, windows: readonly AdeQuotaBurnRate[], nowMs: number): PlanState {
  let pressure = 1;
  let blockedReason: string | null = null;
  let usdPerPercent: number | null = null;
  let rateWindow: string | null = null;
  let burnConfidence: AdeQuotaBurnRate["confidence"] = "none";
  let longest = 0;
  for (const window of windows) {
    const duration = WINDOW_MS[window.windowType];
    const used = window.latestPercentUsed != null ? window.latestPercentUsed / 100 : null;
    const resetsInMs = window.latestResetsAt ? Date.parse(window.latestResetsAt) - nowMs : null;
    if (duration && window.usdPerPercent != null && window.confidence !== "none" && duration > longest) {
      longest = duration;
      usdPerPercent = window.usdPerPercent;
      rateWindow = window.windowType;
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
    rateWindow,
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
 * Each plan account's own state, by account id. An account with no burn rate
 * yet borrows one from another account of the same plan.
 */
export function accountStatesFromBurnRates(rates: readonly AdeQuotaBurnRate[], nowMs: number): Map<string, PlanState> {
  const states = new Map<string, PlanState>();
  for (const plan of ROUTER_PLANS) {
    const byAccount = new Map<string, AdeQuotaBurnRate[]>();
    for (const rate of rates) {
      if (rate.provider !== quotaProviderForPlan(plan)) continue;
      const list = byAccount.get(rate.accountId) ?? [];
      list.push(rate);
      byAccount.set(rate.accountId, list);
    }
    const accounts = [...byAccount].map(([accountId, windows]) => [accountId, accountState(plan, accountId, windows, nowMs)] as const);
    const shared = accounts.find(([, state]) => state.usdPerPercent != null)?.[1];
    for (const [accountId, state] of accounts) {
      if (state.usdPerPercent == null && shared) {
        state.usdPerPercent = shared.usdPerPercent;
        state.rateWindow = shared.rateWindow;
        state.burnConfidence = shared.burnConfidence;
      }
      states.set(accountId, state);
    }
  }
  return states;
}

/**
 * The live state of each plan. A plan with several accounts is as good as its
 * best account: unblocked first, then the lowest pressure.
 */
export function planStatesFromAccountStates(accounts: ReadonlyMap<string, PlanState>): Map<string, PlanState> {
  const states = new Map<string, PlanState>();
  for (const plan of ROUTER_PLANS) {
    const own = [...accounts.values()]
      .filter((state) => state.plan === plan)
      .sort((a, b) => Number(Boolean(a.blockedReason)) - Number(Boolean(b.blockedReason)) || a.pressure - b.pressure);
    states.set(plan, own[0] ?? { plan, accountId: null, usdPerPercent: null, rateWindow: null, burnConfidence: "none", pressure: 1, blockedReason: null, windows: [] });
  }
  return states;
}

/** The live state of each plan, from the quota ledger's burn rates. */
export function planStatesFromBurnRates(rates: readonly AdeQuotaBurnRate[], nowMs: number): Map<string, PlanState> {
  return planStatesFromAccountStates(accountStatesFromBurnRates(rates, nowMs));
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
    units: planPercent * planPercentUsd(state) * state.pressure,
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
  /**
   * Best route on the reference's own model: only the effort changes. The
   * safest switch: same harness, same plan, same prompt cache family.
   */
  sameModel: RouterDecision | null;
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
  const keep = (why: string): RouterPick => ({ kind: input.kind, reference: refDecision, sameModel: null, sameHarness: null, anyHarness: null, keptBecause: why });
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
  const sameModel = better(cheapest(candidates.filter((item) => item.route.harness === ref.harness && item.route.modelId === ref.modelId)));
  const sameHarness = better(cheapest(candidates.filter((item) => item.route.harness === ref.harness)));
  const anyHarness = better(cheapest(candidates));
  return {
    kind: input.kind,
    reference: refDecision,
    sameModel,
    sameHarness,
    anyHarness,
    keptBecause: sameHarness || anyHarness
      ? null
      : refUnits == null
        ? refDecision.cost.note ?? "the task's route has no price"
        : "no cheaper trusted route keeps the quality",
  };
}
