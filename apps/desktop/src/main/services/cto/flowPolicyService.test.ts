import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LinearSyncConfig } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
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
  const dbPath = path.join(root, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-flow-policy";
  const state: {
    shared: Record<string, unknown>;
    local: Record<string, unknown>;
    effective: LinearSyncConfig | undefined;
  } = {
    shared: {},
    local: {},
    effective: {
      enabled: false,
      projects: [{ slug: "acme-platform" }],
    },
  };
  const projectConfigService = {
    getEffective: () => ({ linearSync: state.effective }),
    get: () => ({ shared: state.shared, local: state.local }),
    save: (candidate: { shared: Record<string, unknown>; local: Record<string, unknown> }) => {
      state.shared = candidate.shared;
      state.local = candidate.local;
      state.effective = (candidate.local.linearSync as LinearSyncConfig | undefined) ?? state.effective;
      return null;
    },
  };
  return { db, projectId, projectConfigService };
}

describe("flowPolicyService", () => {
  it("saves policies, records revisions, and rolls back revisions", async () => {
    const fixture = await createFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
    });

    const bootstrapped = service.getPolicy();
    expect(bootstrapped.enabled).toBe(false);
    expect(service.listRevisions(10).length).toBe(1);

    const saved = service.savePolicy(
      {
        enabled: true,
        projects: [{ slug: "acme-platform" }],
        autoDispatch: { default: "auto", rules: [] },
      },
      "user-a"
    );
    expect(saved.enabled).toBe(true);
    expect(saved.projects?.[0]?.slug).toBe("acme-platform");

    const revisions = service.listRevisions(10);
    expect(revisions.length).toBe(2);
    expect(revisions[0]?.actor).toBe("user-a");

    const bootstrapRevision = revisions.find((revision) => revision.actor === "bootstrap");
    expect(bootstrapRevision).toBeTruthy();
    const rolledBack = service.rollbackRevision(bootstrapRevision!.id, "user-b");
    expect(rolledBack.enabled).toBe(false);
    expect(service.listRevisions(10)[0]?.actor).toBe("user-b");

    fixture.db.close();
  });

  it("validates duplicate project slugs", async () => {
    const fixture = await createFixture();
    const service = createFlowPolicyService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectConfigService: fixture.projectConfigService,
    });

    const validation = service.validatePolicy({
      enabled: true,
      projects: [{ slug: "acme" }, { slug: "ACME" }],
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.join(" ")).toContain("Duplicate project slug");

    fixture.db.close();
  });
});
