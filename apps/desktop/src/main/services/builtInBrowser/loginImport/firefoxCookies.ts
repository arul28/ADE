/**
 * Firefox cookie extraction.
 *
 * Firefox stores cookies unencrypted in `cookies.sqlite`, so there is no key to
 * fetch and no consent prompt — the file is readable by anything running as the
 * user. That is Mozilla's design, not a control being stepped around, and it is
 * why this path is identical on macOS, Windows, and Linux while the Chromium
 * one needs a per-platform credential store.
 *
 * @module loginImport/firefoxCookies
 */
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { cookieScope, withCookieSnapshot, type CookieReadResult, type ImportedCookie } from "./cookieDatabase";

/**
 * `moz_cookies.sameSite` holds nsICookie's constants: 0 = None, 1 = Lax,
 * 2 = Strict, 256 = Unset. Unset is not None — None is an explicit opt-in to
 * cross-site use — so it becomes Electron's `unspecified` and the target
 * browser applies its own default exactly as Firefox did. Anything
 * unrecognised lands there too; guessing "none" would widen a cookie's scope.
 */
const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;

/**
 * Schemas 10–14 carried a second column, `rawSameSite`: what the cookie
 * actually declared, beside a `sameSite` Firefox had already defaulted to Lax.
 * The schema-15 migration folded them back together with
 * `sameSite = UNSET where sameSite = LAX and rawSameSite = NONE`. Reading an
 * unmigrated database must apply the same rule or an undeclared cookie imports
 * as an explicit Lax.
 */
const RAW_SAMESITE_FIRST_SCHEMA = 10;
const RAW_SAMESITE_LAST_SCHEMA = 14;

/**
 * Firefox 129 (schema 16) migrated `expiry` from seconds to milliseconds. The
 * unit is decided by `pragma user_version` rather than assumed: reading a pre-16
 * profile as milliseconds expires every cookie at once, and a post-16 one as
 * seconds keeps them ~1000x too long.
 */
const EXPIRY_MILLISECONDS_SCHEMA = 16;

export function firefoxSameSite(
  value: number | null,
  rawValue: number | null,
): ImportedCookie["sameSite"] {
  // Schema 9 added the column with no default, so older rows carry NULL.
  if (value === null) return "unspecified";
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return "unspecified";
  if (value === SAMESITE_NONE) return "no_restriction";
  if (value === SAMESITE_LAX) return "lax";
  if (value === SAMESITE_STRICT) return "strict";
  return "unspecified";
}

export function firefoxExpiryToSeconds(expiry: number, schemaVersion: number): number | undefined {
  if (!Number.isFinite(expiry) || expiry <= 0) return undefined;
  return schemaVersion >= EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : Math.floor(expiry);
}

type FirefoxCookieRow = {
  host?: unknown;
  name?: unknown;
  value?: unknown;
  path?: unknown;
  expiry?: unknown;
  isSecure?: unknown;
  isHttpOnly?: unknown;
  sameSite?: unknown;
  rawSameSite?: unknown;
};

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
};

/** Reads an already-snapshotted `cookies.sqlite`. Exported for tests. */
export function readFirefoxCookieDatabase(db: DatabaseSyncType): CookieReadResult {
  const versionRow = db.prepare("pragma user_version").get() as { user_version?: unknown } | undefined;
  const schemaVersion = asNumber(versionRow?.user_version) ?? 0;
  const hasRawSameSite =
    schemaVersion >= RAW_SAMESITE_FIRST_SCHEMA && schemaVersion <= RAW_SAMESITE_LAST_SCHEMA;

  // Only the default container. Firefox isolates cookies per container and per
  // private window via `originAttributes` (`^userContextId=2`,
  // `^privateBrowsingId=1`); Electron has no equivalent identity, so importing
  // them all would collapse several identities onto one host/name/path and hand
  // ADE an arbitrary container's session.
  const sql = hasRawSameSite
    ? `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, rawSameSite
         from moz_cookies where originAttributes = ''`
    : `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, null as rawSameSite
         from moz_cookies where originAttributes = ''`;

  const rows = db.prepare(sql).all() as FirefoxCookieRow[];
  const cookies: ImportedCookie[] = [];
  let unreadable = 0;

  for (const row of rows) {
    const host = asText(row.host);
    const name = asText(row.name);
    const value = asText(row.value);
    if (!host || !name || value === null) {
      unreadable += 1;
      continue;
    }
    const cookiePath = asText(row.path) || "/";
    const secure = asNumber(row.isSecure) === 1;
    const scope = cookieScope(host, cookiePath, secure);
    cookies.push({
      url: scope.url,
      name,
      value,
      domain: scope.domain,
      path: cookiePath,
      secure,
      httpOnly: asNumber(row.isHttpOnly) === 1,
      expirationDate: firefoxExpiryToSeconds(asNumber(row.expiry) ?? 0, schemaVersion),
      sameSite: firefoxSameSite(asNumber(row.sameSite), asNumber(row.rawSameSite)),
    });
  }

  return { cookies, unreadable };
}

/** Snapshots and reads a live Firefox profile's cookie jar. */
export function readFirefoxCookies(cookieDatabasePath: string): CookieReadResult {
  return withCookieSnapshot(cookieDatabasePath, readFirefoxCookieDatabase);
}
