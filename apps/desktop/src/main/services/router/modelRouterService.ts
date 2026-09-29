/**
 * The model router, in shadow mode.
 *
 * It watches every subagent a chat starts. For each one it decides which route
 * it WOULD have used (routerCore) and writes that next to what actually ran,
 * then adds the outcome when the subagent finishes. It changes nothing: the
 * subagent still runs on the model its parent chose. The log is
 * `<adeHome>/usage/router-shadow-YYYY-MM.jsonl`, one machine-wide file per
 * month, next to the turn ledger it reads.
 *
 * Inputs, all machine-local except the registry:
 * - the model registry (modelRegistryStore): quality, cost, and speed per route;
 * - ADE's model catalog (`getAvailableModels`, passive: it never starts a runtime);
 * - the quota ledger: live plan windows and what a percent of each has cost;
 * - the turn ledger: which models this machine has run enough to trust.
 *
 * `ADE_MODEL_ROUTER_SHADOW=0` turns the watching off. Observation never throws
 * and never blocks the chat: each decision runs after the event returns.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentChatEvent, AgentChatModelInfo, AgentChatProvider } from "../../../shared/types/chat";
import type { AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types/turnUsage";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { estimateQuotaBurnRates } from "../usage/quotaBurnRate";
import type { ModelRegistryStatus, ModelRegistryStore } from "./modelRegistryStore";
import {
  buildModelRoutes,
  registryFamilyForModelId,
  routeHarnessOf,
  type CatalogModel,
  type ModelRoute,
} from "./routeCatalog";
import {
  classifyRouterTask,
  pickRoute,
  planStatesFromBurnRates,
  ROUTER_TRUST_MIN_TURNS,
  trustKey,
  type PlanState,
  type RouterDecision,
  type RouterPick,
  type RouterTaskKind,
} from "./routerCore";

const SHADOW_FILE_PREFIX = "router-shadow-";
const CATALOG_TTL_MS = 10 * 60_000;
const PLANS_TTL_MS = 60_000;
const MAX_PENDING = 500;
/** The catalog harnesses the router covers today. */
const ROUTED_PROVIDERS: AgentChatProvider[] = ["claude", "codex", "opencode", "cursor"];

