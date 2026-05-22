import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { AdeDb, SqlValue } from "../state/kvDb";
import { createOperationService } from "./operationService";

type SqlJsValue = string | number | null | Uint8Array;

function toSqlJsParams(params: SqlValue[]): SqlJsValue[] {
  return params.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value);
}

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  return first.values.map((row) => {
    const out: Record<string, unknown> = {};
    first.columns.forEach((column, index) => {
      out[column] = row[index];
    });
    return out;
  });
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(wasmPath), file),
  });
});

function createInMemoryAdeDb(): { db: AdeDb; raw: Database } {
  const raw = new SQL.Database();
  raw.run(`
    create table lanes(
      id text primary key,
      project_id text not null,
      name text
    );
  `);
  raw.run(`
    create table operations(
      id text primary key,
      project_id text not null,
      lane_id text,
      kind text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      pre_head_sha text,
      post_head_sha text,
      metadata_json text
    );
  `);

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, toSqlJsParams(params));
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] =>
    mapExecRows(raw.exec(sql, toSqlJsParams(params))) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null =>
    all<T>(sql, params)[0] ?? null;

  return {
    raw,
    db: {
      run,
      get,
      all,
      getJson: () => null,
      setJson: () => undefined,
      sync: {
        getSiteId: () => "site-1",
        getDbVersion: () => 0,
        exportChangesSince: () => [],
        applyChanges: () => ({
          appliedCount: 0,
          dbVersion: 0,
          touchedTables: [],
          rebuiltFts: false,
        }),
      },
      flushNow: () => undefined,
      close: () => raw.close(),
    },
  };
}

function insertOperation(
  db: AdeDb,
  args: {
    id: string;
    laneId?: string;
    kind: string;
    startedAt: string;
    status?: "running" | "succeeded" | "failed" | "canceled";
    preHeadSha?: string | null;
    postHeadSha?: string | null;
  },
) {
  db.run(
    `
      insert into operations(
        id,
        project_id,
        lane_id,
        kind,
        started_at,
        ended_at,
        status,
        pre_head_sha,
        post_head_sha,
        metadata_json
      ) values(?, 'project-1', ?, ?, ?, ?, ?, ?, ?, '{}')
    `,
    [
      args.id,
      args.laneId ?? "lane-1",
      args.kind,
      args.startedAt,
      args.status === "running" ? null : args.startedAt,
      args.status ?? "succeeded",
      args.preHeadSha ?? null,
      args.postHeadSha ?? null,
    ],
  );
}

describe("operationService.listHeadChanges", () => {
  it("finds older head changes even when newer non-head git operations are busy", () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, name) values('lane-1', 'project-1', 'Lane 1')");
    db.run("insert into lanes(id, project_id, name) values('lane-2', 'project-1', 'Lane 2')");
    const service = createOperationService({ db, projectId: "project-1" });

    insertOperation(db, {
      id: "target",
      kind: "git_cherry_pick",
      startedAt: "2026-05-22T00:00:00.000Z",
      preHeadSha: "before",
      postHeadSha: "after",
    });
    for (let i = 0; i < 120; i += 1) {
      const minutesAfterTarget = i + 1;
      const hour = String(Math.floor(minutesAfterTarget / 60)).padStart(2, "0");
      const minute = String(minutesAfterTarget % 60).padStart(2, "0");
      insertOperation(db, {
        id: `fetch-${i}`,
        kind: "git_fetch",
        startedAt: `2026-05-22T${hour}:${minute}:00.000Z`,
      });
    }
    insertOperation(db, {
      id: "failed-head-change",
      kind: "git_pull",
      startedAt: "2026-05-22T03:00:00.000Z",
      status: "failed",
      preHeadSha: "after",
      postHeadSha: "newer",
    });
    insertOperation(db, {
      id: "other-lane-head-change",
      laneId: "lane-2",
      kind: "git_pull",
      startedAt: "2026-05-22T04:00:00.000Z",
      preHeadSha: "other-before",
      postHeadSha: "other-after",
    });

    expect(service.listHeadChanges({ laneId: "lane-1", limit: 1 })).toMatchObject([
      {
        id: "target",
        laneId: "lane-1",
        laneName: "Lane 1",
        kind: "git_cherry_pick",
        status: "succeeded",
        preHeadSha: "before",
        postHeadSha: "after",
      },
    ]);
  });
});
