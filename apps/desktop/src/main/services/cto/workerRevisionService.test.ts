import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createWorkerAgentService } from "./workerAgentService";
import { createWorkerRevisionService } from "./workerRevisionService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-revisions-"));
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
  const workerRevisionService = createWorkerRevisionService({
    db,
    projectId,
    workerAgentService,
  });
  return { db, projectId, workerAgentService, workerRevisionService };
}

describe("workerRevisionService", () => {
  it("records revisions on create and update with changed-key detection", async () => {
    const fixture = await createFixture();
    const created = fixture.workerRevisionService.saveAgent(
      {
        name: "Worker A",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: { model: "sonnet" },
      },
      "tester"
    );
    fixture.workerRevisionService.saveAgent(
      {
        id: created.id,
        name: "Worker Alpha",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: { model: "opus" },
        capabilities: ["api"],
      },
      "tester"
    );

    const revisions = fixture.workerRevisionService.listAgentRevisions(created.id, 10);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions.some((revision) => revision.changedKeys.some((key) => key.includes("name")))).toBe(true);
    expect(revisions.some((revision) => revision.changedKeys.some((key) => key.includes("adapterConfig.model")))).toBe(true);

    fixture.db.close();
  });

  it("rolls back to selected revision snapshot", async () => {
    const fixture = await createFixture();
    const created = fixture.workerRevisionService.saveAgent(
      {
        name: "Rollback Worker",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: { model: "sonnet" },
      },
      "tester"
    );

    fixture.workerRevisionService.saveAgent(
      {
        id: created.id,
        name: "Rollback Worker v2",
        role: "engineer",
        adapterType: "codex-local",
        adapterConfig: { model: "gpt-5.3-codex" },
      },
      "tester"
    );
    const revisions = fixture.workerRevisionService.listAgentRevisions(created.id, 10);
    const revisionToRollback = revisions.find((entry) => entry.before.name === "Rollback Worker");
    expect(revisionToRollback).toBeTruthy();

    const restored = fixture.workerRevisionService.rollbackAgentRevision(
      created.id,
      revisionToRollback!.id,
      "tester"
    );
    expect(restored.name).toBe("Rollback Worker");
    expect(restored.adapterType).toBe("claude-local");

    fixture.db.close();
  });

  it("blocks rollback when revision has redactions", async () => {
    const fixture = await createFixture();
    const created = fixture.workerRevisionService.saveAgent(
      {
        name: "Redacted Worker",
        role: "researcher",
        adapterType: "openclaw-webhook",
        adapterConfig: {
          url: "https://example.com",
          headers: { Authorization: "${env:OPENCLAW_WEBHOOK_TOKEN}" },
        },
      },
      "tester"
    );

    const redactedRevisionId = "rev-redacted";
    fixture.db.run(
      `
        insert into worker_agent_revisions(
          id, project_id, agent_id, before_json, after_json, changed_keys_json, had_redactions, actor, created_at
        ) values(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        redactedRevisionId,
        fixture.projectId,
        created.id,
        JSON.stringify({ ...created, name: "__REDACTED__" }),
        JSON.stringify(created),
        JSON.stringify(["adapterConfig.headers.Authorization"]),
        1,
        "tester",
        new Date().toISOString(),
      ]
    );

    expect(() =>
      fixture.workerRevisionService.rollbackAgentRevision(created.id, redactedRevisionId, "tester")
    ).toThrow(/redacted/i);

    fixture.db.close();
  });
});
