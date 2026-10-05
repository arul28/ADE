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
  findReferenceRoute,
  routeHarnessOf,
  type CatalogModel,
  type ModelRoute,
} from "./routeCatalog";
import {
  classifyRouterTaskDetailed,
  pickRoute,
  accountStatesFromBurnRates,
  planStatesFromBurnRates,
  ROUTER_TRUST_MIN_TURNS,
  trustKey,
  type PlanState,
  type RouterDecision,
  type RouterPick,
  type RouterTaskKind,
  type RouterTaskKindSource,
} from "./routerCore";
import {
  replayThreads,
  summarizeSubagents,
  type RouterSubagentEfficiency,
  type RouterThreadEfficiency,
} from "./routerEfficiency";

const SHADOW_FILE_PREFIX = "router-shadow-";
const CATALOG_TTL_MS = 10 * 60_000;
const PLANS_TTL_MS = 60_000;
const MAX_PENDING = 500;
/** A subagent with no result after this long is logged without an outcome. */
const PENDING_GIVE_UP_MS = 6 * 3_600_000;
const STALE_SWEEP_MS = 60_000;
/** Briefs kept for classification; only the opening matters. */
const PROMPT_KEEP_CHARS = 4_000;
const MAX_PROMPTS = 200;
/** Tool names whose call starts a native subagent and carries its brief. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
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

/** Where a fact about a subagent came from. `inherited` is the parent chat's value, used until the child reports its own. */
export type RouterFactSource = "reported" | "inherited" | "unknown";

/**
 * What actually ran, as the router saw it. Kept on every row so the log can be
 * audited without the chat transcripts: v1 rows guessed `high` for a Claude
 * subagent that named a model, and nothing in the row showed it.
 */
export type RouterShadowRequested = {
  harness: string;
  model: string | null;
  modelSource: RouterFactSource;
  effort: string | null;
  effortSource: RouterFactSource;
};

/**
 * One subagent's decision. v1 rows were written when the subagent started,
 * before its prompt or effort was known; reports skip them. v2 rows are written
 * when it finishes (or is given up on), with the effort the child reported and
 * the kind read from its brief.
 */
export type RouterShadowDecisionRow = {
  v: 1 | 2;
  type: "decision";
  at: string;
  key: string;
  sessionId: string;
  taskId: string;
  kind: RouterTaskKind;
  agentType: string | null;
  /** v2: where the kind came from. */
  kindSource?: RouterTaskKindSource;
  /** v2: the parent's short label for the task, cut to 160 characters. */
  description?: string;
  /** v2: the brief's length; 0 when the router never saw it. */
  promptChars?: number;
  /** v2: when the subagent started. */
  startedAt?: string;
  /** v2: what ran. */
  requested?: RouterShadowRequested;
  reference: DecisionSummary | null;
  /** v2: the best route on the same model; only the effort differs. */
  sameModel?: DecisionSummary | null;
  sameHarness: DecisionSummary | null;
  anyHarness: DecisionSummary | null;
  keptBecause: string | null;
  registryGeneratedAt: string | null;
  plans: Record<string, { accountId: string | null; pressure: number; blockedReason: string | null; usdPerPercent: number | null; burnConfidence: string }>;
};

export type RouterShadowOutcomeRow = {
  v: 1 | 2;
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
  /** v1 decisions in the window, skipped: they guessed effort and kind (see `RouterShadowDecisionRow`). */
  legacyDecisionsSkipped: number;
  withOutcome: number;
  byKind: Record<string, {
    decisions: number;
    sameModelPicks: number;
    sameHarnessPicks: number;
    anyHarnessPicks: number;
    meanSameModelSaving: number | null;
    meanSameHarnessSaving: number | null;
    meanAnyHarnessSaving: number | null;
  }>;
  /** How each fact was known: counts by source. */
  sources: { kind: Record<string, number>; effort: Record<string, number>; model: Record<string, number> };
  /** What actually ran: `harness|model|effort` with counts. */
  ran: Array<{ route: string; count: number }>;
  topSameModelPicks: Array<{ from: string; to: string; count: number }>;
  topSameHarnessPicks: Array<{ from: string; to: string; count: number }>;
  topAnyHarnessPicks: Array<{ from: string; to: string; count: number }>;
  keptReasons: Array<{ reason: string; count: number }>;
  outcomes: Record<string, number>;
  plans: Record<string, PlanState>;
};

