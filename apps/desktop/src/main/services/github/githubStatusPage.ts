import {
  GITHUB_STATUS_SUMMARY_URL,
  deriveGitHubServiceHealth,
  type GitHubServiceHealth,
} from "../../../shared/githubServiceHealth";
import type { GitHubStatus } from "../../../shared/types";
import type { Logger } from "../logging/logger";

/**
 * Reads githubstatus.com to corroborate a GitHub failure ADE already observed.
 *
 * Deliberately NOT a poller. ADE is local-first: while GitHub works, this module
 * makes zero network calls and no third party learns the app is running. The
 * only trigger is an actual GitHub-reported failure, which is also when the
 * answer is worth anything.
 *
 * Every failure mode here resolves to null ("say nothing"). An unreachable or
 * malformed status page must never itself become a banner — that would replace
 * one wrong accusation with another.
 */

/**
 * Results — including null ones — are cached for this window. Caching the
 * negative matters most: an outage that also breaks egress would otherwise
 * retry the status page on every failed GitHub call, exactly when the network
 * is least able to absorb it.
 */
const CACHE_TTL_MS = 60_000;
/**
 * Hard ceiling on the lookup. `getStatus` awaits this before resolving, so it
 * is also the worst-case stall added to a GitHub status read during an
 * incident — kept short because the answer is a nicety, not a requirement.
 */
const REQUEST_TIMEOUT_MS = 2_000;

type CacheEntry = {
  health: GitHubServiceHealth | null;
  expiresAtMs: number;
};

let cache: CacheEntry | null = null;
let inFlight: Promise<GitHubServiceHealth | null> | null = null;
/**
 * Bumped by {@link resetGitHubServiceHealthCache}. A lookup that was already in
 * flight when the cache was reset must not write its now-stale result back —
 * without this, a reset is silently undone a moment later.
 */
let cacheGeneration = 0;

/**
 * Injectable so a test that produces a corroborated failure cannot reach the
 * real githubstatus.com from the unit suite. Both GitHub services already carry
 * a `fetchImpl` for the same reason.
 */
export type StatusPageFetch = typeof fetch;

async function fetchServiceHealth(
  logger?: Logger,
  fetchImpl: StatusPageFetch = fetch,
): Promise<GitHubServiceHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(GITHUB_STATUS_SUMMARY_URL, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "ade-desktop" },
      signal: controller.signal,
      // The status page is public; sending credentials would be a privacy leak
      // and Statuspage's CDN ignores them anyway.
      credentials: "omit",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const health = deriveGitHubServiceHealth(payload);
    if (health) {
      logger?.info("github.service_incident_detected", {
        indicator: health.indicator,
        affected: health.affected.map((entry) => entry.surface),
      });
    }
    return health;
  } catch (error) {
    // Includes the abort path. Never surfaced: a status page we cannot reach
    // tells us nothing about GitHub, so ADE keeps its existing (credential-
    // shaped) error rather than inventing an outage.
    logger?.debug("github.service_status_unreachable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Corroborated GitHub incident affecting ADE, or null when GitHub reports
 * nothing relevant (or could not be reached).
 *
 * Call this ONLY after a GitHub request has already failed.
 */
export async function getGitHubServiceHealth(
  options: { forceRefresh?: boolean; logger?: Logger; fetchImpl?: StatusPageFetch } = {},
): Promise<GitHubServiceHealth | null> {
  if (!options.forceRefresh) {
    const now = Date.now();
    if (cache && cache.expiresAtMs > now) return cache.health;
    // Only ordinary callers join an in-flight lookup. A forced refresh that
    // joined would silently receive the pre-incident answer it asked to bypass.
    if (inFlight) return await inFlight;
  }

  const generation = cacheGeneration;
  const work = (async () => {
    const health = await fetchServiceHealth(options.logger, options.fetchImpl);
    if (generation === cacheGeneration) {
      cache = { health, expiresAtMs: Date.now() + CACHE_TTL_MS };
    }
    return health;
  })();
  if (!options.forceRefresh) inFlight = work;
  try {
    return await work;
  } finally {
    if (inFlight === work) inFlight = null;
  }
}

export function resetGitHubServiceHealthCache(): void {
  cache = null;
  inFlight = null;
  cacheGeneration += 1;
}

/**
 * The only failure kinds worth corroborating — an allowlist, so a future
 * failure kind has to opt in rather than silently inherit an outbound request.
 *
 * - `service_unavailable`: GitHub returned 5xx. Exactly the case that used to
 *   render as "authentication check failed".
 * - `unknown`: GitHub replied with something we could not classify, which is
 *   the other way an incident reaches the user as a credential accusation.
 *
 * Everything else is deliberately excluded. `invalid_token`,
 * `permission_denied`, and `rate_limited` are definitive answers FROM GitHub
 * about this credential — letting a mild, unrelated degradation ("Pages:
 * degraded_performance") overwrite them would tell a rate-limited or
 * under-scoped user there is nothing to fix, hiding their actual remedy.
 * `network` is ADE's own connectivity failing; the status page is just as
 * unreachable then, and asking would add latency to every offline blip.
 */
const CORROBORATED_FAILURE_KINDS: ReadonlySet<NonNullable<GitHubStatus["authFailure"]>["kind"]> =
  new Set(["service_unavailable", "unknown"] as const);

/**
 * Attach githubstatus.com corroboration to a status that reports a failure.
 *
 * Shared by BOTH `getStatus` implementations — the desktop in-process service
 * and the headless (brain) one. The renderer reaches GitHub through whichever
 * of those owns the project, so a wrapper applied to only one leaves the
 * feature inert in the shipping runtime-backed build.
 *
 * Corroboration is advisory in one direction only: a confirmed incident lets
 * the UI stop blaming the user's credential, while a silent status page changes
 * nothing (it lags real incidents, so it cannot prove the failure is local).
 */
export async function attachGitHubServiceHealth(
  status: GitHubStatus,
  options: { logger?: Logger; fetchImpl?: StatusPageFetch } = {},
): Promise<GitHubStatus> {
  const failure = status.authFailure;
  // Gated on an actual GitHub-reported failure. `connected === false` alone is
  // not enough: a fine-grained PAT that simply lacks access to this repo is a
  // purely local misconfiguration, and treating it as a trigger would turn this
  // module into a once-a-minute beacon for the life of the session.
  if (!failure || !CORROBORATED_FAILURE_KINDS.has(failure.kind)) return status;
  const serviceHealth = await getGitHubServiceHealth({
    logger: options.logger,
    fetchImpl: options.fetchImpl,
  }).catch(() => null);
  return serviceHealth ? { ...status, serviceHealth } : status;
}
