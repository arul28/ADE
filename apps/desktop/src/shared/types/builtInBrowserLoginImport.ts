import type { SystemSettingsPaneId } from "./systemSettings";

/**
 * Contract for importing existing browser logins (cookies only) into ADE's
 * global authenticated browser profile.
 *
 * This is a *human-only* capability: the whole point is that a person, sitting
 * at their own machine, decides which sites ADE's browser may reuse a session
 * for. It is deliberately absent from the agent bridge (`ade browser`) and from
 * every daemon action domain — an agent that could import cookies could hand
 * itself any logged-in identity on the machine.
 *
 * Passwords are out of scope: Electron has no password store to import into,
 * and reading a browser's password vault is a materially different (and far
 * broader) consent than reading its cookie jar.
 */

/** Which cookie-storage engine a source browser uses. */
export type BrowserLoginImportEngine = "chromium" | "firefox" | "safari";

/** Platforms ADE knows how to import from, plus a catch-all. */
export type BrowserLoginImportPlatform = "darwin" | "win32" | "linux" | "other";

/**
 * Why a source cannot be imported from right now.
 *
 * - `unsupported` — the engine cannot be read on this OS at all (Windows
 *   Chromium's app-bound encryption). Not retryable.
 * - `needs_full_disk_access` — macOS TCC refused the read (EPERM). Retryable
 *   once the human grants Full Disk Access in System Settings.
 * - `not_installed` — the browser or profile is not on this machine.
 * - `locked` — the source browser holds the database and it could not be
 *   snapshotted. Retryable after quitting it.
 * - `key_unavailable` — the OS credential store did not hand over the
 *   decryption key (keychain denial, missing libsecret, DPAPI failure).
 * - `read_failed` — anything else.
 */
export type BrowserLoginImportBlockedReason =
  | "unsupported"
  | "needs_full_disk_access"
  | "not_installed"
  | "locked"
  | "key_unavailable"
  | "read_failed";

export type BrowserLoginImportSourceStatus = "ready" | BrowserLoginImportBlockedReason;

/** Per-browser answer to "can ADE import from this on this OS?". */
export type BrowserLoginImportCapability = {
  browserId: string;
  browserName: string;
  engine: BrowserLoginImportEngine;
  supported: boolean;
  /** Present (and shown verbatim) only when `supported` is false. */
  reason: string | null;
};

export type BrowserLoginImportCapabilities = {
  platform: BrowserLoginImportPlatform;
  /** False for every browser on an OS ADE has no reader for. */
  anySupported: boolean;
  browsers: BrowserLoginImportCapability[];
};

/**
 * One importable (browser × profile) pair. `id` is opaque to the renderer and
 * is the only thing that crosses IPC to name a source.
 */
export type BrowserLoginImportSource = {
  id: string;
  browserId: string;
  browserName: string;
  engine: BrowserLoginImportEngine;
  profileId: string;
  profileName: string;
  status: BrowserLoginImportSourceStatus;
  /** Human-readable explanation when `status !== "ready"`. */
  reason: string | null;
  /**
   * OS settings pane the renderer can offer to open for
   * `needs_full_disk_access`. An id, not a URL: `x-apple.systempreferences:` is
   * outside the external-URL scheme allowlist, so main resolves the id against
   * `SYSTEM_SETTINGS_PANE_URLS` and calls `shell.openExternal` itself.
   */
  settingsPaneId: SystemSettingsPaneId | null;
};

export type BrowserLoginImportListSourcesResult = {
  platform: BrowserLoginImportPlatform;
  sources: BrowserLoginImportSource[];
  capabilities: BrowserLoginImportCapabilities;
};

/**
 * A domain the human can select before importing. Counts are computed from the
 * source jar; cookie values never leave the main process.
 */
export type BrowserLoginImportDomain = {
  /** Host without the leading dot browsers put on domain cookies. */
  domain: string;
  /** Cookies that would be imported if this domain is selected. */
  cookieCount: number;
  /** Already-expired cookies, which are never imported. */
  expiredCount: number;
  /** Of `cookieCount`, how many have no expiry (imported as session cookies). */
  sessionCookieCount: number;
};

export type BrowserLoginImportFailure = {
  ok: false;
  sourceId: string;
  status: BrowserLoginImportBlockedReason;
  reason: string;
  settingsPaneId: SystemSettingsPaneId | null;
};

export type BrowserLoginImportListDomainsResult =
  | {
      ok: true;
      sourceId: string;
      domains: BrowserLoginImportDomain[];
      /** Rows ADE could not decrypt or parse; surfaced so a partial read is honest. */
      unreadableCount: number;
    }
  | BrowserLoginImportFailure;

export type BrowserLoginImportDomainOutcome = {
  domain: string;
  imported: number;
  skipped: number;
};

export type BrowserLoginImportResult =
  | {
      ok: true;
      sourceId: string;
      importedCount: number;
      skippedCount: number;
      domains: BrowserLoginImportDomainOutcome[];
    }
  | BrowserLoginImportFailure;

export type BrowserLoginImportListDomainsArgs = { sourceId: string };
export type BrowserLoginImportArgs = { sourceId: string; domains: string[] };


