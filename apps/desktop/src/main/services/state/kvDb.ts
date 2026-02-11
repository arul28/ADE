import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import type { Logger } from "../logging/logger";

type KvDb = {
  getJson: <T>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;
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

export async function openKvDb(dbPath: string, logger: Logger): Promise<KvDb> {
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

  db.run("create table if not exists kv (key text primary key, value text not null)");

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

  return {
    getJson: <T,>(key: string): T | null => {
      const raw = getString(key);
      if (raw == null) return null;
      return safeJsonParse<T>(raw);
    },
    setJson: (key: string, value: unknown) => {
      setString(key, JSON.stringify(value));
    },
    flushNow: () => flushNow(),
    close: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushNow();
      db.close();
    }
  };
}

