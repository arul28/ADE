import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";

const require = createRequire(import.meta.url);

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void };
  close: () => void;
};

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeDbPath(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(root, ".ade", "kv.sqlite");
}

describe("kvDb pipeline settings migration", () => {
  it("backfills legacy default-shaped PtM settings without touching customized rows", async () => {
    const dbPath = makeDbPath("ade-kvdb-pipeline-settings-legacy-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table pr_pipeline_settings (
        pr_id text primary key,
        auto_merge integer not null default 0,
        merge_method text not null default 'repo_default',
        max_rounds integer not null default 5,
        on_rebase_needed text not null default 'pause',
        conflict_strategy text not null default 'pause',
        force_finalize_mode text not null default 'off',
        force_finalize_require_no_ci_failures integer not null default 1,
        early_merge_on_green integer not null default 1,
        auto_agent_provider text,
        auto_agent_model text,
        auto_agent_reasoning_effort text,
        auto_agent_permission_mode text,
        auto_agent_confidence_threshold real,
        at_cap_policy text,
        at_cap_wait_minutes integer,
        at_cap_ci_retry_max integer,
        force_merge_requires_confirmation integer,
        updated_at text not null
      );
    `);
    const insert = rawDb.prepare(`
      insert into pr_pipeline_settings (
        pr_id, auto_merge, merge_method, max_rounds, on_rebase_needed,
        conflict_strategy, force_finalize_mode, force_finalize_require_no_ci_failures,
        early_merge_on_green, at_cap_policy, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("pr-legacy", 0, "repo_default", 5, "pause", "pause", "off", 1, 1, null, "2026-05-01T00:00:00.000Z");
    insert.run("pr-custom", 0, "squash", 5, "pause", "pause", "off", 1, 1, "stop", "2026-05-01T00:00:00.000Z");
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      const legacy = db.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-legacy"],
      );
      expect(legacy).toEqual({
        auto_merge: 1,
        force_finalize_mode: "conditional",
        at_cap_policy: "ci_retry_once",
      });

      const custom = db.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-custom"],
      );
      expect(custom).toEqual({
        auto_merge: 0,
        force_finalize_mode: "off",
        at_cap_policy: "stop",
      });

      db.run(
        "update pr_pipeline_settings set auto_merge = 0, force_finalize_mode = 'off', at_cap_policy = 'stop' where pr_id = ?",
        ["pr-legacy"],
      );
    } finally {
      db.close();
    }

    const reopened = await openKvDb(dbPath, createLogger() as any);
    try {
      const legacyAfterUserOverride = reopened.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-legacy"],
      );
      expect(legacyAfterUserOverride).toEqual({
        auto_merge: 0,
        force_finalize_mode: "off",
        at_cap_policy: "stop",
      });
    } finally {
      reopened.close();
    }
  });
});
