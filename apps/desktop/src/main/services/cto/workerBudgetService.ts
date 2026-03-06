import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentBudgetSnapshot,
  AgentBudgetSummary,
  AgentCostEvent,
  AgentStatus,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { WorkerAgentService } from "./workerAgentService";
import type { createProjectConfigService } from "../config/projectConfigService";
import { safeJsonParse, nowIso, toOptionalString } from "../shared/utils";

type WorkerBudgetServiceArgs = {
  db: AdeDb;
  projectId: string;
  workerAgentService: WorkerAgentService;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
};

type RecordCostEventInput = {
  agentId: string;
  runId?: string | null;
  sessionId?: string | null;
  provider: string;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents: number;
  estimated: boolean;
  source: "api" | "cli" | "manual" | "reconcile";
  occurredAt?: string;
};

type SumRow = {
  agent_id: string;
  total_cents: number;
  exact_cents: number;
  estimated_cents: number;
};

function monthKeyFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthBounds(monthKey: string): { startIso: string; endIso: string } {
  const [yearRaw, monthRaw] = monthKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const now = new Date();
    const currentMonth = monthKeyFor(now);
    return monthBounds(currentMonth);
  }
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function normalizeMonthKey(input?: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  return monthKeyFor(new Date());
}

function parseNumber(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function estimateCodexCostCents(inputTokens: number, outputTokens: number): number {
  // Matches ADE's budget estimate pricing for codex/gpt families.
  const usd = (inputTokens * (2 / 1_000_000)) + (outputTokens * (8 / 1_000_000));
  return Math.max(0, Math.round(usd * 100));
}

function readCodexUsageCostCents(args: {
  fromMs: number;
  toMs: number;
  sessionId?: string | null;
  sessionsRoot?: string | null;
}): number {
  const configuredRoot = typeof args.sessionsRoot === "string" ? args.sessionsRoot.trim() : "";
  const root = configuredRoot.length > 0
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(root)) return 0;

  const files: string[] = [];
  const minMtimeMs = args.fromMs - (24 * 60 * 60 * 1000);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(abs);
        if (stat.mtimeMs < minMtimeMs) continue;
      } catch {
        continue;
      }
      files.push(abs);
    }
  }

  const sessionIdFilter = typeof args.sessionId === "string" && args.sessionId.trim().length > 0
    ? args.sessionId.trim()
    : null;
  let totalCents = 0;

  for (const filePath of files) {
    let sessionIdInFile = "";
    let previousTotals: { input: number; output: number; cached: number; reasoning: number } | null = null;
    let lastEventKey = "";
    let fileCents = 0;

    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse(trimmed, null) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") continue;
      const timestampRaw =
        (typeof parsed.timestamp === "string" && parsed.timestamp)
        || (typeof parsed.createdAt === "string" && parsed.createdAt)
        || null;
      if (!timestampRaw) continue;
      const timestampMs = Date.parse(timestampRaw);
      if (!Number.isFinite(timestampMs)) continue;

      const recordType = typeof parsed.type === "string" ? parsed.type : "";
      const payload = parsed.payload && typeof parsed.payload === "object"
        ? parsed.payload as Record<string, unknown>
        : null;
      if (recordType === "session_meta" && payload && typeof payload.id === "string") {
        sessionIdInFile = payload.id;
      }
      if (recordType !== "event_msg" || !payload || payload.type !== "token_count") continue;

      if (sessionIdFilter && sessionIdInFile !== sessionIdFilter) continue;
      if (timestampMs < args.fromMs || timestampMs > args.toMs) continue;

      const info = payload.info && typeof payload.info === "object"
        ? payload.info as Record<string, unknown>
        : null;
      if (!info) continue;
      const totalUsage = info.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage as Record<string, unknown>
        : null;
      const lastUsage = info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage as Record<string, unknown>
        : null;

      const currentTotal = {
        input: parseNumber(totalUsage?.input_tokens),
        output: parseNumber(totalUsage?.output_tokens),
        cached: parseNumber(totalUsage?.cached_input_tokens),
        reasoning: parseNumber(totalUsage?.reasoning_output_tokens),
      };
      const currentLast = {
        input: parseNumber(lastUsage?.input_tokens),
        output: parseNumber(lastUsage?.output_tokens),
        cached: parseNumber(lastUsage?.cached_input_tokens),
        reasoning: parseNumber(lastUsage?.reasoning_output_tokens),
      };
      const eventKey =
        `${timestampMs}:${currentTotal.input}:${currentTotal.output}:${currentTotal.cached}:${currentTotal.reasoning}:` +
        `${currentLast.input}:${currentLast.output}:${currentLast.cached}:${currentLast.reasoning}`;
      if (eventKey === lastEventKey) continue;
      lastEventKey = eventKey;

      let deltaInput = 0;
      let deltaOutput = 0;
      if (totalUsage) {
        if (previousTotals) {
          deltaInput = Math.max(0, currentTotal.input - previousTotals.input);
          deltaOutput = Math.max(0, currentTotal.output - previousTotals.output);
        } else {
          deltaInput = currentTotal.input;
          deltaOutput = currentTotal.output;
        }
        previousTotals = currentTotal;
      } else {
        deltaInput = currentLast.input;
        deltaOutput = currentLast.output;
      }
      if (deltaInput <= 0 && deltaOutput <= 0) continue;
      fileCents += estimateCodexCostCents(deltaInput, deltaOutput);
    }
    totalCents += fileCents;
  }

  return Math.max(0, Math.floor(totalCents));
}