/**
 * What the router would have saved against what really ran: every chat thread
 * in the turn ledger replayed at its free switch points, and every subagent in
 * the shadow log. Dollars are public list prices; savings are estimates from
 * benchmark cost per task, not measured runs.
 */
export type RouterEfficiencyReport = {
  days: number;
  registry: ModelRegistryStatus;
  threads: RouterThreadEfficiency;
  /** v2 shadow decisions only; `legacyDecisionsSkipped` counts the v1 rows left out. */
  subagents: RouterSubagentEfficiency & { legacyDecisionsSkipped: number };
};

export type RouterPreviewArgs = {
  description: string;
  /** The task's full brief, when known: it decides the kind better than the label. */
  prompt?: string | null;
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
  efficiency(args?: { days?: number }): Promise<RouterEfficiencyReport>;
  refreshRegistry(options?: { force?: boolean }): Promise<ModelRegistryStatus>;
};

type PendingSubagent = {
  /** `sessionId:taskId`, the key events arrive under. */
  key: string;
  /** The key the log uses: `key` for the first run, `key#<run>` after. */
  logKey: string;
  run: number;
  sessionId: string;
  taskId: string;
  startedAt: string;
  startedAtMs: number;
  harness: string;
  model: string | null;
  modelSource: RouterFactSource;
  effort: string | null;
  effortSource: RouterFactSource;
  description: string;
  agentType: string | null;
  prompt: string | null;
  parentToolUseId: string | null;
  /** The child session of an ADE child chat (`chat:<id>` task ids). */
  childSessionId: string | null;
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
  let plans: { atMs: number; states: Map<string, PlanState>; accounts: Map<string, PlanState>; trusted: Set<string> } | null = null;
  /** Subagents that started and have not been logged yet, by `sessionId:taskId`. */
  const pending = new Map<string, PendingSubagent>();
  /** Agent-tool briefs by `sessionId:toolUseId`; a subagent's start names its tool use. */
  const promptsByToolUse = new Map<string, string>();
  /** ADE child chats by child session id, so the child's first message becomes its brief. */
  const childKeys = new Map<string, string>();
  /**
   * Briefs of settled subagents. Claude reuses a task id when the parent sends
   * a finished subagent another message; that run is a new decision with the
   * same brief, logged under `<key>#<run>`.
   */
  const settled = new Map<string, { runs: number; prompt: string | null; description: string; agentType: string | null }>();
  let lastSweepMs = 0;
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
    let snapshot = args.registry.getSnapshot();
    if (!snapshot) {
      // No cached registry yet: fetch once so the first decisions are not all
      // "not in the catalog". The decision runs in the background, so this
      // never blocks the chat; once a snapshot is cached, later calls refresh
      // passively and read the cache.
      await args.registry.refresh();
      snapshot = args.registry.getSnapshot();
    } else {
      void args.registry.refresh();
    }
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

  const loadPlans = async (): Promise<{ states: Map<string, PlanState>; accounts: Map<string, PlanState>; trusted: Set<string> }> => {
    if (plans && now() - plans.atMs < PLANS_TTL_MS) return plans;
    const nowMs = now();
    const sinceMs = nowMs - 30 * 86_400_000;
    const [turns, samples] = await Promise.all([args.readTurns(sinceMs), args.readQuotaSamples(sinceMs)]);
    const rates = estimateQuotaBurnRates({ samples, turns, nowMs, lookbackMs: 30 * 86_400_000 });
    const states = planStatesFromBurnRates(rates, nowMs);
    const accounts = accountStatesFromBurnRates(rates, nowMs);
    const counts = new Map<string, number>();
    for (const turn of turns) {
      const harness = routeHarnessOf(turn.provider);
      const model = turn.servedModel ?? turn.requestedModel;
      if (!harness || !model) continue;
      const key = trustKey({ harness, modelId: model });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const trusted = new Set([...counts].filter(([, count]) => count >= ROUTER_TRUST_MIN_TURNS).map(([key]) => key));
    plans = { atMs: nowMs, states, accounts, trusted };
    return plans;
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
    prompt?: string | null;
    harness: string;
    model: string | null;
    effort: string | null;
    kind?: RouterTaskKind;
  }): Promise<{ pick: RouterPick; kindSource: RouterTaskKindSource; states: Map<string, PlanState> }> => {
    const [routes, planInfo] = await Promise.all([loadCatalog(), loadPlans()]);
    const classified = input.kind
      ? { kind: input.kind, source: "none" as const }
      : classifyRouterTaskDetailed(input.description, input.agentType, input.prompt);
    const reference = findReferenceRoute(routes, input.harness, input.model, input.effort);
    return {
      pick: pickRoute({ routes, reference, kind: classified.kind, plans: planInfo.states, trusted: planInfo.trusted }),
      kindSource: classified.source,
      states: planInfo.states,
    };
  };

  /** Decide on a finished (or abandoned) subagent and write its rows. */
  const settle = (entry: PendingSubagent, outcome: Extract<AgentChatEvent, { type: "subagent_result" }> | null): void => {
    pending.delete(entry.key);
    const baseKey = `${entry.sessionId}:${entry.taskId}`;
    settled.set(baseKey, { runs: entry.run, prompt: entry.prompt, description: entry.description, agentType: entry.agentType });
    while (settled.size > MAX_PENDING) settled.delete(settled.keys().next().value!);
    if (entry.childSessionId) childKeys.delete(entry.childSessionId);
    void decide({
      description: entry.description,
      agentType: entry.agentType,
      prompt: entry.prompt,
      harness: entry.harness,
      model: entry.model,
      effort: entry.effort,
    })
      .then(({ pick, kindSource, states }) => {
        append({
          v: 2,
          type: "decision",
          at: new Date(now()).toISOString(),
          key: entry.logKey,
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          kind: pick.kind,
          kindSource,
          agentType: entry.agentType,
          description: entry.description.slice(0, 160),
          promptChars: entry.prompt?.length ?? 0,
          startedAt: entry.startedAt,
          requested: {
            harness: entry.harness,
            model: entry.model,
            modelSource: entry.modelSource,
            effort: entry.effort,
            effortSource: entry.effortSource,
          },
          reference: summarize(pick.reference),
          sameModel: summarize(pick.sameModel),
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
        if (!outcome) return;
        const usage = outcome.usage;
        append({
          v: 2,
          type: "outcome",
          at: new Date(now()).toISOString(),
          key: entry.logKey,
          status: outcome.status,
          durationMs: usage?.durationMs ?? null,
          totalTokens: usage?.totalTokens ?? outcome.totalTokens ?? null,
          toolUses: usage?.toolUses ?? outcome.toolUseCount ?? null,
          costUsd: usage?.costUsd ?? null,
        });
      })
      .catch((error: unknown) => {
        args.logger?.info("router.shadow_decision_failed", { error: getErrorMessage(error) });
      });
  };

  /** Fold a start, progress, or result event's facts into the pending entry. */
  const mergeFacts = (
    entry: PendingSubagent,
    event: { model?: string | null; reasoningEffort?: string | null; agentType?: string; description?: string; label?: string | null },
  ): void => {
    const model = event.model?.trim();
    if (model && model !== "inherit") {
      entry.model = model;
      entry.modelSource = "reported";
    }
    const effort = event.reasoningEffort?.trim();
    if (effort) {
      entry.effort = effort;
      entry.effortSource = "reported";
    }
    if (event.agentType && !entry.agentType) entry.agentType = event.agentType;
    const description = event.description?.trim();
    if (description && (!entry.description || entry.description === "Subagent task")) entry.description = description;
  };

  const onSubagentStarted = (sessionId: string, event: Extract<AgentChatEvent, { type: "subagent_started" }>, session: RouterSessionFacts): void => {
    if (event.resumed) return;
    if (event.taskType && event.taskType !== "subagent") return;
    const key = `${sessionId}:${event.taskId}`;
    const existing = pending.get(key);
    if (existing) {
      // A corrected start: the tool input or the child's effort arrived late.
      mergeFacts(existing, event);
      return;
    }
    const childSessionId = event.taskId.startsWith("chat:") ? event.taskId.slice(5) : null;
    const previous = settled.get(key);
    const run = (previous?.runs ?? 0) + 1;
    const harness = event.provider ?? session.provider;
    const inherits = !event.model || event.model === "inherit";
    // Claude's effort is a session setting its native subagents share,
    // whichever model they name; the child's hooks confirm it later. Any other
    // child that names its own model gets its effort only from its own report.
    const sharesParentEffort = inherits || (!childSessionId && harness === "claude" && session.provider === "claude");
    const parentEffort = session.reasoningEffort?.trim() || null;
    const entry: PendingSubagent = {
      key,
      logKey: run > 1 ? `${key}#${run}` : key,
      run,
      sessionId,
      taskId: event.taskId,
      startedAt: new Date(now()).toISOString(),
      startedAtMs: now(),
      harness,
      model: inherits ? session.modelId ?? session.model : event.model!,
      modelSource: inherits ? "inherited" : "reported",
      effort: sharesParentEffort ? parentEffort : null,
      effortSource: sharesParentEffort && parentEffort ? "inherited" : "unknown",
      description: previous?.description || (event.description ?? ""),
      agentType: event.agentType ?? previous?.agentType ?? null,
      prompt: (event.parentToolUseId ? promptsByToolUse.get(`${sessionId}:${event.parentToolUseId}`) : null) ?? previous?.prompt ?? null,
      parentToolUseId: event.parentToolUseId ?? null,
      childSessionId,
    };
    mergeFacts(entry, { reasoningEffort: event.reasoningEffort });
    pending.set(key, entry);
    if (childSessionId) childKeys.set(childSessionId, key);
    while (pending.size > MAX_PENDING) settle(pending.values().next().value!, null);
  };

  const onSubagentResult = (sessionId: string, event: Extract<AgentChatEvent, { type: "subagent_result" }>): void => {
    const entry = pending.get(`${sessionId}:${event.taskId}`);
    if (!entry) return;
    mergeFacts(entry, event);
    settle(entry, event);
  };

  /** Agent-tool calls carry the brief; the subagent's start arrives right after. */
  const onToolCall = (sessionId: string, event: Extract<AgentChatEvent, { type: "tool_call" }>): void => {
    if (!AGENT_TOOLS.has(event.tool)) return;
    const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : null;
    const prompt = typeof args?.prompt === "string" ? args.prompt.slice(0, PROMPT_KEEP_CHARS) : "";
    if (!prompt) return;
    for (const entry of pending.values()) {
      // The start can win the race; fill the brief in place.
      if (!entry.prompt && entry.sessionId === sessionId && entry.parentToolUseId === event.itemId) entry.prompt = prompt;
    }
    promptsByToolUse.set(`${sessionId}:${event.itemId}`, prompt);
    while (promptsByToolUse.size > MAX_PROMPTS) promptsByToolUse.delete(promptsByToolUse.keys().next().value!);
  };

  const sweepStale = (): void => {
    const nowMs = now();
    if (nowMs - lastSweepMs < STALE_SWEEP_MS) return;
    lastSweepMs = nowMs;
    for (const entry of [...pending.values()]) {
      if (nowMs - entry.startedAtMs > PENDING_GIVE_UP_MS) settle(entry, null);
    }
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
        switch (event.type) {
          case "tool_call":
            onToolCall(sessionId, event);
            break;
          case "subagent_started":
            onSubagentStarted(sessionId, event, session);
            break;
          case "subagent_progress": {
            const entry = pending.get(`${sessionId}:${event.taskId}`);
            if (entry) mergeFacts(entry, event);
            break;
          }
          case "subagent_result":
            onSubagentResult(sessionId, event);
            break;
          case "user_message": {
            // An ADE child chat's first message is its brief.
            const key = childKeys.get(sessionId);
            const entry = key ? pending.get(key) : undefined;
            if (entry && !entry.prompt && event.text) entry.prompt = event.text.slice(0, PROMPT_KEEP_CHARS);
            break;
          }
          default:
            break;
        }
        sweepStale();
      } catch {
        // Shadow routing is advisory; it must never reach the chat.
      }
    },

    async preview(input) {
      const { pick, states } = await decide({
        description: input.description,
        agentType: input.agentType ?? null,
        prompt: input.prompt ?? null,
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
      const days = reportDays(input.days);
      const rows = await readShadowRows(now() - days * 86_400_000);
      const { decisions, outcomes, legacyDecisions } = splitShadowRows(rows);
      const byKind: RouterShadowSummary["byKind"] = {};
      const moves = { same: new Map<string, number>(), sameModel: new Map<string, number>(), any: new Map<string, number>() };
      const kept = new Map<string, number>();
      const ran = new Map<string, number>();
      const sources: RouterShadowSummary["sources"] = { kind: {}, effort: {}, model: {} };
      const savings: Record<string, { sameModel: number[]; same: number[]; any: number[] }> = {};
      const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
      const count = (record: Record<string, number>, key: string) => { record[key] = (record[key] ?? 0) + 1; };
      for (const row of decisions) {
        const bucket = byKind[row.kind] ??= {
          decisions: 0,
          sameModelPicks: 0,
          sameHarnessPicks: 0,
          anyHarnessPicks: 0,
          meanSameModelSaving: null,
          meanSameHarnessSaving: null,
          meanAnyHarnessSaving: null,
        };
        const saved = savings[row.kind] ??= { sameModel: [], same: [], any: [] };
        bucket.decisions += 1;
        count(sources.kind, row.kindSource ?? "none");
        count(sources.effort, row.requested?.effortSource ?? "unknown");
        count(sources.model, row.requested?.modelSource ?? "unknown");
        const req = row.requested;
        if (req) bump(ran, `${req.harness}|${req.model ?? "?"}|${req.effort ?? "?"}`);
        const from = row.reference?.routeId ?? "(not in catalog)";
        const note = (pickSummary: DecisionSummary | null | undefined, map: Map<string, number>, list: number[]): boolean => {
          if (!pickSummary) return false;
          bump(map, `${from} → ${pickSummary.routeId}`);
          if (pickSummary.savingShare != null) list.push(pickSummary.savingShare);
          return true;
        };
        if (note(row.sameModel, moves.sameModel, saved.sameModel)) bucket.sameModelPicks += 1;
        if (note(row.sameHarness, moves.same, saved.same)) bucket.sameHarnessPicks += 1;
        if (note(row.anyHarness, moves.any, saved.any)) bucket.anyHarnessPicks += 1;
        if (row.keptBecause) bump(kept, row.keptBecause);
      }
      const mean = (values: number[]): number | null => values.length
        ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000
        : null;
      for (const [kind, bucket] of Object.entries(byKind)) {
        bucket.meanSameModelSaving = mean(savings[kind]!.sameModel);
        bucket.meanSameHarnessSaving = mean(savings[kind]!.same);
        bucket.meanAnyHarnessSaving = mean(savings[kind]!.any);
      }
      const top = (map: Map<string, number>) => [...map]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([move, moveCount]) => {
          const [from, to] = move.split(" → ");
          return { from: from!, to: to!, count: moveCount };
        });
      const outcomeCounts: Record<string, number> = {};
      for (const row of decisions) count(outcomeCounts, outcomes.get(row.key)?.status ?? "open");
      const planInfo = await loadPlans();
      return {
        days,
        registry: args.registry.status(),
        decisions: decisions.length,
        legacyDecisionsSkipped: legacyDecisions,
        withOutcome: decisions.filter((row) => outcomes.has(row.key)).length,
        byKind,
        sources,
        ran: [...ran].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([route, routeCount]) => ({ route, count: routeCount })),
        topSameModelPicks: top(moves.sameModel),
        topSameHarnessPicks: top(moves.same),
        topAnyHarnessPicks: top(moves.any),
        keptReasons: [...kept].sort((a, b) => b[1] - a[1]).map(([reason, reasonCount]) => ({ reason, count: reasonCount })),
        outcomes: outcomeCounts,
        plans: Object.fromEntries(planInfo.states),
      };
    },

    async efficiency(input = {}) {
      const days = reportDays(input.days);
      const sinceMs = now() - days * 86_400_000;
      const [routes, planInfo, turns, rows] = await Promise.all([
        loadCatalog(),
        loadPlans(),
        args.readTurns(sinceMs),
        readShadowRows(sinceMs),
      ]);
      const { decisions, outcomes, legacyDecisions } = splitShadowRows(rows);
      const subagents = decisions.map((row) => {
        const outcome = outcomes.get(row.key);
        return {
          sameModelSaving: row.sameModel?.savingShare ?? null,
          sameHarnessSaving: row.sameHarness?.savingShare ?? null,
          anyHarnessSaving: row.anyHarness?.savingShare ?? null,
          picked: { sameModel: Boolean(row.sameModel), sameHarness: Boolean(row.sameHarness), anyHarness: Boolean(row.anyHarness) },
          outcome: outcome ? { totalTokens: outcome.totalTokens, costUsd: outcome.costUsd } : null,
        };
      });
      return {
        days,
        registry: args.registry.status(),
        threads: replayThreads({ turns, routes, plans: planInfo.states, accounts: planInfo.accounts, trusted: planInfo.trusted }),
        subagents: { ...summarizeSubagents(subagents), legacyDecisionsSkipped: legacyDecisions },
      };
    },

    refreshRegistry(options) {
      return args.registry.refresh(options);
    },
  };
}

