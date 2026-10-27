/**
 * The CRR export, shared by the main connection and the export helper.
 *
 * `exportChangesPlan` is the export algorithm as a generator: it yields each
 * statement and receives its rows, so `kvDb`'s synchronous export and the
 * helper's off-thread export run the same code. `createExportHelper` is the
 * helper: a second connection, with cr-sqlite loaded, in a worker thread.
 */
import { Buffer } from "node:buffer";
import { Worker } from "node:worker_threads";
import { codedError } from "../../../shared/codedError";
import { CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE } from "../../../shared/types/sync";
import type { Logger } from "../logging/logger";

export const LOCAL_CRR_CHANGE_SUPPRESSIONS_TABLE = "local_crr_change_suppressions";

export type ExportChangesOptions = {
  maxRows?: number;
  throughDbVersion?: number;
  excludeTables?: readonly string[];
  rejectOversizedVersionGroup?: boolean;
};

export type ExportedChangeRow = {
  table_name: string;
  pk: unknown;
  cid: string;
  val: unknown;
  col_version: number;
  db_version: number;
  site_id: Uint8Array;
  cl: number;
  seq: number;
};

export type ExportPlanQuery = { sql: string; params: Array<string | number> };
/** Yielded once, after the suppression read: the driver opens its read snapshot here. */
export const EXPORT_PLAN_BEGIN_SNAPSHOT = Symbol("export-plan-begin-snapshot");

/**
 * The CRR export as a plan: it yields each statement and receives its rows, so
 * one algorithm runs on the main connection (synchronously) or on the export
 * helper connection (`exportChangesSinceOffThread`) and the two cannot drift.
 */
export function* exportChangesPlan(
  version: number,
  options: ExportChangesOptions | undefined,
  desiredSiteId: string,
): Generator<ExportPlanQuery | typeof EXPORT_PLAN_BEGIN_SNAPSHOT, ExportedChangeRow[], unknown[]> {
  const suppressionRows = (yield {
    sql: `select table_name,
                  through_db_version
             from ${LOCAL_CRR_CHANGE_SUPPRESSIONS_TABLE}
            where site_id = ?`,
    params: [desiredSiteId],
  }) as Array<{ table_name: string; through_db_version: number }>;
  const suppressions = new Map<string, number>(
    suppressionRows.map((row) => [String(row.table_name), Number(row.through_db_version)]),
  );
  const throughDbVersion = options?.throughDbVersion != null && Number.isFinite(options.throughDbVersion)
    ? Math.max(version, Math.floor(options.throughDbVersion))
    : null;
  const excludedTables = [...new Set(
    (options?.excludeTables ?? [])
      .map((table) => table.trim())
      .filter(Boolean),
  )];
  const tableFilterSql = excludedTables.length > 0
    ? ` and [table] not in (${excludedTables.map(() => "?").join(", ")})`
    : "";
  const rangeSql = throughDbVersion != null
    ? `where db_version > ? and db_version <= ?${tableFilterSql}`
    : `where db_version > ?${tableFilterSql}`;
  const rangeParams = throughDbVersion != null
    ? [version, throughDbVersion, ...excludedTables]
    : [version, ...excludedTables];
  const selectSql = `select [table] as table_name,
                pk,
                cid,
                val,
                col_version,
                db_version,
                site_id,
                cl,
                seq
           from crsql_changes
          ${rangeSql}
          order by db_version asc, cl asc, seq asc`;
  const maxRows = options?.maxRows != null && Number.isFinite(options.maxRows)
    ? Math.max(1, Math.floor(options.maxRows))
    : null;
  const survivesExportFilters = (row: ExportedChangeRow): boolean => {
    const suppressedThroughVersion = suppressions.get(row.table_name);
    if (suppressedThroughVersion == null || Number(row.db_version) > suppressedThroughVersion) {
      return true;
    }
    return Buffer.from(row.site_id).toString("hex") !== desiredSiteId;
  };
  // The crsql_changes vtab aborts a scan ("query aborted", SQLITE_ABORT)
  // whenever another connection commits mid-read. Outside a transaction
  // there is no snapshot isolation, so on a busy machine (multi-process
  // writers) every export dies. A read transaction pins the WAL snapshot
  // for the duration of the scan, making it immune to concurrent commits.
  yield EXPORT_PLAN_BEGIN_SNAPSHOT;
  if (maxRows == null) {
    return ((yield { sql: selectSql, params: rangeParams }) as ExportedChangeRow[]).filter(survivesExportFilters);
  }
  // Scan forward in maxRows-sized fetches until one yields rows that
  // survive the suppression/wipe-marker filters or the requested
  // range is exhausted. An empty return must mean "the whole range
  // was scanned": callers advance their watermark to the range end on
  // empty results, so returning [] when a truncated fetch was merely
  // filtered out would permanently skip the unscanned versions behind
  // the truncation point.
  let scanFromVersion = version;
  for (;;) {
    const scanParams = throughDbVersion != null
      ? [scanFromVersion, throughDbVersion, ...excludedTables]
      : [scanFromVersion, ...excludedTables];
    let fetched = (yield { sql: `${selectSql} limit ?`, params: [...scanParams, maxRows + 1] }) as ExportedChangeRow[];
    let truncated = false;
    if (fetched.length > maxRows) {
      truncated = true;
      // The fetch was truncated; drop the trailing (possibly incomplete)
      // db_version group so consumers only ever watermark complete groups.
      const tailVersion = Number(fetched[fetched.length - 1].db_version);
      let cut = fetched.length;
      while (cut > 0 && Number(fetched[cut - 1].db_version) === tailVersion) cut -= 1;
      if (cut > 0) {
        fetched = fetched.slice(0, cut);
      } else {
        if (options?.rejectOversizedVersionGroup === true) {
          throw codedError(
            `CRR version group ${tailVersion} exceeds the ${maxRows}-row export limit.`,
            CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE,
          );
        }
        // A single transaction touched more rows than maxRows. Fetch that
        // one version group in full — bounded by the group itself.
        fetched = (yield {
          sql: `select [table] as table_name,
                pk,
                cid,
                val,
                col_version,
                db_version,
                site_id,
                cl,
                seq
           from crsql_changes
          where db_version > ? and db_version <= ?${tableFilterSql}
          order by db_version asc, cl asc, seq asc`,
          params: [scanFromVersion, tailVersion, ...excludedTables],
        }) as ExportedChangeRow[];
      }
    }
    const rows = fetched.filter(survivesExportFilters);
    if (rows.length > 0 || !truncated || fetched.length === 0) return rows;
    // Every fetched row was filtered out but the scan stopped short of
    // the range end — continue from the last scanned version group.
    scanFromVersion = Number(fetched[fetched.length - 1].db_version);
  }
}

