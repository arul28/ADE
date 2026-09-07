/**
 * The human-only login import: discover sources, list domains for consent, then
 * write the selected cookies into ADE's global authenticated browser profile.
 *
 * Three rules hold this together and none of them are negotiable:
 *
 * 1. **Human-only.** Every entry point here is reachable from the trusted ADE
 *    renderer and nowhere else — not `ade browser`, not the desktop bridge, not
 *    a daemon action domain. An agent that could import cookies could grant
 *    itself any identity on the machine.
 * 2. **Consent is per-domain.** Nothing is imported until the person has seen a
 *    domain list with counts and chosen from it.
 * 3. **Values never leave this process, and never reach a log.** Counts and host
 *    names are the only things that travel.
 *
 * @module loginImport/loginImportService
 */
import os from "node:os";
import path from "node:path";
import { session as electronSession, type Session } from "electron";

import type {
  BrowserLoginImportArgs,
  BrowserLoginImportBlockedReason,
  BrowserLoginImportCapabilities,
  BrowserLoginImportDomainOutcome,
  BrowserLoginImportFailure,
  BrowserLoginImportListDomainsArgs,
  BrowserLoginImportListDomainsResult,
  BrowserLoginImportListSourcesResult,
  BrowserLoginImportResult,
  BrowserLoginImportSource,
  BrowserLoginImportSourceStatus,
} from "../../../../shared/types/builtInBrowserLoginImport";
import { MACOS_FULL_DISK_ACCESS_SETTINGS_URL } from "../../../../shared/types/builtInBrowserLoginImport";
import type { Logger } from "../../logging/logger";
import { BUILT_IN_BROWSER_PARTITION } from "../builtInBrowserConstants";
import { CookieSnapshotError, type ImportedCookie } from "./cookieDatabase";
import { aggregateCookieDomains, selectCookiesForDomains, displayDomain } from "./cookieDomains";
import { readChromiumCookies } from "./chromiumCookies";
import { ChromiumKeyError, resolveChromiumKeys } from "./chromiumKeys";
import { readFirefoxCookies } from "./firefoxCookies";
import { readSafariCookies, safariAccessDenied, SafariCookieReadError } from "./safariCookies";
import {
  describeLoginImportCapabilities,
  discoverProfiles,
  LOGIN_IMPORT_BROWSERS,
  makeSourceId,
  toImportPlatform,
  type BrowserDefinition,
  type DiscoveredProfile,
  type LoginImportPathContext,
} from "./loginImportSources";

/**
 * How long a read jar stays in memory between `listDomains` and `import`.
 *
 * Re-reading on import would mean a second macOS Keychain prompt for the same
 * consent the person already gave, which reads as the first approval having
 * done nothing. The window is short and the cache is dropped the moment an
 * import finishes.
 */
const READ_CACHE_TTL_MS = 5 * 60 * 1000;

/** Electron serialises cookie writes anyway; a cap keeps a huge jar bounded. */
const MAX_COOKIES_PER_IMPORT = 20_000;

export type BrowserLoginImportService = ReturnType<typeof createBrowserLoginImportService>;

export type BrowserLoginImportServiceArgs = {
  getLogger?: () => Logger | null;
  /** Injected for tests; defaults to this machine. */
  pathContext?: LoginImportPathContext;
  /** Injected for tests; defaults to the built-in browser's global profile. */
  getSession?: () => Session;
  now?: () => number;
};

type ResolvedSource = {
  definition: BrowserDefinition;
  profile: DiscoveredProfile;
  source: BrowserLoginImportSource;
};

type CacheEntry = { cookies: ImportedCookie[]; unreadable: number; readAt: number };

function defaultPathContext(): LoginImportPathContext {
  return {
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA ?? null,
    localAppData: process.env.LOCALAPPDATA ?? null,
  };
}

