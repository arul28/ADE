import { describe, expect, it } from "vitest";
import type { LinearWorkflowConfig, NormalizedLinearIssue } from "../../../shared/types";
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
  previousStateId: "state-backlog",
  previousStateName: "Backlog",
  previousStateType: "backlog",
  priority: 2,
  priorityLabel: "high",
  labels: ["bug", "fast-lane"],
  metadataTags: ["ui"],
  assigneeId: null,
  assigneeName: "CTO",
  ownerId: "owner-1",
  creatorId: "creator-1",
  creatorName: "Taylor",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

function buildPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake: {
      projectSlugs: ["acme-platform"],
      activeStateTypes: ["backlog", "unstarted", "started"],
      terminalStateTypes: ["completed", "canceled"],
    },
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "review",
        name: "Review gate",
        enabled: true,
        priority: 50,
        triggers: { assignees: ["CTO"], labels: ["needs-triage"] },
        target: { type: "review_gate" },
        steps: [{ id: "launch", type: "launch_target" }],
      },
      {
        id: "fast-lane",
        name: "PR fast lane",
        enabled: true,
        priority: 120,
        triggers: { assignees: ["CTO"], labels: ["fast-lane"], priority: ["high"], projectSlugs: ["acme-platform"] },
        target: { type: "pr_resolution", runMode: "autopilot" },
        steps: [{ id: "launch", type: "launch_target", name: "Launch PR flow" }],
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

describe("linearRoutingService", () => {
  it("returns all candidate explanations and picks the highest-priority match", async () => {
    const policy = buildPolicy();
    const service = createLinearRoutingService({
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
      } as any,
    });

    const decision = await service.routeIssue({ issue: baseIssue });
    expect(decision.workflowId).toBe("fast-lane");
    expect(decision.target?.type).toBe("pr_resolution");
    expect(decision.candidates).toHaveLength(2);
    expect(decision.candidates.find((candidate) => candidate.workflowId === "review")?.matched).toBe(false);
  });

  it("explains when nothing matched", async () => {
    const policy = buildPolicy();
    const service = createLinearRoutingService({
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
      } as any,
    });

    const decision = await service.routeIssue({
      issue: { ...baseIssue, labels: ["bug"], assigneeName: "Someone Else" },
    });
    expect(decision.workflowId).toBeNull();
    expect(decision.reason).toContain("No workflow matched");
  });

  it("requires both assignee and workflow label, while allowing employee identity mappings", async () => {
    const policy = buildPolicy();
    policy.workflows[1] = {
      ...policy.workflows[1]!,
      triggers: {
        ...policy.workflows[1]!.triggers,
        assignees: ["agent-1"],
      },
    };
    const service = createLinearRoutingService({
      flowPolicyService: {
        getPolicy: () => policy,
        normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
      } as any,
      workerAgentService: {
        listAgents: () => [
          {
            id: "agent-1",
            slug: "backend-dev",
            name: "Backend Dev",
            linearIdentity: { userIds: ["user-1"], displayNames: ["Alex Johnson"], aliases: ["alex"] },
          },
        ],
      } as any,
    });

    const missingLabel = await service.routeIssue({
      issue: { ...baseIssue, assigneeId: "user-1", assigneeName: "Alex Johnson", labels: ["bug"] },
    });
    expect(missingLabel.workflowId).toBeNull();
    expect(missingLabel.candidates[1]?.missingSignals).toContain("Missing label");

    const matched = await service.routeIssue({
      issue: { ...baseIssue, assigneeId: "user-1", assigneeName: "Alex Johnson", labels: ["fast-lane"] },
    });
    expect(matched.workflowId).toBe("fast-lane");
    expect(matched.simulation?.explainsAndAcrossFields).toBe(true);
  });
});
