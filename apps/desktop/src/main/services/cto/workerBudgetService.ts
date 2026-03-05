import { spawnSync } from "node:child_process";
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
import { safeJsonParse } from "../shared/utils";

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

function nowIso(): string {
  return new Date().toISOString();
}

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

function parseCostUsdToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 100));
  }
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed * 100));
  }
  return null;
}

function extractCodexBarCostCents(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    source.costUsd,
    source.totalCostUsd,
    source.total_cost_usd,
    source.totalCost,
    source.total_cost,
    (source.session as Record<string, unknown> | undefined)?.costUsd,
    (source.session as Record<string, unknown> | undefined)?.totalCostUsd,
    (source.session as Record<string, unknown> | undefined)?.totalCost,
    (source.session as Record<string, unknown> | undefined)?.cost,
    (source.last30days as Record<string, unknown> | undefined)?.costUsd,
    (source.last30days as Record<string, unknown> | undefined)?.totalCostUsd,
    (source.last30days as Record<string, unknown> | undefined)?.totalCost,
    (source.last30days as Record<string, unknown> | undefined)?.cost,
  ];
  for (const candidate of candidates) {
    const cents = parseCostUsdToCents(candidate);
    if (cents != null) return cents;
  }

  const daily = Array.isArray(source.daily) ? source.daily : [];
  let sumCents = 0;
  let found = false;
  for (const day of daily) {
    if (!day || typeof day !== "object") continue;
    const row = day as Record<string, unknown>;
    const cents = parseCostUsdToCents(row.costUsd ?? row.totalCostUsd ?? row.cost ?? row.totalCost);
    if (cents == null) continue;
    sumCents += cents;
    found = true;
  }
  return found ? sumCents : null;
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
    const rows = input.agentId
      ? args.db.all<Record<string, unknown>>(
          `
            select * from worker_agent_cost_events
            where project_id = ? and agent_id = ?
              and datetime(occurred_at) >= datetime(?)
              and datetime(occurred_at) < datetime(?)
            order by datetime(occurred_at) desc
            limit ?
          `,
          [args.projectId, input.agentId, startIso, endIso, limit]
        )
      : args.db.all<Record<string, unknown>>(
          `
            select * from worker_agent_cost_events
            where project_id = ?
              and datetime(occurred_at) >= datetime(?)
              and datetime(occurred_at) < datetime(?)
            order by datetime(occurred_at) desc
            limit ?
          `,
          [args.projectId, startIso, endIso, limit]
        );

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      agentId: String(row.agent_id ?? ""),
      runId: typeof row.run_id === "string" && row.run_id.trim().length ? row.run_id.trim() : null,
      sessionId: typeof row.session_id === "string" && row.session_id.trim().length ? row.session_id.trim() : null,
      provider: String(row.provider ?? ""),
      modelId: typeof row.model_id === "string" && row.model_id.trim().length ? row.model_id.trim() : null,
      inputTokens: Number.isFinite(Number(row.input_tokens)) ? Number(row.input_tokens) : null,
      outputTokens: Number.isFinite(Number(row.output_tokens)) ? Number(row.output_tokens) : null,
      costCents: Math.max(0, Math.floor(Number(row.cost_cents ?? 0))),
      estimated: Number(row.estimated ?? 0) === 1,
      source: String(row.source ?? "manual") as AgentCostEvent["source"],
      occurredAt: String(row.occurred_at ?? nowIso()),
      createdAt: String(row.created_at ?? nowIso()),
    }));
  };

  const reconcileCliEstimateFromCodexBar = (input: { agentId: string; sessionId?: string | null }): AgentCostEvent | null => {
    const config = args.projectConfigService.get().effective.cto;
    const telemetry = config?.budgetTelemetry;
    const enabled = telemetry?.enabled !== false;
    if (!enabled) return null;
    const command = (telemetry?.codexBarCommand ?? "cost --format json").trim();
    if (!command.length) return null;

    const result = spawnSync(command, {
      cwd: process.cwd(),
      shell: true,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_024 * 1_024,
    });
    if (result.status !== 0) return null;
    const payload = safeJsonParse(result.stdout, null);
    if (!payload) return null;
    const totalCents = extractCodexBarCostCents(payload);
    if (totalCents == null) return null;

    if (input.sessionId && input.sessionId.trim().length) {
      const sessionId = input.sessionId.trim();
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
        provider: "codexbar",
        costCents: delta,
        estimated: true,
        source: "reconcile",
      });
    }

    return recordCostEvent({
      agentId: input.agentId,
      provider: "codexbar",
      costCents: totalCents,
      estimated: true,
      source: "reconcile",
    });
  };

  return {
    recordCostEvent,
    listCostEvents,
    getBudgetSnapshot,
    reconcileCliEstimateFromCodexBar,
  };
}

export type WorkerBudgetService = ReturnType<typeof createWorkerBudgetService>;