/** Maps a reader failure onto the contract's blocked reasons. */
function classifyReadFailure(error: unknown): { status: BrowserLoginImportBlockedReason; reason: string } {
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

function settingsPaneFor(status: BrowserLoginImportSourceStatus): string | null {
  return status === "needs_full_disk_access" ? MACOS_FULL_DISK_ACCESS_SETTINGS_URL : null;
}

export function createBrowserLoginImportService(args: BrowserLoginImportServiceArgs = {}) {
  const context = args.pathContext ?? defaultPathContext();
  const now = args.now ?? (() => Date.now());
  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };
  const getSession = args.getSession
    ?? (() => electronSession.fromPartition(BUILT_IN_BROWSER_PARTITION));

  /** Jars read for the picker, so `import` does not ask for consent twice. */
  const readCache = new Map<string, CacheEntry>();

  const capabilities = (): BrowserLoginImportCapabilities =>
    describeLoginImportCapabilities(context.platform);

  const resolveSources = (): ResolvedSource[] => {
    const matrix = capabilities();
    const supported = new Map(matrix.browsers.map((entry) => [entry.browserId, entry]));
    const resolved: ResolvedSource[] = [];

    for (const definition of LOGIN_IMPORT_BROWSERS) {
      const capability = supported.get(definition.id);
      let profiles: DiscoveredProfile[] = [];
      try {
        profiles = discoverProfiles(definition, context);
      } catch {
        profiles = [];
      }
      // An unsupported browser is still listed when it is installed: silence
      // would read as "ADE didn't find Chrome", when the truth is "ADE found it
      // and cannot read it". A browser that is simply absent stays absent.
      if (profiles.length === 0) continue;

      for (const profile of profiles) {
        let status: BrowserLoginImportSourceStatus = "ready";
        let reason: string | null = null;
        if (capability && !capability.supported) {
          status = "unsupported";
          reason = capability.reason;
        } else if (definition.engine === "safari" && safariAccessDenied(profile.cookieDatabasePath)) {
          status = "needs_full_disk_access";
          reason = "ADE needs Full Disk Access to read Safari's cookies.";
        }
        resolved.push({
          definition,
          profile,
          source: {
            id: makeSourceId(definition.id, profile.id),
            browserId: definition.id,
            browserName: definition.name,
            engine: definition.engine,
            profileId: profile.id,
            profileName: profile.name,
            status,
            reason,
            settingsPaneUrl: settingsPaneFor(status),
          },
        });
      }
    }
    return resolved;
  };

  const listSources = (): BrowserLoginImportListSourcesResult => {
    const resolved = resolveSources();
    logger()?.info("built_in_browser.login_import.list_sources", {
      platform: context.platform,
      sourceCount: resolved.length,
      readyCount: resolved.filter((entry) => entry.source.status === "ready").length,
    });
    return {
      platform: toImportPlatform(context.platform),
      sources: resolved.map((entry) => entry.source),
      capabilities: capabilities(),
    };
  };

  const failure = (
    sourceId: string,
    status: BrowserLoginImportBlockedReason,
    reason: string,
  ): BrowserLoginImportFailure => ({
    ok: false,
    sourceId,
    status,
    reason,
    settingsPaneUrl: settingsPaneFor(status),
  });

  const readSource = (entry: ResolvedSource): CacheEntry => {
    const { definition, profile } = entry;
    if (definition.engine === "firefox") {
      const result = readFirefoxCookies(profile.cookieDatabasePath);
      return { cookies: [...result.cookies], unreadable: result.unreadable, readAt: now() };
    }
    if (definition.engine === "safari") {
      const result = readSafariCookies(profile.cookieDatabasePath);
      return { cookies: [...result.cookies], unreadable: result.unreadable, readAt: now() };
    }
    const root = definition.userDataDirectory(context);
    const keys = resolveChromiumKeys({
      platform: context.platform,
      keychainService: definition.keychainService,
      keychainAccount: definition.keychainAccount,
      linuxSecretApplication: definition.linuxSecretApplication,
      windowsLocalStatePath: root ? path.join(root, "Local State") : undefined,
    });
    const result = readChromiumCookies(profile.cookieDatabasePath, keys, context.platform);
    return { cookies: [...result.cookies], unreadable: result.unreadable, readAt: now() };
  };

  /** Reads a source, reusing a recent read so consent is asked for once. */
  const loadSource = (
    sourceId: string,
  ): { ok: true; entry: CacheEntry } | { ok: false; failure: BrowserLoginImportFailure } => {
    const resolved = resolveSources().find((candidate) => candidate.source.id === sourceId);
    if (!resolved) {
      return { ok: false, failure: failure(sourceId, "not_installed", "That browser profile is no longer on this machine.") };
    }
    if (resolved.source.status !== "ready") {
      return {
        ok: false,
        failure: failure(
          sourceId,
          resolved.source.status,
          resolved.source.reason ?? "This browser cannot be imported from.",
        ),
      };
    }

    const cached = readCache.get(sourceId);
    if (cached && now() - cached.readAt < READ_CACHE_TTL_MS) return { ok: true, entry: cached };

    try {
      const entry = readSource(resolved);
      readCache.set(sourceId, entry);
      return { ok: true, entry };
    } catch (error) {
      const classified = classifyReadFailure(error);
      logger()?.warn("built_in_browser.login_import.read_failed", {
        sourceId,
        browserId: resolved.definition.id,
        status: classified.status,
      });
      return { ok: false, failure: failure(sourceId, classified.status, classified.reason) };
    }
  };

  const listDomains = (
    input: BrowserLoginImportListDomainsArgs,
  ): BrowserLoginImportListDomainsResult => {
    const loaded = loadSource(input.sourceId);
    if (!loaded.ok) return loaded.failure;
    const domains = aggregateCookieDomains(loaded.entry.cookies, Math.floor(now() / 1000));
    logger()?.info("built_in_browser.login_import.list_domains", {
      sourceId: input.sourceId,
      domainCount: domains.length,
      unreadableCount: loaded.entry.unreadable,
    });
    return { ok: true, sourceId: input.sourceId, domains, unreadableCount: loaded.entry.unreadable };
  };

  const importLogins = async (input: BrowserLoginImportArgs): Promise<BrowserLoginImportResult> => {
    const loaded = loadSource(input.sourceId);
    if (!loaded.ok) return loaded.failure;

    const nowSeconds = Math.floor(now() / 1000);
    const selected = selectCookiesForDomains(loaded.entry.cookies, input.domains, nowSeconds)
      .slice(0, MAX_COOKIES_PER_IMPORT);

    const outcomes = new Map<string, BrowserLoginImportDomainOutcome>();
    for (const domain of input.domains) {
      const key = domain.trim();
      if (key) outcomes.set(key.toLowerCase(), { domain: key, imported: 0, skipped: 0 });
    }
    const bump = (cookie: ImportedCookie, field: "imported" | "skipped"): void => {
      const key = displayDomain(cookie).toLowerCase();
      const entry = outcomes.get(key) ?? { domain: displayDomain(cookie), imported: 0, skipped: 0 };
      entry[field] += 1;
      outcomes.set(key, entry);
    };

    let target: Session;
    try {
      target = getSession();
    } catch (error) {
      logger()?.error("built_in_browser.login_import.session_unavailable", {
        sourceId: input.sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return failure(input.sourceId, "read_failed", "ADE's browser profile is not available right now.");
    }

    let imported = 0;
    let skipped = 0;
    for (const cookie of selected) {
      try {
        // One at a time: Chromium serialises these anyway, and a rejected
        // cookie should only cost itself rather than aborting the batch. A
        // session cookie is written with no `expirationDate` at all, which is
        // what makes Electron store it as one.
        await target.cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        });
        imported += 1;
        bump(cookie, "imported");
      } catch {
        // Never log the failure body: Electron echoes the cookie back in it.
        skipped += 1;
        bump(cookie, "skipped");
      }
    }

    try {
      // `set` only resolves into memory; without this the import can be lost to
      // a crash before Chromium's own flush interval comes round.
      await target.cookies.flushStore();
    } catch {
      // A failed flush still leaves the cookies live for this run.
    }

    // The consent was for this read. Drop it so a later import re-reads and
    // re-asks rather than replaying a jar the person has since changed.
    readCache.delete(input.sourceId);

    logger()?.info("built_in_browser.login_import.completed", {
      sourceId: input.sourceId,
      importedCount: imported,
      skippedCount: skipped,
      domainCount: outcomes.size,
    });

    return {
      ok: true,
      sourceId: input.sourceId,
      importedCount: imported,
      skippedCount: skipped,
      domains: [...outcomes.values()].sort((left, right) => right.imported - left.imported),
    };
  };

  return {
    capabilities,
    listSources,
    listDomains,
    import: importLogins,
    /** Test/diagnostic hook: forget every cached jar. */
    clearCache: () => readCache.clear(),
  };
}
