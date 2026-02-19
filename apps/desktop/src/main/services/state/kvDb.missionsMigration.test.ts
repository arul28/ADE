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

describe("kvDb mission schema migration", () => {
  it("creates mission tables and key indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-missions-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());

    const expectedTables = [
      "missions",
      "mission_steps",
      "mission_events",
      "mission_artifacts",
      "mission_interventions"
    ];

    for (const table of expectedTables) {
      const hit = db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = ? limit 1",
        [table]
      );
      expect(hit?.name).toBe(table);
    }

    expect(listColumnNames(db, "missions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "lane_id",
        "title",
        "prompt",
        "status",
        "priority",
        "execution_mode",
        "target_machine_id",
        "outcome_summary",
        "last_error",
        "metadata_json",
        "created_at",
        "updated_at",
        "started_at",
        "completed_at"
      ])
    );

    expect(listColumnNames(db, "mission_steps")).toEqual(
      expect.arrayContaining(["mission_id", "step_index", "status", "started_at", "completed_at"])
    );

    const expectedIndexes = [
      "idx_missions_project_updated",
      "idx_mission_steps_mission_index",
      "idx_mission_events_mission_created",
      "idx_mission_artifacts_mission_created",
      "idx_mission_interventions_mission_status"
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
