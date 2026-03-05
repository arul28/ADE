import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createWorkerAgentService } from "./workerAgentService";
import { createWorkerBudgetService } from "./workerBudgetService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture(config?: { companyBudgetMonthlyCents?: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-budget-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-test";
  const workerAgentService = createWorkerAgentService({
    db,
    projectId,
    adeDir,
  });
  const projectConfigService = {
    get: () => ({
      effective: {
        cto: {
          companyBudgetMonthlyCents: config?.companyBudgetMonthlyCents ?? 0,
          budgetTelemetry: {
            enabled: false,
          },
        },
      },
    }),
  } as any;
  const workerBudgetService = createWorkerBudgetService({
    db,
    projectId,
    workerAgentService,
    projectConfigService,
  });
  return { db, workerAgentService, workerBudgetService };
}

describe("workerBudgetService", () => {
  it("records cost events and combines exact+estimated spend", async () => {
    const fixture = await createFixture();
    const worker = fixture.workerAgentService.saveAgent({
      name: "Budget Worker",
      role: "engineer",
      adapterType: "codex-local",
      adapterConfig: { model: "gpt-5.3-codex" },
      budgetMonthlyCents: 10_000,
    });

    fixture.workerBudgetService.recordCostEvent({
      agentId: worker.id,
      provider: "openai",
      modelId: "gpt-5.3-codex",
      costCents: 120,
      estimated: false,
      source: "api",
    });
    fixture.workerBudgetService.recordCostEvent({
      agentId: worker.id,
      provider: "codex-local",
      modelId: "gpt-5.3-codex",
      costCents: 80,
      estimated: true,
      source: "cli",
    });

    const snapshot = fixture.workerBudgetService.getBudgetSnapshot();
    const row = snapshot.workers.find((entry) => entry.agentId === worker.id);
    expect(row?.exactSpentCents).toBe(120);
    expect(row?.estimatedSpentCents).toBe(80);
    expect(row?.spentMonthlyCents).toBe(200);
    expect(snapshot.companySpentMonthlyCents).toBe(200);
    expect(snapshot.companyExactSpentCents).toBe(120);
    expect(snapshot.companyEstimatedSpentCents).toBe(80);

    fixture.db.close();
  });

  it("auto-pauses worker when per-worker cap is breached", async () => {
    const fixture = await createFixture();
    const worker = fixture.workerAgentService.saveAgent({
      name: "Capped Worker",
      role: "qa",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      budgetMonthlyCents: 150,
    });

    fixture.workerBudgetService.recordCostEvent({
      agentId: worker.id,
      provider: "manual",
      costCents: 151,
      estimated: false,
      source: "manual",
    });
    const updated = fixture.workerAgentService.getAgent(worker.id);
    expect(updated?.status).toBe("paused");

    fixture.db.close();
  });

  it("auto-pauses workers when company cap is breached", async () => {
    const fixture = await createFixture({ companyBudgetMonthlyCents: 200 });
    const workerA = fixture.workerAgentService.saveAgent({
      name: "A",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      budgetMonthlyCents: 0,
    });
    const workerB = fixture.workerAgentService.saveAgent({
      name: "B",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      budgetMonthlyCents: 0,
    });

    fixture.workerBudgetService.recordCostEvent({
      agentId: workerA.id,
      provider: "manual",
      costCents: 120,
      estimated: false,
      source: "manual",
    });
    fixture.workerBudgetService.recordCostEvent({
      agentId: workerB.id,
      provider: "manual",
      costCents: 120,
      estimated: false,
      source: "manual",
    });

    const stateA = fixture.workerAgentService.getAgent(workerA.id);
    const stateB = fixture.workerAgentService.getAgent(workerB.id);
    expect(stateA?.status).toBe("paused");
    expect(stateB?.status).toBe("paused");

    fixture.db.close();
  });

  it("respects monthly boundaries for spend accumulation", async () => {
    const fixture = await createFixture();
    const worker = fixture.workerAgentService.saveAgent({
      name: "Month Worker",
      role: "general",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      budgetMonthlyCents: 0,
    });

    fixture.workerBudgetService.recordCostEvent({
      agentId: worker.id,
      provider: "manual",
      costCents: 50,
      estimated: false,
      source: "manual",
      occurredAt: "2026-01-31T23:59:00.000Z",
    });
    fixture.workerBudgetService.recordCostEvent({
      agentId: worker.id,
      provider: "manual",
      costCents: 75,
      estimated: false,
      source: "manual",
      occurredAt: "2026-02-01T00:00:00.000Z",
    });

    const jan = fixture.workerBudgetService.getBudgetSnapshot({ monthKey: "2026-01" });
    const feb = fixture.workerBudgetService.getBudgetSnapshot({ monthKey: "2026-02" });
    expect(jan.workers.find((entry) => entry.agentId === worker.id)?.spentMonthlyCents).toBe(50);
    expect(feb.workers.find((entry) => entry.agentId === worker.id)?.spentMonthlyCents).toBe(75);

    fixture.db.close();
  });
});
