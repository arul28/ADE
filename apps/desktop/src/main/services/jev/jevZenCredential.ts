/**
 * This machine's OpenCode Zen sign-in, which only Jev's `zen_credit` route
 * uses: free Jev needs no key. Read from OpenCode's own `opencode.db` stores,
 * cached for a minute. The token is never logged.
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { openCodeDataDirs } from "../shared/providerConfigHomes";
import { asRecord, finiteNumberOrNull } from "../shared/utils";

const CREDENTIAL_TTL_MS = 60_000;
/** A token this close to expiry reads as expired; OpenCode owns the refresh. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export type JevCredential = { ok: true; token: string } | { ok: false; reason: "not_signed_in" | "token_expired" };

let credentialCache: { at: number; value: JevCredential } | null = null;

/**
 * The OpenCode Zen login in one `opencode.db`: the `credential` row for
 * `integration_id = 'opencode'`, the active one first, else the newest. The
 * value is OpenCode's OAuth JSON (`access`, `refresh`, `expires` in ms). A
 * store that is missing, locked or shaped differently reads as no sign-in.
 */
function readZenCredential(dbPath: string, nowMs: number): JevCredential {
  if (!existsSync(dbPath)) return { ok: false, reason: "not_signed_in" };
  let db: DatabaseSync | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    // A running OpenCode may hold the write lock; answer at once rather than wait.
    db.exec("PRAGMA busy_timeout = 0");
    const row = db.prepare(`
      SELECT value FROM credential
       WHERE integration_id = 'opencode'
       ORDER BY (active = 1) DESC, time_updated DESC
       LIMIT 1
    `).get() as { value?: unknown } | undefined;
    const value = asRecord(typeof row?.value === "string" ? JSON.parse(row.value) : null);
    const access = typeof value?.access === "string" ? value.access.trim() : "";
    if (value?.type !== "oauth" || !access) return { ok: false, reason: "not_signed_in" };
    const expires = finiteNumberOrNull(value.expires);
    if (expires != null && expires <= nowMs + TOKEN_EXPIRY_SLACK_MS) return { ok: false, reason: "token_expired" };
    return { ok: true, token: access };
  } catch {
    return { ok: false, reason: "not_signed_in" };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

/**
 * This machine's OpenCode Zen sign-in. Stores are searched in
 * `openCodeDataDirs` order (ADE's own store first) and the first usable token
 * wins.
 */
export function jevAvailability(nowMs: number): JevCredential {
  if (credentialCache && nowMs - credentialCache.at < CREDENTIAL_TTL_MS) return credentialCache.value;
  let value: JevCredential = { ok: false, reason: "not_signed_in" };
  for (const dir of openCodeDataDirs({ homeDir: homedir() })) {
    const found = readZenCredential(path.join(dir, "opencode.db"), nowMs);
    if (found.ok) {
      value = found;
      break;
    }
    if (found.reason === "token_expired") value = found;
  }
  credentialCache = { at: nowMs, value };
  return value;
}

/** The token may have been revoked or rotated: read the stores again next time. */
export function forgetJevCredential(): void {
  credentialCache = null;
}
