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
import type { SystemSettingsPaneId } from "../../../../shared/types/systemSettings";
import type { Logger } from "../../logging/logger";
import { BUILT_IN_BROWSER_PARTITION } from "../builtInBrowserConstants";
import type { ImportedCookie } from "./cookieDatabase";
import { aggregateCookieDomains, selectCookiesForDomains, displayDomain } from "./cookieDomains";
import type { LoginImportReadRequest, LoginImportReadResponse } from "./loginImportRead";
import { readLoginImportSourceInWorker } from "./loginImportReadWorkerClient";
import { safariAccessDenied } from "./safariCookies";
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
  /**
   * Injected for tests. Production always goes through
   * `readLoginImportSourceInWorker` so the blocking read never runs here.
   */
  readSource?: (request: LoginImportReadRequest) => Promise<LoginImportReadResponse>;
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

function settingsPaneFor(status: BrowserLoginImportSourceStatus): SystemSettingsPaneId | null {
  return status === "needs_full_disk_access" ? "macos-full-disk-access" : null;
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
            settingsPaneId: settingsPaneFor(status),
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
    settingsPaneId: settingsPaneFor(status),
  });

  /**
   * Off the main thread, always. Every step of this read blocks — the macOS
   * Keychain modal has no timeout by design — and on the main thread that
   * freezes every window, every IPC handler and every agent's browser call.
   */
  const readSource = async (entry: ResolvedSource): Promise<LoginImportReadResponse> => {
    const { definition, profile } = entry;
    const request: LoginImportReadRequest = {
      engine: definition.engine,
      cookieDatabasePath: profile.cookieDatabasePath,
      platform: context.platform,
      ...(definition.keychainService ? { keychainService: definition.keychainService } : {}),
      ...(definition.keychainAccount ? { keychainAccount: definition.keychainAccount } : {}),
      ...(definition.linuxSecretApplication
        ? { linuxSecretApplication: definition.linuxSecretApplication }
        : {}),
      chromiumUserDataDirectory: definition.engine === "chromium"
        ? definition.userDataDirectory(context)
        : null,
    };
    return args.readSource ? args.readSource(request) : readLoginImportSourceInWorker(request);
  };

  /**
   * Reads in flight, keyed by source.
   *
   * The read cache is only written *after* a read completes, so two overlapping
   * `listDomains` calls for the same source would each spawn a worker and each
   * raise a Keychain prompt — breaking the consent-once invariant this module
   * claims. The renderer happens to disable its buttons while busy, but the
   * invariant belongs to the layer that owns it, not to a button's `disabled`.
   */
  const inFlightReads = new Map<string, Promise<LoginImportReadResponse>>();

  const readSourceOnce = (entry: ResolvedSource): Promise<LoginImportReadResponse> => {
    const existing = inFlightReads.get(entry.source.id);
    if (existing) return existing;
    const pending = readSource(entry).finally(() => {
      inFlightReads.delete(entry.source.id);
    });
    inFlightReads.set(entry.source.id, pending);
    return pending;
  };

  /** Reads a source, reusing a recent read so consent is asked for once. */
  const loadSource = async (
    sourceId: string,
  ): Promise<
    { ok: true; entry: CacheEntry } | { ok: false; failure: BrowserLoginImportFailure }
  > => {
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

    const read = await readSourceOnce(resolved);
    // A second caller that awaited the same read must not overwrite the cache
    // entry the first one just wrote with a fresher `readAt`.
    const settled = readCache.get(sourceId);
    if (settled && now() - settled.readAt < READ_CACHE_TTL_MS) return { ok: true, entry: settled };
    if (!read.ok) {
      logger()?.warn("built_in_browser.login_import.read_failed", {
        sourceId,
        browserId: resolved.definition.id,
        status: read.status,
      });
      return { ok: false, failure: failure(sourceId, read.status, read.reason) };
    }
    const entry: CacheEntry = {
      cookies: read.cookies,
      unreadable: read.unreadable,
      readAt: now(),
    };
    readCache.set(sourceId, entry);
    return { ok: true, entry };
  };

  const listDomains = async (
    input: BrowserLoginImportListDomainsArgs,
  ): Promise<BrowserLoginImportListDomainsResult> => {
    const loaded = await loadSource(input.sourceId);
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
    const loaded = await loadSource(input.sourceId);
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
