import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function listColumnNames(db: Awaited<ReturnType<typeof openKvDb>>, table: string): string[] {
  const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

describe("kvDb worker agent schema migration", () => {
  it("creates W2 worker tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-workers-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());

    const expectedTables = [
      "worker_agents",
      "worker_agent_revisions",
      "worker_agent_cost_events",
      "worker_agent_task_sessions",
      "worker_agent_runs",
    ];

    for (const table of expectedTables) {
      const hit = db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = ? limit 1",
        [table]
      );
      expect(hit?.name).toBe(table);
    }

    expect(listColumnNames(db, "worker_agents")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "slug",
        "name",
        "role",
        "reports_to",
        "capabilities_json",
        "status",
        "adapter_type",
        "adapter_config_json",
        "runtime_config_json",
        "budget_monthly_cents",
        "spent_monthly_cents",
        "last_heartbeat_at",
        "created_at",
        "updated_at",
        "deleted_at",
      ])
    );

    expect(listColumnNames(db, "worker_agent_revisions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "before_json",
        "after_json",
        "changed_keys_json",
        "had_redactions",
        "actor",
        "created_at",
      ])
    );

    expect(listColumnNames(db, "worker_agent_cost_events")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "run_id",
        "session_id",
        "provider",
        "model_id",
        "input_tokens",
        "output_tokens",
        "cost_cents",
        "estimated",
        "source",
        "occurred_at",
        "created_at",
      ])
    );

    expect(listColumnNames(db, "worker_agent_task_sessions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "adapter_type",
        "task_key",
        "payload_json",
        "cleared_at",
        "created_at",
        "updated_at",
      ])
    );

    expect(listColumnNames(db, "worker_agent_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "status",
        "wakeup_reason",
        "task_key",
        "issue_key",
        "execution_run_id",
        "execution_locked_at",
        "context_json",
        "result_json",
        "error_message",
        "started_at",
        "finished_at",
        "created_at",
        "updated_at",
      ])
    );

    const expectedIndexes = [
      "idx_worker_agents_project",
      "idx_worker_agents_project_active",
      "idx_worker_agent_revisions_agent",
      "idx_worker_agent_task_sessions_lookup",
      "idx_worker_agent_runs_agent",
      "idx_worker_agent_runs_status",
      "idx_worker_agent_cost_events_agent",
      "idx_worker_agent_cost_events_month",
    ];

    for (const indexName of expectedIndexes) {
      const hit = db.get<{ name: string }>(
        "select name from sqlite_master where type = 'index' and name = ? limit 1",
        [indexName]
      );
      expect(hit?.name).toBe(indexName);
    }

    db.close();
  });
});
