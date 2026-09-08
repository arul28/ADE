/**
 * The blocking half of a login import: fetch the OS key, snapshot the jar, read
 * and decrypt it.
 *
 * Kept as a pure function of a serialisable request, with no Electron import,
 * because it must NOT run on the main thread. Every step here blocks:
 * `/usr/bin/security` waits on a macOS consent modal with no timeout by design,
 * `secret-tool` and PowerShell are synchronous spawns, and `VACUUM INTO` plus
 * the `node:sqlite` reads are synchronous over a jar that can be tens of MB.
 * On the main thread that stalls every window's paint, every IPC handler, the
 * desktop bridge server, and every agent's `ade browser` call — indefinitely if
 * the person walks away from the Keychain prompt.
 *
 * `loginImportReadWorkerClient` runs this in a child process. The blocking is
 * then free: nothing else lives in that process.
 *
 * @module loginImport/loginImportRead
 */
import path from "node:path";

import type {
  BrowserLoginImportBlockedReason,
  BrowserLoginImportEngine,
} from "../../../../shared/types/builtInBrowserLoginImport";
import { readChromiumCookies } from "./chromiumCookies";
import { ChromiumKeyError, resolveChromiumKeys } from "./chromiumKeys";
import { CookieSnapshotError, type ImportedCookie } from "./cookieDatabase";
import { readFirefoxCookies } from "./firefoxCookies";
import { readSafariCookies, SafariCookieReadError } from "./safariCookies";

export type LoginImportReadRequest = {
  engine: BrowserLoginImportEngine;
  cookieDatabasePath: string;
  platform: NodeJS.Platform;
  keychainService?: string;
  keychainAccount?: string;
  linuxSecretApplication?: string;
  /** Chromium user-data root; `Local State` is resolved inside it. */
  chromiumUserDataDirectory?: string | null;
};

export type LoginImportReadResponse =
  | { ok: true; cookies: ImportedCookie[]; unreadable: number }
  | { ok: false; status: BrowserLoginImportBlockedReason; reason: string };

/**
 * Maps a reader failure onto the contract's blocked reasons.
 *
 * Runs beside the read rather than at the call site because the error classes
 * cannot cross a process boundary — only this `{status, reason}` pair can.
 */
export function classifyLoginImportReadFailure(
  error: unknown,
): { status: BrowserLoginImportBlockedReason; reason: string } {
  if (error instanceof SafariCookieReadError) {
    return error.reason === "needs_full_disk_access"
      ? {
          status: "needs_full_disk_access",
          reason: "ADE needs Full Disk Access to read Safari's cookies.",
        }
      : { status: "read_failed", reason: "Safari's cookie file could not be read." };
  }
  if (error instanceof ChromiumKeyError) {
    if (error.reason === "unsupported") return { status: "unsupported", reason: error.message };
    if (error.reason === "key_unavailable") return { status: "key_unavailable", reason: error.message };
    return { status: "read_failed", reason: error.message };
  }
  if (error instanceof CookieSnapshotError) {
    return {
      status: "locked",
      reason: "The browser is holding its cookie database. Quit it and try again.",
    };
  }
  return { status: "read_failed", reason: "The cookie database could not be read." };
}

/** Reads one source's jar. Never throws: failures come back classified. */
export function readLoginImportSource(request: LoginImportReadRequest): LoginImportReadResponse {
  try {
    if (request.engine === "firefox") {
      const result = readFirefoxCookies(request.cookieDatabasePath);
      return { ok: true, cookies: [...result.cookies], unreadable: result.unreadable };
    }
    if (request.engine === "safari") {
      const result = readSafariCookies(request.cookieDatabasePath);
      return { ok: true, cookies: [...result.cookies], unreadable: result.unreadable };
    }
    const root = request.chromiumUserDataDirectory ?? null;
    const keys = resolveChromiumKeys({
      platform: request.platform,
      keychainService: request.keychainService,
      keychainAccount: request.keychainAccount,
      linuxSecretApplication: request.linuxSecretApplication,
      windowsLocalStatePath: root ? path.join(root, "Local State") : undefined,
    });
    const result = readChromiumCookies(request.cookieDatabasePath, keys, request.platform);
    return { ok: true, cookies: [...result.cookies], unreadable: result.unreadable };
  } catch (error) {
    return { ok: false, ...classifyLoginImportReadFailure(error) };
  }
}
