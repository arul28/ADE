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
        discardUnpublishedChangesForTables: () => {},
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

  it("clamps the limit argument into the [1, 1000] range and floors fractional values", () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, name) values('lane-1', 'project-1', 'Lane 1')");
    const service = createOperationService({ db, projectId: "project-1" });

    for (let i = 0; i < 5; i += 1) {
      const minute = String(i).padStart(2, "0");
      insertOperation(db, {
        id: `head-${i}`,
        kind: "git_commit",
        startedAt: `2026-05-22T00:${minute}:00.000Z`,
        preHeadSha: `pre-${i}`,
        postHeadSha: `post-${i}`,
      });
    }

    expect(service.listHeadChanges({ laneId: "lane-1", limit: 0 })).toHaveLength(1);
    expect(service.listHeadChanges({ laneId: "lane-1", limit: -50 })).toHaveLength(1);
    expect(service.listHeadChanges({ laneId: "lane-1", limit: 2.7 })).toHaveLength(2);
    expect(service.listHeadChanges({ laneId: "lane-1", limit: 10_000 })).toHaveLength(5);
  });
});

describe("operationService start/finish lifecycle", () => {
  it("persists started operations as running and finalises them with merged metadata", () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, name) values('lane-1', 'project-1', 'Lane 1')");
    const service = createOperationService({ db, projectId: "project-1" });

    const { operationId, startedAt } = service.start({
      laneId: "lane-1",
      kind: "git_pull",
      preHeadSha: "before",
      metadata: { source: "remote", attempt: 1 },
    });

    const running = service.get(operationId);
    expect(running).toMatchObject({
      id: operationId,
      laneId: "lane-1",
      laneName: "Lane 1",
      kind: "git_pull",
      status: "running",
      preHeadSha: "before",
      postHeadSha: null,
      endedAt: null,
      startedAt,
    });
    expect(JSON.parse(running?.metadataJson ?? "{}")).toEqual({ source: "remote", attempt: 1 });

    service.finish({
      operationId,
      status: "succeeded",
      postHeadSha: "after",
      metadataPatch: { attempt: 2, durationMs: 42 },
    });

    const finished = service.get(operationId);
    expect(finished).toMatchObject({
      id: operationId,
      status: "succeeded",
      preHeadSha: "before",
      postHeadSha: "after",
    });
    expect(finished?.endedAt).not.toBeNull();
    expect(JSON.parse(finished?.metadataJson ?? "{}")).toEqual({
      source: "remote",
      attempt: 2,
      durationMs: 42,
    });
  });

  it("ignores get() lookups across projects and treats blank ids as not-found", () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, name) values('lane-1', 'project-1', 'Lane 1')");
    db.run("insert into lanes(id, project_id, name) values('lane-x', 'project-2', 'Lane X')");
    const service = createOperationService({ db, projectId: "project-1" });
    const foreign = createOperationService({ db, projectId: "project-2" });

    const own = service.recordCompleted({
      laneId: "lane-1",
      kind: "git_fetch",
      preHeadSha: "p",
      postHeadSha: "q",
      metadata: { remote: "origin" },
    });

    expect(service.get(own.operationId)).toMatchObject({
      id: own.operationId,
      kind: "git_fetch",
      status: "succeeded",
      laneName: "Lane 1",
    });
    expect(service.get({ id: own.operationId })).not.toBeNull();
    expect(foreign.get(own.operationId)).toBeNull();
    expect(service.get("")).toBeNull();
    expect(service.get("   ")).toBeNull();
  });
});

describe("operationService.list", () => {
  it("filters by lane, kind, and status, ordering newest first within the clamped limit", () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, name) values('lane-1', 'project-1', 'Lane 1')");
    db.run("insert into lanes(id, project_id, name) values('lane-2', 'project-1', 'Lane 2')");
    const service = createOperationService({ db, projectId: "project-1" });

    insertOperation(db, {
      id: "old-success",
      kind: "git_pull",
      startedAt: "2026-05-22T00:00:00.000Z",
      status: "succeeded",
    });
    insertOperation(db, {
      id: "new-success",
      kind: "git_pull",
      startedAt: "2026-05-22T02:00:00.000Z",
      status: "succeeded",
    });
    insertOperation(db, {
      id: "new-failed",
      kind: "git_pull",
      startedAt: "2026-05-22T03:00:00.000Z",
      status: "failed",
    });
    insertOperation(db, {
      id: "other-lane",
      laneId: "lane-2",
      kind: "git_pull",
      startedAt: "2026-05-22T04:00:00.000Z",
      status: "succeeded",
    });
    insertOperation(db, {
      id: "other-kind",
      kind: "chat_message",
      startedAt: "2026-05-22T05:00:00.000Z",
      status: "succeeded",
    });

    const laneOnly = service.list({ laneId: "lane-1" });
    expect(laneOnly.map((r) => r.id)).toEqual([
      "other-kind",
      "new-failed",
      "new-success",
      "old-success",
    ]);

    const byKindAndStatus = service.list({
      laneId: "lane-1",
      kind: "git_pull",
      status: "succeeded",
    });
    expect(byKindAndStatus.map((r) => r.id)).toEqual(["new-success", "old-success"]);
    expect(byKindAndStatus.every((r) => r.laneName === "Lane 1")).toBe(true);

    const clamped = service.list({ laneId: "lane-1", limit: 2 });
    expect(clamped.map((r) => r.id)).toEqual(["other-kind", "new-failed"]);
    expect(service.list({ laneId: "lane-1", limit: 0 })).toHaveLength(1);
  });
});
