import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import type { Logger } from "../logging/logger";

export type SqlValue = string | number | null | Uint8Array;

export type AdeDb = {
  getJson: <T>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;

  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];

  flushNow: () => void;
  close: () => void;
};

const require = createRequire(__filename);

function resolveSqlJsWasmDir(): string {
  // Ensure the wasm file can be located regardless of cwd.
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  return path.dirname(wasmPath);
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  const { columns, values } = first;
  const out: Record<string, unknown>[] = [];
  for (const row of values) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] ?? String(i)] = row[i];
    }
    out.push(obj);
  }
  return out;
}

function migrate(db: Database) {
  // Keep KV for UI layout persistence.
  db.run("create table if not exists kv (key text primary key, value text not null)");

  // Phase 0 + Phase 1 tables.
  db.run(`
    create table if not exists projects (
      id text primary key,
      root_path text not null unique,
      display_name text not null,
      default_base_ref text not null,
      created_at text not null,
      last_opened_at text not null
    )
  `);

  db.run(`
    create table if not exists lanes (
      id text primary key,
      project_id text not null,
      name text not null,
      description text,
      base_ref text not null,
      branch_ref text not null,
      worktree_path text not null,
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_lanes_project_id on lanes(project_id)");

  db.run(`
    create table if not exists terminal_sessions (
      id text primary key,
      lane_id text not null,
      pty_id text,
      title text not null,
      started_at text not null,
      ended_at text,
      exit_code integer,
      transcript_path text not null,
      head_sha_start text,
      head_sha_end text,
      status text not null,
      last_output_preview text,
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id)");
  db.run("create index if not exists idx_terminal_sessions_status on terminal_sessions(status)");
}

export async function openKvDb(dbPath: string, logger: Logger): Promise<AdeDb> {
  const wasmDir = resolveSqlJsWasmDir();

  let SQL: SqlJsStatic;
  try {
    SQL = await initSqlJs({
      locateFile: (file) => path.join(wasmDir, file)
    });
  } catch (err) {
    logger.error("db.init_failed", { dbPath, err: String(err) });
    throw err;
  }

  ensureParentDir(dbPath);
  const data = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const db: Database = new SQL.Database(data);

  migrate(db);

  let dirty = false;
  let flushTimer: NodeJS.Timeout | null = null;

  const flushNow = () => {
    if (!dirty) return;
    dirty = false;
    try {
      const bytes = db.export();
      ensureParentDir(dbPath);
      fs.writeFileSync(dbPath, bytes);
      logger.debug("db.flushed", { dbPath, bytes: bytes.length });
    } catch (err) {
      logger.error("db.flush_failed", { dbPath, err: String(err) });
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushNow, 125);
  };

  const getString = (key: string): string | null => {
    const rows = db.exec("select value from kv where key = ? limit 1", [key]);
    const first = rows[0]?.values?.[0]?.[0];
    return typeof first === "string" ? first : first == null ? null : String(first);
  };

  const setString = (key: string, value: string) => {
    db.run(
      "insert into kv(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
      [key, value]
    );
    scheduleFlush();
  };

  const run = (sql: string, params: SqlValue[] = []) => {
    db.run(sql, params);
    scheduleFlush();
  };

  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] => {
    const rows = db.exec(sql, params);
    return mapExecRows(rows) as T[];
  };

  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null => {
    const rows = all<T>(sql, params);
    return rows[0] ?? null;
  };

  return {
    getJson: <T,>(key: string): T | null => {
      const raw = getString(key);
      if (raw == null) return null;
      return safeJsonParse<T>(raw);
    },
    setJson: (key: string, value: unknown) => {
      setString(key, JSON.stringify(value));
    },
    run,
    all,
    get,
    flushNow: () => flushNow(),
    close: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushNow();
      db.close();
    }
  };
}

