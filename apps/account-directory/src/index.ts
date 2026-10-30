import * as Sentry from "@sentry/cloudflare";
import { handleRequest } from "./directory";
import { logScheduledCleanupFailure } from "./logging";
import { cloudflareTransientKind, logCloudflareTransient, retryD1Reads, transientUnavailableResponse } from "./cloudflareTransient";
import { sentryOptions, type SentryEnv } from "./sentry";
import { scrubString } from "./sentryScrub";
import { cleanupExpiredPairingGrants } from "./pairingGrants";
import { cleanupExpiredDeviceAuthorizations } from "./deviceAuthorization";
import {
  cleanupDiagnosticsUploadDays,
  handleDiagnosticsRequest,
  isDiagnosticsRequest,
  type DiagnosticsEnv,
} from "./diagnostics";
import {
  handleModelRegistryRequest,
  isModelRegistryRequest,
  runModelRegistryCron,
  type ModelRegistryEnv,
} from "./modelRegistry";
import {
  handleMusicDeveloperTokenRequest,
  isMusicDeveloperTokenRequest,
  type MusicDeveloperTokenEnv,
} from "./musicDeveloperToken";
import { cleanupJevBonusDays, handleJevBonusRequest, isJevBonusRequest, type JevBonusEnv } from "./jevBonus";
import { handleSignupAnalyticsRequest, isSignupAnalyticsRequest, type SignupAnalyticsEnv } from "./signupAnalytics";
import {
  cleanupUsageResearch,
  handleUsageResearchRequest,
  isUsageResearchRequest,
  type UsageResearchEnv,
} from "./usageResearch";

type WorkerEnv = DiagnosticsEnv & UsageResearchEnv & ModelRegistryEnv & MusicDeveloperTokenEnv & JevBonusEnv
  & SignupAnalyticsEnv & SentryEnv;

const CLEANUP_MONITOR_SLUG = "account-directory-cleanup";
const CLEANUP_MONITOR_CONFIG = {
  // Keep in step with `triggers.crons` in wrangler.jsonc.
  schedule: { type: "crontab", value: "* * * * *" },
  checkinMargin: 5,
  maxRuntime: 10,
  timezone: "UTC",
  // A minute cron misses the odd tick on a Cloudflare hiccup: open an issue
  // only after five missed or failed ticks in a row.
  failureIssueThreshold: 5,
  recoveryThreshold: 1,
} satisfies Parameters<typeof Sentry.withMonitor>[2];

function route(request: Request, env: WorkerEnv): Promise<Response> {
  // Diagnostics and usage research are matched before the directory because
  // they are the routes here that are not account-scoped: `handleRequest`
  // answers an unknown OPTIONS with 404 and applies the directory's
  // exact-origin CORS rule, neither of which fits a write-only sink that an
  // unauthenticated client has to be able to reach.
  const url = new URL(request.url);
  if (isDiagnosticsRequest(url)) return handleDiagnosticsRequest(request, env);
  if (isUsageResearchRequest(url)) return handleUsageResearchRequest(request, env);
  // The model registry takes an account bearer but is not a directory route:
  // it answers GET and HEAD only, has no CORS (the ADE brain is the only
  // caller), and caches with an ETag.
  if (isModelRegistryRequest(url)) return handleModelRegistryRequest(request, env);
  // Apple Music developer tokens: same shape as the registry (account bearer,
  // GET only, no CORS — the desktop main process is the only caller).
  if (isMusicDeveloperTokenRequest(url)) return handleMusicDeveloperTokenRequest(request, env);
  // The Jev bonus: account bearer, POST only, no CORS — the ADE brain is the
  // only caller. It forwards to TypeSafe with ADE's key under a daily cap.
  if (isJevBonusRequest(url)) return handleJevBonusRequest(request, env);
  // Clerk's sign-up webhook: Svix-signed, POST only, no CORS (Clerk is the
  // only caller). It records one `ade_signed_up` per account.
  if (isSignupAnalyticsRequest(url)) return handleSignupAnalyticsRequest(request, env);
  return handleRequest(request, env);
}

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, workerEnv: WorkerEnv): Promise<Response> {
    // Reads ride through D1's short Cloudflare-side outages.
    const env = { ...workerEnv, DB: retryD1Reads(workerEnv.DB) };
    try {
      return await route(request, env);
    } catch (error) {
      // A route outside the directory hit D1 restarting under Cloudflare: the
      // caller retries a 503, so answer that and keep it out of Sentry.
      const transient = cloudflareTransientKind(error);
      if (!transient) throw error;
      logCloudflareTransient("ade-account-directory", transient, scrubString(new URL(request.url).pathname), error);
      return transientUnavailableResponse();
    }
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    // Each cleanup settles on its own: one table that throws logs a line and
    // leaves the other sweeps to finish, instead of failing the whole tick.
    const settle = (task: string, run: () => Promise<unknown>): Promise<void> =>
      Promise.resolve()
        .then(run)
        .then(
          () => {},
          (error: unknown) => logScheduledCleanupFailure({ task, error }),
        );
    // One Sentry cron monitor (the Team plan includes one; never add
    // `cronTriggersIntegration`, which makes a billed monitor per trigger).
    // It is upserted by the check-ins, alerts when a minute's tick goes
    // missing or runs past `maxRuntime`, and is reached only from
    // `production` (src/sentry.ts sends nothing else). Each sweep's own
    // failure is a log line above, not a failed check-in.
    const sweeps = Sentry.withMonitor(CLEANUP_MONITOR_SLUG, () => Promise.all([
      settle("device_authorizations", () => cleanupExpiredDeviceAuthorizations(env)),
      settle("pairing_grants", () => cleanupExpiredPairingGrants(env)),
      // Only today's budget row is ever read; the rest is kept for a week so a
      // support question about a fleet-wide refusal still has a row to point at.
      settle("diagnostics_upload_days", () => cleanupDiagnosticsUploadDays(env)),
      // Usage research: reports past `USAGE_RESEARCH_RETENTION_DAYS` (500 rows
      // a tick), budget rows past a week, identity rows past their day.
      settle("usage_research", () => cleanupUsageResearch(env)),
      // Model registry: rebuilt from its public sources once the newest
      // snapshot is a day old; every other tick is one indexed read.
      // `MODEL_REGISTRY_REFRESH=0` stops the fetches.
      settle("model_registry", () => runModelRegistryCron(env)),
      // Jev bonus: per-account day counts past a week.
      settle("jev_bonus_days", () => cleanupJevBonusDays(env)),
    ]), CLEANUP_MONITOR_CONFIG);
    ctx.waitUntil(sweeps);
    // Awaited too, so the SDK flushes after the closing check-in.
    await sweeps;
  },
});