/** Whole days from 1 to 90; anything that is not a number reads as the default 7. */
function reportDays(days: unknown): number {
  const whole = Math.floor(Number(days ?? 7));
  return Number.isFinite(whole) ? Math.min(90, Math.max(1, whole)) : 7;
}

/**
 * The shadow log's v2 decisions, and each decision's outcome by key. v1
 * decisions are counted, not used: they guessed the effort and the kind.
 */
function splitShadowRows(rows: ReadonlyArray<RouterShadowDecisionRow | RouterShadowOutcomeRow>): {
  decisions: RouterShadowDecisionRow[];
  outcomes: Map<string, RouterShadowOutcomeRow>;
  legacyDecisions: number;
} {
  const all = rows.filter((row): row is RouterShadowDecisionRow => row.type === "decision");
  const decisions = all.filter((row) => row.v >= 2);
  return {
    decisions,
    outcomes: new Map(rows.filter((row): row is RouterShadowOutcomeRow => row.type === "outcome").map((row) => [row.key, row])),
    legacyDecisions: all.length - decisions.length,
  };
}

type ModelSource = (provider: AgentChatProvider) => Promise<AgentChatModelInfo[]>;

type SharedRouter = { service: ModelRouterService; sources: ModelSource[] };
const sharedRouters = new Map<string, SharedRouter>();

/**
 * One router per ADE home, like the turn ledger: every project scope in a
 * brain feeds the same shadow log. Each scope lends its chat service's model
 * catalog, and the router sees the union of them, newest scope first. A
 * provider's passive list can be per project (OpenCode keeps its inventory by
 * project root), so reading only the newest scope dropped every OpenCode route
 * whenever that scope had never listed OpenCode models. The returned function
 * detaches the scope's catalog.
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
      // Every scope lists at once; a scope that fails adds nothing. Newest
      // first, so the newest scope's row wins a duplicate model id.
      const lists = await Promise.allSettled([...sources].reverse().map((source) => source(provider)));
      const seen = new Set<string>();
      const models: AgentChatModelInfo[] = [];
      for (const list of lists) {
        if (list.status !== "fulfilled") continue;
        for (const info of list.value) {
          const id = info.modelId ?? info.id;
          if (seen.has(id)) continue;
          seen.add(id);
          models.push(info);
        }
      }
      return models;
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
      // The router and its registry fetcher close over the first scope's
      // directory configuration, so leave nothing behind once every scope has
      // detached; the next scope builds a fresh one against its own config.
      if (current.sources.length === 0) sharedRouters.delete(key);
    },
  };
}
