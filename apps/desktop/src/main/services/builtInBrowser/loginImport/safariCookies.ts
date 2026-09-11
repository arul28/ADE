/**
 * Safari cookie extraction.
 *
 * Safari does not encrypt its cookies; it stores them in a proprietary
 * `Cookies.binarycookies` file inside its app container. The protection is TCC,
 * not cryptography — the file lives under a path only apps with Full Disk
 * Access may read, so the gate is a permission the human grants in System
 * Settings rather than a key to obtain.
 *
 * The format, big-endian throughout except the page bodies:
 *
 *   magic "cook", u32 pageCount, u32 pageSize[pageCount], then each page:
 *     u32 0x00000100, u32le cookieCount, u32le cookieOffset[cookieCount],
 *     then each cookie:
 *       u32le size, u32le unknown, u32le flags, u32le unknown,
 *       u32le urlOffset, nameOffset, pathOffset, valueOffset,
 *       u64 end-of-header, f64 expiry, f64 creation, then NUL-terminated
 *       strings at the offsets above (relative to the cookie start).
 *
 * @module loginImport/safariCookies
 */
import fs from "node:fs";

import { cookieScope, type CookieReadResult, type ImportedCookie } from "./cookieDatabase";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** `u32 0x00000100`, `u32le cookieCount`, then one `u32le` offset per cookie. */
const COOKIE_PAGE_HEADER_SIZE = 12;
/** Through the `f64 creation` field; string bytes follow. */
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export type SafariReadFailure = "needs_full_disk_access" | "read_failed";

export class SafariCookieReadError extends Error {
  constructor(
    readonly reason: SafariReadFailure,
    readonly cookiePath?: string,
    cause?: unknown,
  ) {
    super(
      cookiePath === undefined
        ? `Could not read Safari cookies: ${reason}.`
        : `Could not read Safari cookies at ${cookiePath}: ${reason}.`,
    );
    this.name = "SafariCookieReadError";
    this.cause = cause;
  }
}

/** Reads a NUL-terminated string at an offset. */
function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

/**
 * Parses a `Cookies.binarycookies` buffer.
 *
 * Every declared structure is bounds-checked against what the file actually
 * contains, and a mismatch throws. `Buffer.subarray` clamps silently, so
 * accepting a short page or an overlong record would return a cookie set that is
 * quietly missing entries or carrying fields read out of the next record — a
 * partial import the human has no way to notice.
 */
export function parseBinaryCookies(buffer: Buffer): ImportedCookie[] {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new SafariCookieReadError("read_failed");
  }

  const pageCount = buffer.readUInt32BE(4);
  if (8 + pageCount * 4 > buffer.length) throw new SafariCookieReadError("read_failed");

  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw new SafariCookieReadError("read_failed");
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) throw new SafariCookieReadError("read_failed");

    // Every record accepted so far, so a later offset cannot point back into
    // one of them: the page header, the offset table, and earlier records are
    // all bytes that would otherwise parse as a fabricated cookie.
    const accepted: Array<[start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw new SafariCookieReadError("read_failed");
      }
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE
        || cookieEnd > page.length
        || accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw new SafariCookieReadError("read_failed");
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      // Offsets are relative to the record; one pointing outside it would
      // otherwise read a neighbouring cookie's bytes as this one's value.
      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length,
        )
      ) {
        throw new SafariCookieReadError("read_failed");
      }
      const host = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const cookiePath = readCString(cookie, pathOffset) || "/";
      const value = readCString(cookie, valueOffset);
      if (host === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      const scope = cookieScope(host, cookiePath, secure);
      cookies.push({
        url: scope.url,
        name,
        value,
        domain: scope.domain,
        path: cookiePath,
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate: expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined,
        // Bits 3-5 of the flags carry something SameSite-shaped, but no public
        // description of them agrees and real jars do not match any of them
        // cleanly. Lax is the modern browser default; claiming "none" would
        // widen every imported cookie's scope.
        sameSite: "lax",
      });
    }
  }

  // Safari writes an 8-byte checksum after the pages, then an optional
  // length-prefixed property list. Anything else past the declared pages — in
  // particular whole extra pages — means the page table does not describe the
  // file, and a jar the header lies about is refused rather than imported with
  // cookies silently missing.
  const trailer = buffer.length - pageStart;
  const validTrailer =
    trailer === 0
    || trailer === 8
    || (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) throw new SafariCookieReadError("read_failed");

  return cookies;
}

/**
 * Whether a filesystem error is TCC refusing access.
 *
 * TCC denies with **EPERM**. EACCES is an ordinary POSIX permission or ACL
 * failure that granting Full Disk Access cannot fix, so it stays a plain read
 * failure rather than sending the human to a grant that will not help.
 */
export function isFullDiskAccessDenial(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EPERM";
}

/**
 * Whether reading the jar is refused by TCC.
 *
 * `stat` succeeds on the jar inside Safari's container even without Full Disk
 * Access — that is what lets the listing find it — so presence alone cannot tell
 * granted from denied. Opening it for read is what TCC gates.
 */
export function safariAccessDenied(cookiePath: string): boolean {
  let handle: number | null = null;
  try {
    handle = fs.openSync(cookiePath, "r");
    return false;
  } catch (error) {
    return isFullDiskAccessDenial(error);
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Closing a probe handle cannot fail in a way that matters.
      }
    }
  }
}

export function readSafariCookies(cookiePath: string): CookieReadResult {
  let contents: Buffer;
  try {
    contents = fs.readFileSync(cookiePath);
  } catch (error) {
    // macOS never prompts for Full Disk Access — the read simply fails, with
    // EPERM — so this is where a missing grant becomes a typed result the
    // wizard can act on instead of a generic failure.
    throw new SafariCookieReadError(
      isFullDiskAccessDenial(error) ? "needs_full_disk_access" : "read_failed",
      cookiePath,
      error,
    );
  }
  try {
    return { cookies: parseBinaryCookies(contents), unreadable: 0 };
  } catch (error) {
    throw error instanceof SafariCookieReadError
      ? new SafariCookieReadError(error.reason, cookiePath, error)
      : new SafariCookieReadError("read_failed", cookiePath, error);
  }
}
