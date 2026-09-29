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

type ReadOnlyOpenCodeDb = ReturnType<typeof openReadOnlyDatabase>;

/**
 * Run `read` against an OpenCode store opened read-only. A missing or
 * unreadable store answers `fallback`. A running server may hold the write
 * lock, so a busy store answers at once rather than waiting.
 */
export function readOpenCodeDb<T>(dbPath: string, fallback: T, read: (db: ReadOnlyOpenCodeDb) => T): T {
  if (!fs.existsSync(dbPath)) return fallback;
  let db: ReadOnlyOpenCodeDb | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 0");
    return read(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

/**
 * Every credential row, active ones first. A missing, locked, or older store
 * (no `credential` table) reads as none — never an error.
 */
export function readOpenCodeCredentials(dbPath: string = resolveAdeOpenCodeDbPath()): OpenCodeCredentialSummary[] {
  return readOpenCodeDb(dbPath, [], (db) => {
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
  });
}

/**
 * The secret a launch needs to call an OpenCode-connected provider directly.
 *
 * The one place ADE reads a token out of OpenCode's store, and it stays in the
 * main process: the value goes into a child process's environment (or ADE's
 * private proxy config) and nowhere else — never IPC, sync, logs, or a preset.
 * `expiresAt` is only set for OAuth logins; a saved key never expires.
 */
export type OpenCodeLaunchSecret = {
  token: string;
  expiresAt: number | null;
  orgId: string | null;
};

/**
 * The OpenCode integration whose credential signs a provider in. OpenCode Go
 * has no sign-in of its own: it rides the opencode.ai account (`opencode`).
 */
export function openCodeIntegrationForProvider(providerId: string): string {
  const id = providerId.trim();
  return id === "opencode-go" ? "opencode" : id;
}

export function readOpenCodeLaunchSecret(
  providerId: string,
  dbPath: string = resolveAdeOpenCodeDbPath(),
): OpenCodeLaunchSecret | null {
  const integrationId = openCodeIntegrationForProvider(providerId);
  return readOpenCodeDb<OpenCodeLaunchSecret | null>(dbPath, null, (db) => {
    const row = db.prepare(`
      SELECT json_extract(value, '$.type') AS type,
             json_extract(value, '$.access') AS access,
             json_extract(value, '$.key') AS key,
             json_extract(value, '$.expires') AS expires,
             json_extract(value, '$.metadata.orgID') AS orgId
        FROM credential
       WHERE integration_id = ?
       ORDER BY (active = 1) DESC, time_updated DESC
       LIMIT 1
    `).get(integrationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const token = row.type === "oauth" ? textOrNull(row.access) : textOrNull(row.key);
    if (!token) return null;
    const expires = typeof row.expires === "number" ? row.expires : Number(row.expires ?? NaN);
    return {
      token,
      expiresAt: row.type === "oauth" && Number.isFinite(expires) && expires > 0 ? expires : null,
      orgId: textOrNull(row.orgId),
    };
  });
}

/** OpenCode provider ids with a usable sign-in on this machine (no secrets). */
export function readOpenCodeSignedInProviderIds(dbPath: string = resolveAdeOpenCodeDbPath()): string[] {
  const integrations = new Set(readOpenCodeCredentials(dbPath).map((row) => row.integrationId));
  // OpenCode Go first: it is the flat subscription people route; Zen bills a
  // separate balance that is often empty.
  const ids = integrations.has("opencode") ? ["opencode-go", "opencode"] : [];
  for (const id of integrations) if (id !== "opencode") ids.push(id);
  return ids;
}
