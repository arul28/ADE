/**
 * Shared pieces of cookie extraction: the record shape every reader produces,
 * the scope rule that keeps an imported cookie as narrow as it was, and the
 * snapshot every SQLite reader takes before touching a live browser database.
 *
 * @module loginImport/cookieDatabase
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { openReadOnlyDatabase } from "../../projects/readOnlySqlite";

/** A cookie in the shape Electron's `session.cookies.set` accepts. */
export type ImportedCookie = {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /**
   * Set only for domain cookies, which every source marks with a leading dot.
   * A host-only cookie leaves this undefined on purpose: Electron treats any
   * `domain` it is handed as marking a domain cookie and re-adds the dot, which
   * would widen a host-scoped cookie to every subdomain — and it rejects
   * `__Host-` cookies outright, since those require the field to be absent.
   */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

/**
 * Cookies recovered from one jar plus the rows that could not be read. The
 * skipped count reaches the human instead of disappearing from a partial
 * import that looks complete.
 */
export type CookieReadResult = {
  readonly cookies: ImportedCookie[];
  readonly unreadable: number;
};

/** A host without the leading dot sources put on a domain cookie. */
export function bareHost(host: string): string {
  return host.startsWith(".") ? host.slice(1) : host;
}

/**
 * The URL and `domain` Electron should register a stored row under.
 *
 * Electron matches on a URL, so the leading dot comes off for that; `domain` is
 * passed through only for cookies that actually were domain cookies.
 */
export function cookieScope(
  host: string,
  cookiePath: string,
  secure: boolean,
): { url: string; domain: string | undefined } {
  const isDomainCookie = host.startsWith(".");
  const unwrapped = bareHost(host);
  const authority = unwrapped.includes(":") && !(unwrapped.startsWith("[") && unwrapped.endsWith("]"))
    ? `[${unwrapped}]`
    : unwrapped;
  return {
    url: `${secure ? "https" : "http"}://${authority}${cookiePath || "/"}`,
    domain: isDomainCookie ? host : undefined,
  };
}

/** A cookie whose expiry has already passed is never worth importing. */
export function isExpired(cookie: ImportedCookie, nowSeconds: number): boolean {
  return cookie.expirationDate !== undefined && cookie.expirationDate <= nowSeconds;
}

export class CookieSnapshotError extends Error {
  constructor(readonly databasePath: string, cause: unknown) {
    super(`Could not snapshot the cookie database at ${databasePath}.`);
    this.name = "CookieSnapshotError";
    this.cause = cause;
  }
}

export type CookieSnapshot = {
  /** Path to the private copy. Safe to open read-write; nothing else sees it. */
  readonly path: string;
  /** Removes the temporary directory. Always call it, including on failure. */
  readonly dispose: () => void;
};

/**
 * Copies a cookie database into a private temp directory and returns the copy.
 *
 * Every engine keeps its jar open with WAL while the browser runs, so reading
 * in place can observe a torn write — and opening the browser's own file is
 * something ADE should never do. `VACUUM INTO` produces a transactionally
 * consistent copy; when the source is too locked or too old for that, a plain
 * file copy (including the `-wal`/`-shm` siblings, so the copy is replayable)
 * is the fallback.
 */
export function snapshotCookieDatabase(databasePath: string): CookieSnapshot {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ade-login-import-"));
  const target = path.join(directory, `${randomBytes(6).toString("hex")}.sqlite`);
  const dispose = (): void => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not worth failing an import over.
    }
  };

  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(databasePath);
    db.prepare("vacuum into ?").run(target);
    return { path: target, dispose };
  } catch (vacuumError) {
    try {
      fs.rmSync(target, { force: true });
      fs.copyFileSync(databasePath, target);
      for (const suffix of ["-wal", "-shm"]) {
        try {
          fs.copyFileSync(`${databasePath}${suffix}`, `${target}${suffix}`);
        } catch {
          // Absent sidecars are normal for a cleanly closed database.
        }
      }
      return { path: target, dispose };
    } catch (copyError) {
      dispose();
      throw new CookieSnapshotError(databasePath, copyError ?? vacuumError);
    }
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose data.
    }
  }
}

/** Runs `read` against a private snapshot and always cleans the snapshot up. */
export function withCookieSnapshot<T>(
  databasePath: string,
  read: (db: DatabaseSyncType) => T,
): T {
  const snapshot = snapshotCookieDatabase(databasePath);
  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(snapshot.path);
    return read(db);
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to salvage from a failed close on a throwaway copy.
    }
    snapshot.dispose();
  }
}
