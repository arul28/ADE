/**
 * Chromium cookie extraction.
 *
 * Reads a Chromium-family jar and decrypts each record with the key its prefix
 * calls for. Records whose scheme ADE holds no key for are skipped rather than
 * failing the import: a Linux database can mix `v10` and `v11`, and a partial
 * result reported honestly is more useful than an all-or-nothing error.
 *
 * @module loginImport/chromiumCookies
 */
import { createDecipheriv, createHash } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { cookieScope, withCookieSnapshot, type CookieReadResult, type ImportedCookie } from "./cookieDatabase";
import type { ChromiumKeyMaterial } from "./chromiumKeys";

/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;

/**
 * Chromium timestamps count microseconds from 1601-01-01. The microsecond value
 * overflows JavaScript's safe integer range, so the division happens in SQL and
 * this only ever sees seconds.
 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/**
 * Chromium >= 127 (schema 24) prefixes the plaintext with SHA-256 of the host
 * key, binding a cookie to its domain. A mismatch voids the record rather than
 * importing 32 bytes of hash as part of the value.
 */
const DOMAIN_BOUND_SCHEMA = 24;

function stripDomainBinding(plaintext: Buffer, domain: string, schemaVersion: number): Buffer | null {
  if (schemaVersion < DOMAIN_BOUND_SCHEMA) return plaintext;
  const domainHash = createHash("sha256").update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)
    ? plaintext.subarray(32)
    : null;
}

function decryptCbc(payload: Buffer, key: Buffer, domain: string, schemaVersion: number): string | null {
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
}

function decryptGcm(payload: Buffer, key: Buffer, domain: string, schemaVersion: number): string | null {
  if (payload.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) return null;
  try {
    const nonce = payload.subarray(0, AES_GCM_NONCE_LENGTH);
    const ciphertext = payload.subarray(AES_GCM_NONCE_LENGTH, -AES_GCM_TAG_LENGTH);
    const tag = payload.subarray(-AES_GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
}

/**
 * Decrypts one stored value, choosing the scheme from its prefix. Returns null
 * when no key covers that scheme — including Windows' app-bound `v20`, which
 * ADE has no key for at all.
 */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23,
  platform: NodeJS.Platform = "linux",
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows' legacy v10 format is AES-256-GCM. App-bound records use v20 and
  // intentionally have no key here, so they fall through as undecryptable —
  // and a prefix-less blob on Windows must never be read as plaintext.
  if (platform === "win32") {
    return prefix === "v10" && keys.gcmV10
      ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
      : null;
  }

  if (prefix === "v10") {
    if (!keys.cbcV10) return null;
    return (
      decryptCbc(payload, keys.cbcV10, domain, schemaVersion)
      ?? (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (prefix === "v11") {
    if (!keys.cbcV11) return null;
    return (
      decryptCbc(payload, keys.cbcV11, domain, schemaVersion)
      ?? (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  // No recognised prefix: Chromium on macOS and Linux both treat this as legacy
  // data stored in the clear and return it as-is.
  if (platform === "darwin" || platform === "linux") {
    return stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null;
  }
  return null;
}

/**
 * Chromium stores `SameSite` as an int: -1 unspecified, 0 none, 1 lax,
 * 2 strict. Unspecified — and anything unrecognised — maps to Electron's
 * `unspecified`, never `no_restriction`, since guessing "none" widens scope.
 */
export function chromiumSameSite(value: number): ImportedCookie["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

function toUnixSeconds(webkitSeconds: number): number | undefined {
  if (!Number.isFinite(webkitSeconds) || webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
}

type ChromiumCookieRow = {
  host_key?: unknown;
  name?: unknown;
  value?: unknown;
  encrypted_value?: unknown;
  path?: unknown;
  expires_seconds?: unknown;
  is_secure?: unknown;
  is_httponly?: unknown;
  samesite?: unknown;
  top_frame_site_key?: unknown;
};

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
};
const asBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
};

/** Reads an already-snapshotted Chromium jar. Exported for tests. */
export function readChromiumCookieDatabase(
  db: DatabaseSyncType,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): CookieReadResult {
  const metaRow = db.prepare("select value from meta where key = 'version' limit 1").get() as
    | { value?: unknown }
    | undefined;
  const rawVersion = metaRow?.value;
  const schemaVersion = typeof rawVersion === "string" ? Number.parseInt(rawVersion, 10) : asNumber(rawVersion);
  const version = Number.isFinite(schemaVersion) ? schemaVersion : 0;

  // `top_frame_site_key` (partitioned / CHIPS cookies) arrived with schema 15.
  const sql = version >= 15
    ? `select host_key, name, value, encrypted_value, path,
              expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
              samesite, top_frame_site_key from cookies`
    : `select host_key, name, value, encrypted_value, path,
              expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
              samesite, '' as top_frame_site_key from cookies`;

  const rows = db.prepare(sql).all() as ChromiumCookieRow[];
  const cookies: ImportedCookie[] = [];
  let unreadable = 0;

  for (const row of rows) {
    const host = asText(row.host_key);
    const name = asText(row.name);
    if (!host || !name) {
      unreadable += 1;
      continue;
    }
    // Partitioned (CHIPS) cookies carry a top-frame key Electron cannot
    // represent; importing them unpartitioned would widen their scope.
    if ((asText(row.top_frame_site_key) ?? "") !== "") {
      unreadable += 1;
      continue;
    }
    const encrypted = asBytes(row.encrypted_value);
    const value = encrypted.length === 0
      ? asText(row.value)
      : decryptChromiumValue(encrypted, keys, host, version, platform);
    if (value === null) {
      unreadable += 1;
      continue;
    }
    const cookiePath = asText(row.path) || "/";
    const secure = asNumber(row.is_secure) === 1;
    const scope = cookieScope(host, cookiePath, secure);
    cookies.push({
      url: scope.url,
      name,
      value,
      domain: scope.domain,
      path: cookiePath,
      secure,
      httpOnly: asNumber(row.is_httponly) === 1,
      expirationDate: toUnixSeconds(asNumber(row.expires_seconds)),
      sameSite: chromiumSameSite(asNumber(row.samesite)),
    });
  }

  return { cookies, unreadable };
}

/** Snapshots and reads a live Chromium profile's cookie jar. */
export function readChromiumCookies(
  cookieDatabasePath: string,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): CookieReadResult {
  return withCookieSnapshot(cookieDatabasePath, (db) => readChromiumCookieDatabase(db, keys, platform));
}
