import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LinearWorkflowConfig, NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearIntakeService } from "./linearIntakeService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

const issueFixture: NormalizedLinearIssue = {
  id: "issue-1",
  identifier: "ABC-42",
  title: "Fix flaky sync run",
  description: "Occasional sync failure under load.",
  url: "https://linear.app/acme/issue/ABC-42",
  projectId: "proj-1",
  projectSlug: "acme-platform",
  teamId: "team-1",
  teamKey: "ACME",
  stateId: "state-todo",
  stateName: "Todo",
  stateType: "unstarted",
  priority: 2,
  priorityLabel: "high",
  labels: ["bug"],
  assigneeId: null,
  assigneeName: "CTO",
  ownerId: "owner-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

const secondIssue: NormalizedLinearIssue = {
  ...issueFixture,
  id: "issue-2",
  identifier: "ABC-43",
  title: "Add rate limiter",
  priority: 1,
  createdAt: "2026-03-04T00:00:00.000Z",
  updatedAt: "2026-03-04T00:00:00.000Z",
};

const policy: LinearWorkflowConfig = {
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
      id: "flow-1",
      name: "Flow 1",
      enabled: true,
      priority: 100,
      triggers: { assignees: ["CTO"], projectSlugs: ["acme-platform"] },
      target: { type: "mission" },
      steps: [{ id: "launch", type: "launch_target" }],
    },
  ],
  files: [],
  migration: { hasLegacyConfig: false, needsSave: false },
  legacyConfig: null,
};

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-intake-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger());
  return { root, adeDir, db };
}

describe("linearIntakeService", () => {
  it("fetches candidates, filters out blockers, and sorts by priority then createdAt", async () => {
    const fixture = await createFixture();
    const blockedIssue: NormalizedLinearIssue = {
      ...issueFixture,
      id: "issue-blocked",
      identifier: "ABC-99",
      hasOpenBlockers: true,
      priority: 0,
    };
    const fetchCandidateIssues = vi.fn(async () => [blockedIssue, secondIssue, issueFixture]);

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId: "project-intake-test",
      issueTracker: {
        fetchCandidateIssues,
      } as any,
    });

    const candidates = await service.fetchCandidates(policy);

    expect(fetchCandidateIssues).toHaveBeenCalledWith({
      projectSlugs: ["acme-platform"],
      stateTypes: ["backlog", "unstarted", "started"],
    });

    // Blocked issue should be filtered out
    expect(candidates.find((issue) => issue.id === "issue-blocked")).toBeUndefined();
    // Remaining should be sorted by priority (ascending), then createdAt
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.id).toBe("issue-2"); // priority 1 < priority 2
    expect(candidates[1]!.id).toBe("issue-1");

    fixture.db.close();
  });

  it("merges project slugs from intake, workflows, and legacy config", async () => {
    const fixture = await createFixture();
    const fetchCandidateIssues = vi.fn(async () => []);

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId: "project-slug-merge",
      issueTracker: { fetchCandidateIssues } as any,
    });

    const policyWithLegacy: LinearWorkflowConfig = {
      ...policy,
      intake: {
        ...policy.intake,
        projectSlugs: ["primary-project"],
      },
      workflows: [
        {
          id: "flow-extra",
          name: "Extra flow",
          enabled: true,
          priority: 100,
          triggers: { projectSlugs: ["extra-project"] },
          target: { type: "mission" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
      ],
      legacyConfig: {
        enabled: true,
        projects: [{ slug: "legacy-project" }],
      },
    };

    await service.fetchCandidates(policyWithLegacy);

    const calledWith = (fetchCandidateIssues.mock.calls as any)[0][0] as { projectSlugs: string[] };
    expect(calledWith.projectSlugs).toContain("primary-project");
    expect(calledWith.projectSlugs).toContain("extra-project");
    expect(calledWith.projectSlugs).toContain("legacy-project");

    fixture.db.close();
  });

  it("attaches previous state info from persisted snapshots", async () => {
    const fixture = await createFixture();
    const projectId = "project-previous-state";

    // Pre-persist a snapshot so the service finds previous state
    const now = new Date().toISOString();
    fixture.db.run(
      `
        insert into linear_issue_snapshots(
          id, project_id, issue_id, identifier, state_type, assignee_id, updated_at_linear, payload_json, hash, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `${projectId}:${issueFixture.id}`,
        projectId,
        issueFixture.id,
        issueFixture.identifier,
        "backlog",
        null,
        issueFixture.updatedAt,
        JSON.stringify({ ...issueFixture, stateId: "state-backlog", stateName: "Backlog", stateType: "backlog" }),
        "old-hash",
        now,
        now,
      ]
    );

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId,
      issueTracker: {
        fetchCandidateIssues: vi.fn(async () => [issueFixture]),
      } as any,
    });

    const candidates = await service.fetchCandidates(policy);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.previousStateType).toBe("backlog");
    expect(candidates[0]!.previousStateName).toBe("Backlog");

    fixture.db.close();
  });

  it("persistSnapshot inserts a new row and updates an existing one", async () => {
    const fixture = await createFixture();
    const projectId = "project-persist-test";

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId,
      issueTracker: {
        fetchCandidateIssues: vi.fn(async () => []),
      } as any,
    });

    // First persist: insert
    service.persistSnapshot(issueFixture);
    const row1 = fixture.db.get<{ issue_id: string; state_type: string }>(
      `select issue_id, state_type from linear_issue_snapshots where project_id = ? and issue_id = ?`,
      [projectId, issueFixture.id]
    );
    expect(row1, "First persist should create a row").toBeTruthy();
    expect(row1!.issue_id).toBe(issueFixture.id);
    expect(row1!.state_type).toBe("unstarted");

    // Second persist: update
    const updatedIssue = { ...issueFixture, stateType: "started" as const, stateName: "In Progress" };
    service.persistSnapshot(updatedIssue);
    const row2 = fixture.db.get<{ state_type: string }>(
      `select state_type from linear_issue_snapshots where project_id = ? and issue_id = ?`,
      [projectId, issueFixture.id]
    );
    expect(row2!.state_type).toBe("started");

    fixture.db.close();
  });

  it("issueHash produces consistent deterministic output", async () => {
    const fixture = await createFixture();

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId: "project-hash-test",
      issueTracker: {
        fetchCandidateIssues: vi.fn(async () => []),
      } as any,
    });

    const hash1 = service.issueHash(issueFixture);
    const hash2 = service.issueHash(issueFixture);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // sha256 hex

    const hash3 = service.issueHash({ ...issueFixture, title: "Different title" });
    expect(hash3).not.toBe(hash1);

    fixture.db.close();
  });

  it("returns empty array when no issues match the query", async () => {
    const fixture = await createFixture();

    const service = createLinearIntakeService({
      db: fixture.db,
      projectId: "project-empty",
      issueTracker: {
        fetchCandidateIssues: vi.fn(async () => []),
      } as any,
    });

    const candidates = await service.fetchCandidates(policy);
    expect(candidates).toEqual([]);

    fixture.db.close();
  });
});