export type ExportHelper = {
  run: (plan: Generator<ExportPlanQuery | typeof EXPORT_PLAN_BEGIN_SNAPSHOT, ExportedChangeRow[], unknown[]>) => Promise<ExportedChangeRow[]>;
  /** `waitForRelease`: block (bounded) until the helper's connection is closed; a database close needs it, dropping a failed helper does not. */
  close: (waitForRelease: boolean) => void;
};

/**
 * How long `close` waits for the helper to finalize cr-sqlite and close its
 * connection. An export window reads in well under a second; the bound only
 * matters when the helper is mid-read as the database closes.
 */
const EXPORT_HELPER_CLOSE_WAIT_MS = 5_000;
/**
 * A helper statement that has not answered by now marks the helper failed, so
 * the export falls back to the main connection instead of holding the peer's
 * pump (the whole 221k-row history of a real project reads in ~2.3 s).
 */
const EXPORT_HELPER_STATEMENT_TIMEOUT_MS = 30_000;

const EXPORT_HELPER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const closed = new Int32Array(workerData.closedFlag);
let db = null;
try {
  db = new DatabaseSync(workerData.dbPath, { allowExtension: true });
  db.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs);
  db.enableLoadExtension(true);
  db.loadExtension(workerData.extensionPath);
  db.enableLoadExtension(false);
} catch (error) {
  parentPort.postMessage({ type: "failed", error: String(error && error.message || error) });
}
const statements = new Map();
const closeDb = () => {
  if (db) {
    try { db.exec("select crsql_finalize()"); } catch {}
    try { db.close(); } catch {}
    db = null;
  }
  Atomics.store(closed, 0, 1);
  Atomics.notify(closed, 0);
};
parentPort.on("message", (message) => {
  if (message.type === "close") { closeDb(); return; }
  try {
    if (!db) throw new Error("export helper connection is not open");
    let rows = [];
    if (message.type === "begin") db.exec("BEGIN");
    else if (message.type === "end") {
      try { db.exec("COMMIT"); } catch { try { db.exec("ROLLBACK"); } catch {} }
    } else {
      let statement = statements.get(message.sql);
      if (!statement) {
        statement = db.prepare(message.sql);
        if (statements.size >= 64) statements.clear();
        statements.set(message.sql, statement);
      }
      rows = statement.all(...message.params);
    }
    parentPort.postMessage({ type: "result", id: message.id, rows });
  } catch (error) {
    parentPort.postMessage({ type: "result", id: message.id, error: String(error && error.message || error) });
  }
});
`;

/**
 * A read-only export connection in a worker thread. Exports run one at a time
 * (a connection holds one snapshot); each runs the shared plan, with every
 * statement answered by the worker inside one read transaction.
 */
export function createExportHelper(dbPath: string, extensionPath: string, busyTimeoutMs: number, logger: Logger): ExportHelper {
  const closedFlag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(EXPORT_HELPER_SOURCE, {
    eval: true,
    workerData: { dbPath, extensionPath, busyTimeoutMs, closedFlag },
  });
  worker.unref();
  let failure: Error | null = null;
  let nextId = 0;
  const waiting = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error): void => {
    failure ??= error;
    for (const entry of waiting.values()) entry.reject(failure);
    waiting.clear();
  };
  worker.on("message", (message: { type: string; id?: number; rows?: unknown[]; error?: string }) => {
    if (message.type === "failed") {
      failAll(new Error(`export helper could not open the database: ${message.error}`));
      return;
    }
    const entry = message.id == null ? undefined : waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id!);
    if (message.error != null) entry.reject(new Error(message.error));
    else entry.resolve(message.rows ?? []);
  });
  worker.on("error", (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", (code) => failAll(new Error(`export helper exited (${code})`)));
  const send = (message: { type: "begin" | "end" } | { type: "all"; sql: string; params: Array<string | number> }): Promise<unknown[]> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failAll(new Error(`export helper did not answer within ${EXPORT_HELPER_STATEMENT_TIMEOUT_MS} ms`));
      }, EXPORT_HELPER_STATEMENT_TIMEOUT_MS);
      timer.unref?.();
      waiting.set(id, {
        resolve: (rows) => { clearTimeout(timer); resolve(rows); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      worker.postMessage({ ...message, id });
    });
  };
  let queue: Promise<unknown> = Promise.resolve();
  const runPlan = async (
    plan: Generator<ExportPlanQuery | typeof EXPORT_PLAN_BEGIN_SNAPSHOT, ExportedChangeRow[], unknown[]>,
  ): Promise<ExportedChangeRow[]> => {
    let opened = false;
    try {
      let step = plan.next();
      while (!step.done) {
        const query = step.value;
        if (query === EXPORT_PLAN_BEGIN_SNAPSHOT) {
          await send({ type: "begin" });
          opened = true;
          step = plan.next([]);
        } else {
          step = plan.next(await send({ type: "all", sql: query.sql, params: query.params }));
        }
      }
      return step.value;
    } finally {
      if (opened) await send({ type: "end" }).catch(() => undefined);
    }
  };
  return {
    run: (plan) => {
      const result = queue.then(() => runPlan(plan));
      queue = result.catch(() => undefined);
      return result;
    },
    close: (waitForRelease) => {
      failAll(new Error("export helper closed"));
      if (!waitForRelease) {
        void worker.terminate();
        return;
      }
      try {
        worker.postMessage({ type: "close" });
        // cr-sqlite must be finalized before this connection's file is
        // closed, renamed or moved (on Windows its handle outlives a plain
        // close), so close waits, bounded, for the helper to let go of it.
        const outcome = Atomics.wait(new Int32Array(closedFlag), 0, 0, EXPORT_HELPER_CLOSE_WAIT_MS);
        if (outcome === "timed-out") {
          logger.warn("db.export_helper_close_timed_out", { waitMs: EXPORT_HELPER_CLOSE_WAIT_MS });
        }
      } catch {
        // A worker that already exited holds no connection.
      }
      void worker.terminate();
    },
  };
}
