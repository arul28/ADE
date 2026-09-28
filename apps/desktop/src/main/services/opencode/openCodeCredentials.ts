import fs from "node:fs";
import path from "node:path";
import { resolveAdeOpenCodeStoreDir } from "../../../shared/opencodeDataHome";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";

/**
 * Non-secret facts about the credentials in an OpenCode 2.0 store.
 *
 * 2.0 keeps logins and saved keys in the `credential` table instead of
 * `auth.json`. `value` is JSON holding the secret itself, so only `type` and
 * `metadata.accountID` are extracted, inside SQLite: token fields never reach
 * this process.
 */
export type OpenCodeCredentialSummary = {
  id: string;
  integrationId: string;
  label: string;
  methodId: string | null;
  type: "key" | "oauth" | null;
  accountId: string | null;
  active: boolean;
  updatedAt: number;
};

/** `opencode.db` of ADE's owned store, the one every ADE-managed server writes. */
export function resolveAdeOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAdeOpenCodeStoreDir(env), "opencode.db");
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Every credential row, active ones first. A missing, locked, or older store
 * (no `credential` table) reads as none — never an error.
 */
export function readOpenCodeCredentials(dbPath: string = resolveAdeOpenCodeDbPath()): OpenCodeCredentialSummary[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    // A running server may hold the write lock; answer at once rather than wait.
    db.exec("PRAGMA busy_timeout = 0");
    const rows = db.prepare(`
      SELECT id AS id,
             integration_id AS integrationId,
             label AS label,
             method_id AS methodId,
             active AS active,
             time_updated AS updatedAt,
             json_extract(value, '$.type') AS type,
             json_extract(value, '$.metadata.accountID') AS accountId
        FROM credential
       ORDER BY (active = 1) DESC, time_updated DESC
    `).all() as Array<Record<string, unknown>>;
    const out: OpenCodeCredentialSummary[] = [];
    for (const row of rows) {
      const id = textOrNull(row.id);
      const integrationId = textOrNull(row.integrationId);
      if (!id || !integrationId) continue;
      const type = row.type === "key" || row.type === "oauth" ? row.type : null;
      out.push({
        id,
        integrationId,
        label: textOrNull(row.label) ?? integrationId,
        methodId: textOrNull(row.methodId),
        type,
        accountId: textOrNull(row.accountId),
        active: row.active === 1 || row.active === 1n,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Number(row.updatedAt ?? 0) || 0,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}
