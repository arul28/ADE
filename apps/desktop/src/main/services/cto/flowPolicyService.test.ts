import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LinearSyncConfig, LinearWorkflowConfig } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearWorkflowFileService } from "./linearWorkflowFileService";
import { createFlowPolicyService } from "./flowPolicyService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-flow-policy-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-flow-policy";
  const legacyConfig: LinearSyncConfig = {
    enabled: true,
    projects: [{ slug: "acme-platform", defaultWorker: "backend-dev" }],
    autoDispatch: { default: "auto", rules: [{ id: "rule-1", action: "auto", match: { labels: ["bug"] } }] },
  };
  const projectConfigService = {
    getEffective: () => ({ linearSync: legacyConfig }),
  };
  const workflowFileService = createLinearWorkflowFileService({ projectRoot: root });
  return { db, root, projectId, projectConfigService, workflowFileService };
}

describe("flowPolicyService", () => {
  it("bootstraps from generated migration, saves repo workflows, and rolls back revisions", async () => {
    const fixture = await createFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
      workflowFileService: fixture.workflowFileService,
    });

    const bootstrapped = service.getPolicy();
    expect(bootstrapped.workflows.length).toBeGreaterThan(0);
    expect(bootstrapped.migration?.needsSave).toBe(true);
    expect(bootstrapped.intake.activeStateTypes).toEqual(["backlog", "unstarted", "started"]);
    expect(bootstrapped.intake.terminalStateTypes).toEqual(["completed", "canceled"]);

    const toSave: LinearWorkflowConfig = {
      ...bootstrapped,
      workflows: bootstrapped.workflows.map((workflow, index) => ({
        ...workflow,
        priority: 200 - index,
      })),
      intake: {
        projectSlugs: ["acme-platform"],
        activeStateTypes: ["backlog", "unstarted"],
        terminalStateTypes: ["completed", "canceled"],
      },
    };

    const saved = service.savePolicy(toSave, "user-a");
    expect(saved.source).toBe("repo");
    expect(saved.intake.projectSlugs).toEqual(["acme-platform"]);
    expect(saved.intake.activeStateTypes).toEqual(["backlog", "unstarted"]);
    expect(fs.readdirSync(path.join(fixture.root, ".ade", "workflows", "linear")).some((entry) => entry.endsWith(".yaml"))).toBe(true);

    const revisions = service.listRevisions(10);
    expect(revisions.length).toBe(2);
    expect(revisions[0]?.actor).toBe("user-a");

    const bootstrapRevision = revisions.find((revision) => revision.actor === "bootstrap");
    expect(bootstrapRevision).toBeTruthy();
    const rolledBack = service.rollbackRevision(bootstrapRevision!.id, "user-b");
    expect(rolledBack.workflows[0]?.name).toBeTruthy();
    expect(service.listRevisions(10)[0]?.actor).toBe("user-b");

    fixture.db.close();
  });

  it("validates duplicate workflow ids", async () => {
    const fixture = await createFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
      workflowFileService: fixture.workflowFileService,
    });

    const validation = service.validatePolicy({
      version: 1,
      source: "generated",
      intake: {
        projectSlugs: ["acme-platform"],
        activeStateTypes: ["backlog", "unstarted", "started"],
        terminalStateTypes: ["completed", "canceled"],
      },
      settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
      workflows: [
        {
          id: "dup",
          name: "One",
          enabled: true,
          priority: 100,
          triggers: { assignees: ["CTO"] },
          target: { type: "mission" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
        {
          id: "DUP",
          name: "Two",
          enabled: true,
          priority: 90,
          triggers: { assignees: ["CTO"] },
          target: { type: "review_gate" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
      ],
      files: [],
      migration: { hasLegacyConfig: false, needsSave: true },
      legacyConfig: null,
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.join(" ")).toContain("Duplicate workflow id");

    fixture.db.close();
  });
});