export type RouterSessionFacts = {
  provider: string;
  model: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

type DecisionSummary = {
  routeId: string;
  score: number | null;
  units: number | null;
  planPercent: number | null;
  savingShare: number | null;
  qualityDelta: number | null;
  blockedReason: string | null;
};

export type RouterShadowDecisionRow = {
  v: 1;
  type: "decision";
  at: string;
  key: string;
  sessionId: string;
  taskId: string;
  kind: RouterTaskKind;
  agentType: string | null;
  description: string;
  reference: DecisionSummary | null;
  sameHarness: DecisionSummary | null;
  anyHarness: DecisionSummary | null;
  keptBecause: string | null;
  registryGeneratedAt: string | null;
  plans: Record<string, { accountId: string | null; pressure: number; blockedReason: string | null; usdPerPercent: number | null; burnConfidence: string }>;
};

export type RouterShadowOutcomeRow = {
  v: 1;
  type: "outcome";
  at: string;
  key: string;
  status: "completed" | "failed" | "stopped";
  durationMs: number | null;
  totalTokens: number | null;
  toolUses: number | null;
  costUsd: number | null;
};

export type RouterShadowSummary = {
  days: number;
  registry: ModelRegistryStatus;
  decisions: number;
  withOutcome: number;
  byKind: Record<string, { decisions: number; sameHarnessPicks: number; anyHarnessPicks: number; meanSameHarnessSaving: number | null; meanAnyHarnessSaving: number | null }>;
  topSameHarnessPicks: Array<{ from: string; to: string; count: number }>;
  topAnyHarnessPicks: Array<{ from: string; to: string; count: number }>;
  keptReasons: Array<{ reason: string; count: number }>;
  outcomes: Record<string, number>;
  plans: Record<string, PlanState>;
};

export type RouterPreviewArgs = {
  description: string;
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  agentType?: string | null;
  kind?: RouterTaskKind;
};

export type RouterRoutesArgs = { provider?: string; limit?: number };

export type ModelRouterService = {
  /** Folds a chat event in. Sync, never throws. */
  observe(sessionId: string, event: AgentChatEvent, session: RouterSessionFacts): void;
  preview(args: RouterPreviewArgs): Promise<RouterPick & { plans: Record<string, PlanState> }>;
  routes(args?: RouterRoutesArgs): Promise<{ registry: ModelRegistryStatus; routes: ModelRoute[] }>;
  shadowSummary(args?: { days?: number }): Promise<RouterShadowSummary>;
  refreshRegistry(options?: { force?: boolean }): Promise<ModelRegistryStatus>;
};

export function createModelRouterService(args: {
  /** `<adeHome>/usage`, shared with the turn ledger. */
  usageDir: string;
  registry: ModelRegistryStore;
  getAvailableModels: (provider: AgentChatProvider) => Promise<AgentChatModelInfo[]>;
  readTurns: (sinceMs: number) => Promise<AdeTurnUsageRecord[]>;
  readQuotaSamples: (sinceMs: number) => Promise<AdeQuotaSample[]>;
  logger?: Pick<Logger, "warn" | "info"> | null;
  nowMs?: () => number;
  enabled?: boolean;
}): ModelRouterService {
  const now = args.nowMs ?? Date.now;
  const enabled = args.enabled ?? process.env.ADE_MODEL_ROUTER_SHADOW !== "0";
  let catalog: { atMs: number; generatedAt: string | null; models: CatalogModel[]; routes: ModelRoute[] } | null = null;
  let catalogLoad: Promise<void> | null = null;
  let plans: { atMs: number; states: Map<string, PlanState>; trusted: Set<string> } | null = null;
  const pending = new Map<string, Promise<void>>();
  let warnedWrite = false;

  const append = (row: RouterShadowDecisionRow | RouterShadowOutcomeRow): void => {
    try {
      fs.mkdirSync(args.usageDir, { recursive: true });
      const month = row.at.slice(0, 7);
      fs.appendFileSync(path.join(args.usageDir, `${SHADOW_FILE_PREFIX}${month}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
    } catch (error) {
      if (!warnedWrite) {
        warnedWrite = true;
        args.logger?.warn("router.shadow_write_failed", { error: getErrorMessage(error) });
      }
    }
  };

  const loadCatalog = async (): Promise<ModelRoute[]> => {
    void args.registry.refresh();
    const snapshot = args.registry.getSnapshot();
    if (!snapshot) return [];
    const fresh = catalog && now() - catalog.atMs < CATALOG_TTL_MS && catalog.generatedAt === snapshot.generatedAt;
    if (fresh) return catalog!.routes;
    catalogLoad ??= (async () => {
      const models: CatalogModel[] = [];
      for (const provider of ROUTED_PROVIDERS) {
        try {
          for (const info of await args.getAvailableModels(provider)) models.push({ provider, info });
        } catch {
          // A provider that cannot list models adds no routes.
        }
      }
      catalog = { atMs: now(), generatedAt: snapshot.generatedAt, models, routes: buildModelRoutes(models, snapshot) };
    })().finally(() => {
      catalogLoad = null;
    });
    await catalogLoad;
    return catalog?.routes ?? [];
  };

  const loadPlans = async (): Promise<{ states: Map<string, PlanState>; trusted: Set<string> }> => {
    if (plans && now() - plans.atMs < PLANS_TTL_MS) return plans;
    const nowMs = now();
    const sinceMs = nowMs - 30 * 86_400_000;
    const [turns, samples] = await Promise.all([args.readTurns(sinceMs), args.readQuotaSamples(sinceMs)]);
    const states = planStatesFromBurnRates(estimateQuotaBurnRates({ samples, turns, nowMs, lookbackMs: 30 * 86_400_000 }), nowMs);
    const counts = new Map<string, number>();
    for (const turn of turns) {
      const harness = routeHarnessOf(turn.provider);
      const model = turn.servedModel ?? turn.requestedModel;
      if (!harness || !model) continue;
      const key = trustKey({ harness, modelId: model });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const trusted = new Set([...counts].filter(([, count]) => count >= ROUTER_TRUST_MIN_TURNS).map(([key]) => key));
    plans = { atMs: nowMs, states, trusted };
    return plans;
  };

  /**
   * The route a task would run on anyway. Claude subagents name a model by
   * alias (`opus`, `sonnet`, `haiku`) or leave it to the parent (`inherit`).
   */
  const referenceRoute = (routes: readonly ModelRoute[], harness: string, model: string | null, effort: string | null): ModelRoute | null => {
    if (!model) return null;
    const inHarness = routes.filter((route) => route.harness === harness);
    const alias = model.toLowerCase();
    const family = ["opus", "sonnet", "haiku", "fable"].includes(alias)
      ? registryFamilyForModelId(inHarness.find((route) => route.modelId.toLowerCase().includes(alias))?.modelId ?? model)
      : registryFamilyForModelId(model);
    const sameFamily = inHarness.filter((route) => registryFamilyForModelId(route.modelId) === family);
    if (!sameFamily.length) return null;
    return sameFamily.find((route) => route.effort === effort)
      ?? sameFamily.find((route) => route.effort === "high")
      ?? sameFamily.find((route) => route.effort === null)
      ?? sameFamily[0]!;
  };

  const summarize = (item: RouterDecision | null): DecisionSummary | null => item && {
    routeId: item.route.id,
    score: item.route.quality.score != null ? Math.round(item.route.quality.score * 1000) / 1000 : null,
    units: item.cost.units != null ? Math.round(item.cost.units * 10_000) / 10_000 : null,
    planPercent: item.cost.planPercent != null ? Math.round(item.cost.planPercent * 10_000) / 10_000 : null,
    savingShare: item.savingShare != null ? Math.round(item.savingShare * 1000) / 1000 : null,
    qualityDelta: item.qualityDelta != null ? Math.round(item.qualityDelta * 1000) / 1000 : null,
    blockedReason: item.cost.blockedReason,
  };

  const decide = async (input: {
    description: string;
    agentType: string | null;
    harness: string;
    model: string | null;
    effort: string | null;
    kind?: RouterTaskKind;
  }): Promise<{ pick: RouterPick; states: Map<string, PlanState> }> => {
    const [routes, planInfo] = await Promise.all([loadCatalog(), loadPlans()]);
    const kind = input.kind ?? classifyRouterTask(input.description, input.agentType);
    const reference = referenceRoute(routes, input.harness, input.model, input.effort);
    return {
      pick: pickRoute({ routes, reference, kind, plans: planInfo.states, trusted: planInfo.trusted }),
      states: planInfo.states,
    };
  };

  const onSubagentStarted = (sessionId: string, event: Extract<AgentChatEvent, { type: "subagent_started" }>, session: RouterSessionFacts): void => {
    if (event.resumed) return;
    if (event.taskType && event.taskType !== "subagent") return;
    const key = `${sessionId}:${event.taskId}`;
    if (pending.has(key)) return;
    const harness = event.provider ?? session.provider;
    const inherits = !event.model || event.model === "inherit";
    const model = inherits ? session.modelId ?? session.model : event.model!;
    const effort = event.reasoningEffort ?? (inherits ? session.reasoningEffort ?? null : null);
    const work = decide({ description: event.description ?? "", agentType: event.agentType ?? null, harness, model, effort })
      .then(({ pick, states }) => {
        append({
          v: 1,
          type: "decision",
          at: new Date(now()).toISOString(),
          key,
          sessionId,
          taskId: event.taskId,
          kind: pick.kind,
          agentType: event.agentType ?? null,
          description: (event.description ?? "").slice(0, 240),
          reference: summarize(pick.reference),
          sameHarness: summarize(pick.sameHarness),
          anyHarness: summarize(pick.anyHarness),
          keptBecause: pick.keptBecause,
          registryGeneratedAt: args.registry.getSnapshot()?.generatedAt ?? null,
          plans: Object.fromEntries([...states].map(([plan, state]) => [plan, {
            accountId: state.accountId,
            pressure: Math.round(state.pressure * 100) / 100,
            blockedReason: state.blockedReason,
            usdPerPercent: state.usdPerPercent,
            burnConfidence: state.burnConfidence,
          }])),
        });
      })
      .catch((error: unknown) => {
        args.logger?.info("router.shadow_decision_failed", { error: getErrorMessage(error) });
      });
    pending.set(key, work);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  };

  const onSubagentResult = (sessionId: string, event: Extract<AgentChatEvent, { type: "subagent_result" }>): void => {
    const key = `${sessionId}:${event.taskId}`;
    const decisionWritten = pending.get(key);
    if (!decisionWritten) return;
    pending.delete(key);
    const usage = event.usage;
    void decisionWritten.then(() => append({
      v: 1,
      type: "outcome",
      at: new Date(now()).toISOString(),
      key,
      status: event.status,
      durationMs: usage?.durationMs ?? null,
      totalTokens: usage?.totalTokens ?? event.totalTokens ?? null,
      toolUses: usage?.toolUses ?? event.toolUseCount ?? null,
      costUsd: usage?.costUsd ?? null,
    }));
  };

  const readShadowRows = async (sinceMs: number): Promise<Array<RouterShadowDecisionRow | RouterShadowOutcomeRow>> => {
    const rows: Array<RouterShadowDecisionRow | RouterShadowOutcomeRow> = [];
    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(args.usageDir)).filter((name) => name.startsWith(SHADOW_FILE_PREFIX)).sort();
    } catch {
      return rows;
    }
    const sinceMonth = new Date(sinceMs).toISOString().slice(0, 7);
    for (const file of files) {
      if (file.slice(SHADOW_FILE_PREFIX.length, SHADOW_FILE_PREFIX.length + 7) < sinceMonth) continue;
      let text = "";
      try {
        text = await fs.promises.readFile(path.join(args.usageDir, file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as RouterShadowDecisionRow | RouterShadowOutcomeRow;
          if (Date.parse(row.at) >= sinceMs) rows.push(row);
        } catch {
          // A torn line from a crash is skipped.
        }
      }
    }
    return rows;
  };

  return {
    observe(sessionId, event, session) {
      if (!enabled) return;
      try {
        if (event.type === "subagent_started") onSubagentStarted(sessionId, event, session);
        else if (event.type === "subagent_result") onSubagentResult(sessionId, event);
      } catch {
        // Shadow routing is advisory; it must never reach the chat.
      }
    },

    async preview(input) {
      const { pick, states } = await decide({
        description: input.description,
        agentType: input.agentType ?? null,
        harness: input.provider,
        model: input.model,
        effort: input.reasoningEffort ?? null,
        kind: input.kind,
      });
      return { ...pick, plans: Object.fromEntries(states) };
    },

    async routes(input = {}) {
      await args.registry.refresh();
      const routes = await loadCatalog();
      const filtered = input.provider ? routes.filter((route) => route.harness === input.provider) : routes;
      const sorted = [...filtered].sort((a, b) => (b.quality.score ?? -1) - (a.quality.score ?? -1));
      return { registry: args.registry.status(), routes: input.limit ? sorted.slice(0, input.limit) : sorted };
    },

    async shadowSummary(input = {}) {
      const days = Math.max(1, Math.min(90, Math.floor(input.days ?? 7)));
      const rows = await readShadowRows(now() - days * 86_400_000);
      const decisions = rows.filter((row): row is RouterShadowDecisionRow => row.type === "decision");
      const outcomes = new Map(rows.filter((row): row is RouterShadowOutcomeRow => row.type === "outcome").map((row) => [row.key, row]));
      const byKind: RouterShadowSummary["byKind"] = {};
      const sameMoves = new Map<string, number>();
      const anyMoves = new Map<string, number>();
      const kept = new Map<string, number>();
      const savings: Record<string, { same: number[]; any: number[] }> = {};
      for (const row of decisions) {
        const bucket = byKind[row.kind] ??= { decisions: 0, sameHarnessPicks: 0, anyHarnessPicks: 0, meanSameHarnessSaving: null, meanAnyHarnessSaving: null };
        const saved = savings[row.kind] ??= { same: [], any: [] };
        bucket.decisions += 1;
        const from = row.reference?.routeId ?? "(not in catalog)";
        if (row.sameHarness) {
          bucket.sameHarnessPicks += 1;
          const move = `${from} → ${row.sameHarness.routeId}`;
          sameMoves.set(move, (sameMoves.get(move) ?? 0) + 1);
          if (row.sameHarness.savingShare != null) saved.same.push(row.sameHarness.savingShare);
        }
        if (row.anyHarness) {
          bucket.anyHarnessPicks += 1;
          const move = `${from} → ${row.anyHarness.routeId}`;
          anyMoves.set(move, (anyMoves.get(move) ?? 0) + 1);
          if (row.anyHarness.savingShare != null) saved.any.push(row.anyHarness.savingShare);
        }
        if (row.keptBecause) kept.set(row.keptBecause, (kept.get(row.keptBecause) ?? 0) + 1);
      }
      const mean = (values: number[]): number | null => values.length
        ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000
        : null;
      for (const [kind, bucket] of Object.entries(byKind)) {
        bucket.meanSameHarnessSaving = mean(savings[kind]!.same);
        bucket.meanAnyHarnessSaving = mean(savings[kind]!.any);
      }
      const top = (moves: Map<string, number>) => [...moves]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([move, count]) => {
          const [from, to] = move.split(" → ");
          return { from: from!, to: to!, count };
        });
      const outcomeCounts: Record<string, number> = {};
      for (const row of decisions) {
        const status = outcomes.get(row.key)?.status ?? "open";
        outcomeCounts[status] = (outcomeCounts[status] ?? 0) + 1;
      }
      const planInfo = await loadPlans();
      return {
        days,
        registry: args.registry.status(),
        decisions: decisions.length,
        withOutcome: decisions.filter((row) => outcomes.has(row.key)).length,
        byKind,
        topSameHarnessPicks: top(sameMoves),
        topAnyHarnessPicks: top(anyMoves),
        keptReasons: [...kept].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
        outcomes: outcomeCounts,
        plans: Object.fromEntries(planInfo.states),
      };
    },

    refreshRegistry(options) {
      return args.registry.refresh(options);
    },
  };
}

type ModelSource = (provider: AgentChatProvider) => Promise<AgentChatModelInfo[]>;

type SharedRouter = { service: ModelRouterService; sources: ModelSource[] };
const sharedRouters = new Map<string, SharedRouter>();

/**
 * One router per ADE home, like the turn ledger: every project scope in a
 * brain feeds the same shadow log. Each scope lends its chat service's model
 * catalog; the newest scope's catalog answers. The returned function detaches
 * the scope's catalog.
 */
export function attachSharedModelRouter(args: {
  adeDir: string;
  modelSource: ModelSource;
  create: (getAvailableModels: ModelSource) => ModelRouterService;
}): { service: ModelRouterService; detach: () => void } {
  const key = path.resolve(args.adeDir);
  let shared = sharedRouters.get(key);
  if (!shared) {
    const sources: ModelSource[] = [];
    const getAvailableModels: ModelSource = async (provider) => {
      const source = sources[sources.length - 1];
      return source ? source(provider) : [];
    };
    shared = { service: args.create(getAvailableModels), sources };
    sharedRouters.set(key, shared);
  }
  const current = shared;
  current.sources.push(args.modelSource);
  return {
    service: current.service,
    detach: () => {
      const index = current.sources.lastIndexOf(args.modelSource);
      if (index >= 0) current.sources.splice(index, 1);
    },
  };
}
