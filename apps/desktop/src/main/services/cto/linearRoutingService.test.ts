import { describe, expect, it, vi } from "vitest";
import type { LinearSyncConfig, NormalizedLinearIssue } from "../../../shared/types";
import { createLinearRoutingService } from "./linearRoutingService";

const baseIssue: NormalizedLinearIssue = {
  id: "issue-1",
  identifier: "ABC-10",
  title: "Fix login bug",
  description: "Users cannot login when refresh token is stale.",
  url: null,
  projectId: "proj-1",
  projectSlug: "acme-platform",
  teamId: "team-1",
  teamKey: "ACME",
  stateId: "state-1",
  stateName: "Todo",
  stateType: "unstarted",
  priority: 2,
  priorityLabel: "high",
  labels: ["bug"],
  assigneeId: null,
  assigneeName: null,
  ownerId: "owner-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

function buildPolicy(overrides: Partial<LinearSyncConfig> = {}): LinearSyncConfig {
  return {
    enabled: true,
    pollingIntervalSec: 300,
    projects: [{ slug: "acme-platform" }],
    routing: { byLabel: {} },
    assignment: { setAssigneeOnDispatch: false },
    autoDispatch: { default: "auto", rules: [] },
    classification: { mode: "hybrid", confidenceThreshold: 0.7 },
    ...overrides,
  };
}

describe("linearRoutingService", () => {
  it("routes by label mapping and preserves auto-dispatch action", async () => {
    const policy = buildPolicy({
      routing: { byLabel: { bug: "backend-dev" } },
    });

    const service = createLinearRoutingService({
      projectRoot: "/tmp/project",
      workerAgentService: {
        listAgents: () => [{ id: "agent-1", slug: "backend-dev", name: "Backend Dev" }],
      } as any,
      aiIntegrationService: {
        executeTask: vi.fn(),
      } as any,
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearSyncConfig) => input ?? policy,
      } as any,
    });

    const decision = await service.routeIssue({ issue: baseIssue });
    expect(decision.workerSlug).toBe("backend-dev");
    expect(decision.workerId).toBe("agent-1");
    expect(decision.action).toBe("auto");
    expect(decision.reason.toLowerCase()).toContain("label-based routing");
  });

  it("escalates when auto route cannot resolve a worker", async () => {
    const policy = buildPolicy({
      routing: { byLabel: {} },
      autoDispatch: { default: "auto", rules: [] },
      classification: { mode: "heuristics", confidenceThreshold: 0.7 },
    });

    const service = createLinearRoutingService({
      projectRoot: "/tmp/project",
      workerAgentService: {
        listAgents: () => [],
      } as any,
      aiIntegrationService: {
        executeTask: vi.fn(),
      } as any,
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearSyncConfig) => input ?? policy,
      } as any,
    });

    const decision = await service.routeIssue({
      issue: { ...baseIssue, labels: [] },
    });
    expect(decision.action).toBe("escalate");
    expect(decision.workerSlug).toBeNull();
    expect(decision.confidence).toBeLessThanOrEqual(0.4);
  });

  it("uses AI fallback in hybrid mode when heuristic confidence is low", async () => {
    const policy = buildPolicy({
      classification: { mode: "hybrid", confidenceThreshold: 0.9 },
    });

    const executeTask = vi.fn(async () => ({
      structuredOutput: {
        workerSlug: "ai-worker",
        action: "auto",
        templateId: "ai-template",
        confidence: 0.95,
        reason: "AI selected worker",
        matchedSignals: ["ai:classification"],
      },
      text: "",
    }));

    const service = createLinearRoutingService({
      projectRoot: "/tmp/project",
      workerAgentService: {
        listAgents: () => [{ id: "agent-ai", slug: "ai-worker", name: "AI Worker" }],
      } as any,
      aiIntegrationService: {
        executeTask,
      } as any,
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearSyncConfig) => input ?? policy,
      } as any,
    });

    const decision = await service.routeIssue({
      issue: { ...baseIssue, labels: [] },
    });
    expect(executeTask).toHaveBeenCalledOnce();
    expect(decision.workerSlug).toBe("ai-worker");
    expect(decision.workerId).toBe("agent-ai");
    expect(decision.templateId).toBe("ai-template");
    expect(decision.reason).toContain("(AI)");
  });
});