export function createWorkerBudgetService(args: WorkerBudgetServiceArgs) {
  const listSummedCostsByAgent = (monthKey: string): Map<string, SumRow> => {
    const { startIso, endIso } = monthBounds(monthKey);
    const rows = args.db.all<SumRow>(
      `
        select
          agent_id,
          sum(cost_cents) as total_cents,
          sum(case when estimated = 0 then cost_cents else 0 end) as exact_cents,
          sum(case when estimated = 1 then cost_cents else 0 end) as estimated_cents
        from worker_agent_cost_events
        where project_id = ?
          and datetime(occurred_at) >= datetime(?)
          and datetime(occurred_at) < datetime(?)
        group by agent_id
      `,
      [args.projectId, startIso, endIso]
    );
    const map = new Map<string, SumRow>();
    for (const row of rows) {
      map.set(String(row.agent_id), {
        agent_id: String(row.agent_id),
        total_cents: Number(row.total_cents ?? 0),
        exact_cents: Number(row.exact_cents ?? 0),
        estimated_cents: Number(row.estimated_cents ?? 0),
      });
    }
    return map;
  };

  const applyBudgetEnforcement = (snapshot: AgentBudgetSnapshot): void => {
    const companyCap = snapshot.companyBudgetMonthlyCents;
    const companyBreached = companyCap > 0 && snapshot.companySpentMonthlyCents >= companyCap;

    for (const worker of snapshot.workers) {
      const workerCapBreached = worker.budgetMonthlyCents > 0 && worker.spentMonthlyCents >= worker.budgetMonthlyCents;
      if (workerCapBreached || companyBreached) {
        args.workerAgentService.setAgentStatus(worker.agentId, "paused");
      }
    }
  };

  const getBudgetSnapshot = (options: { monthKey?: string } = {}): AgentBudgetSnapshot => {
    const monthKey = normalizeMonthKey(options.monthKey);
    const sums = listSummedCostsByAgent(monthKey);
    const workers = args.workerAgentService.listAgents({ includeDeleted: false });
    const workerSummaries: AgentBudgetSummary[] = workers.map((worker) => {
      const sum = sums.get(worker.id);
      const spent = Math.max(0, Math.floor(sum?.total_cents ?? 0));
      const exact = Math.max(0, Math.floor(sum?.exact_cents ?? 0));
      const estimated = Math.max(0, Math.floor(sum?.estimated_cents ?? 0));
      args.workerAgentService.updateAgentSpentMonthlyCents(worker.id, spent);
      const remaining = worker.budgetMonthlyCents > 0 ? Math.max(0, worker.budgetMonthlyCents - spent) : null;
      const effectiveStatus: AgentStatus =
        worker.budgetMonthlyCents > 0 && spent >= worker.budgetMonthlyCents ? "paused" : worker.status;
      return {
        agentId: worker.id,
        name: worker.name,
        budgetMonthlyCents: worker.budgetMonthlyCents,
        spentMonthlyCents: spent,
        exactSpentCents: exact,
        estimatedSpentCents: estimated,
        remainingCents: remaining,
        status: effectiveStatus,
      };
    });

    const companySpentMonthlyCents = workerSummaries.reduce((acc, row) => acc + row.spentMonthlyCents, 0);
    const companyExactSpentCents = workerSummaries.reduce((acc, row) => acc + row.exactSpentCents, 0);
    const companyEstimatedSpentCents = workerSummaries.reduce((acc, row) => acc + row.estimatedSpentCents, 0);
    const companyCap = Math.max(
      0,
      Math.floor(Number(args.projectConfigService.get().effective.cto?.companyBudgetMonthlyCents ?? 0)),
    );

    const snapshot: AgentBudgetSnapshot = {
      computedAt: nowIso(),
      monthKey,
      companyBudgetMonthlyCents: companyCap,
      companySpentMonthlyCents,
      companyExactSpentCents,
      companyEstimatedSpentCents,
      companyRemainingCents: companyCap > 0 ? Math.max(0, companyCap - companySpentMonthlyCents) : null,
      workers: workerSummaries,
    };
    applyBudgetEnforcement(snapshot);
    return snapshot;
  };

  const recordCostEvent = (input: RecordCostEventInput): AgentCostEvent => {
    const event: AgentCostEvent = {
      id: randomUUID(),
      agentId: input.agentId,
      runId: input.runId ?? null,
      sessionId: input.sessionId ?? null,
      provider: input.provider,
      modelId: input.modelId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costCents: Math.max(0, Math.floor(Number(input.costCents ?? 0))),
      estimated: input.estimated,
      source: input.source,
      occurredAt: input.occurredAt ?? nowIso(),
      createdAt: nowIso(),
    };
    args.db.run(
      `
        insert into worker_agent_cost_events(
          id, project_id, agent_id, run_id, session_id, provider, model_id, input_tokens, output_tokens,
          cost_cents, estimated, source, occurred_at, created_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        event.id,
        args.projectId,
        event.agentId,
        event.runId ?? null,
        event.sessionId ?? null,
        event.provider,
        event.modelId ?? null,
        event.inputTokens ?? null,
        event.outputTokens ?? null,
        event.costCents,
        event.estimated ? 1 : 0,
        event.source,
        event.occurredAt,
        event.createdAt,
      ]
    );
    getBudgetSnapshot();
    return event;
  };

  const listCostEvents = (input: { agentId?: string; monthKey?: string; limit?: number } = {}): AgentCostEvent[] => {
    const monthKey = normalizeMonthKey(input.monthKey);
    const { startIso, endIso } = monthBounds(monthKey);
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));

    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [args.projectId];
    if (input.agentId) {
      clauses.push("agent_id = ?");
      params.push(input.agentId);
    }
    clauses.push("datetime(occurred_at) >= datetime(?)");
    params.push(startIso);
    clauses.push("datetime(occurred_at) < datetime(?)");
    params.push(endIso);
    params.push(limit);

    const rows = args.db.all<Record<string, unknown>>(
      `
        select * from worker_agent_cost_events
        where ${clauses.join(" and ")}
        order by datetime(occurred_at) desc
        limit ?
      `,
      params
    );

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      agentId: String(row.agent_id ?? ""),
      runId: toOptionalString(row.run_id),
      sessionId: toOptionalString(row.session_id),
      provider: String(row.provider ?? ""),
      modelId: toOptionalString(row.model_id),
      inputTokens: Number.isFinite(Number(row.input_tokens)) ? Number(row.input_tokens) : null,
      outputTokens: Number.isFinite(Number(row.output_tokens)) ? Number(row.output_tokens) : null,
      costCents: Math.max(0, Math.floor(Number(row.cost_cents ?? 0))),
      estimated: Number(row.estimated ?? 0) === 1,
      source: String(row.source ?? "manual") as AgentCostEvent["source"],
      occurredAt: String(row.occurred_at ?? nowIso()),
      createdAt: String(row.created_at ?? nowIso()),
    }));
  };

  const reconcileCliEstimateFromLocalTelemetry = (input: { agentId: string; sessionId?: string | null }): AgentCostEvent | null => {
    const config = args.projectConfigService.get().effective.cto;
    const telemetry = config?.budgetTelemetry;
    const enabled = telemetry?.enabled !== false;
    if (!enabled) return null;
    const sessionsRoot =
      typeof telemetry?.codexSessionsRoot === "string" && telemetry.codexSessionsRoot.trim().length > 0
        ? telemetry.codexSessionsRoot.trim()
        : null;

    const now = Date.now();
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim().length > 0
      ? input.sessionId.trim()
      : null;
    const totalCents = sessionId
      ? readCodexUsageCostCents({
          fromMs: now - (365 * 24 * 60 * 60 * 1000),
          toMs: now,
          sessionId,
          sessionsRoot,
        })
      : (() => {
          const { startIso, endIso } = monthBounds(monthKeyFor(new Date()));
          const fromMs = Date.parse(startIso);
          const toMs = Date.parse(endIso);
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
          return readCodexUsageCostCents({
            fromMs,
            toMs,
            sessionsRoot,
          });
        })();
    if (totalCents <= 0) return null;

    if (sessionId) {
      const existing = args.db.get<{ total: number }>(
        `
          select sum(cost_cents) as total
          from worker_agent_cost_events
          where project_id = ? and agent_id = ? and session_id = ? and source = 'reconcile'
        `,
        [args.projectId, input.agentId, sessionId]
      );
      const alreadyRecorded = Math.max(0, Math.floor(Number(existing?.total ?? 0)));
      const delta = totalCents - alreadyRecorded;
      if (delta <= 0) return null;
      return recordCostEvent({
        agentId: input.agentId,
        sessionId,
        provider: "codex-local",
        costCents: delta,
        estimated: true,
        source: "reconcile",
      });
    }

    return recordCostEvent({
      agentId: input.agentId,
      provider: "codex-local",
      costCents: totalCents,
      estimated: true,
      source: "reconcile",
    });
  };

  return {
    recordCostEvent,
    listCostEvents,
    getBudgetSnapshot,
    reconcileCliEstimateFromLocalTelemetry,
  };
}

export type WorkerBudgetService = ReturnType<typeof createWorkerBudgetService>;
