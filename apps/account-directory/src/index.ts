import * as Sentry from "@sentry/cloudflare";
import { handleRequest } from "./directory";
import { logScheduledCleanupFailure } from "./logging";
import { cloudflareTransientKind, logCloudflareTransient, retryD1Reads, transientUnavailableResponse } from "./cloudflareTransient";
import { reportJobFailure, reportRequest, type PostHogLogsEnv } from "./posthogLogs";
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
  & SignupAnalyticsEnv & SentryEnv & PostHogLogsEnv;

const WORKER_NAME = "ade-account-directory";

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
} satisfies Parameters<typeof Sentry.captureCheckIn>[1];

function route(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
  // Diagnostics and usage research are matched before the directory because
  // they are the routes here that are not account-scoped: `handleRequest`
  // answers an unknown OPTIONS with 404 and applies the directory's
  // exact-origin CORS rule, neither of which fits a write-only sink that an
  // unauthenticated client has to be able to reach.
  const url = new URL(request.url);
  const held = ctx ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) } : {};
  if (isDiagnosticsRequest(url)) return handleDiagnosticsRequest(request, env, held);
  if (isUsageResearchRequest(url)) return handleUsageResearchRequest(request, env, held);
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
  async fetch(request: Request, workerEnv: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    // Reads ride through D1's short Cloudflare-side outages.
    const env = { ...workerEnv, DB: retryD1Reads(workerEnv.DB) };
    const startedAt = Date.now();
    try {
      const response = await route(request, env, ctx);
      reportRequest(workerEnv, ctx, WORKER_NAME, request, response.status, startedAt);
      return response;
    } catch (error) {
      // A route outside the directory hit D1 restarting under Cloudflare: the
      // caller retries a 503, so answer that and keep it out of Sentry.
      const transient = cloudflareTransientKind(error);
      if (!transient) {
        reportRequest(workerEnv, ctx, WORKER_NAME, request, 500, startedAt, error);
        throw error;
      }
      logCloudflareTransient("ade-account-directory", transient, scrubString(new URL(request.url).pathname), error);
      const response = transientUnavailableResponse();
      reportRequest(workerEnv, ctx, WORKER_NAME, request, response.status, startedAt, error);
      return response;
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
          (error: unknown) => {
            logScheduledCleanupFailure({ task, error });
            reportJobFailure(env, ctx, WORKER_NAME, task, error);
          },
        );
    // One Sentry cron monitor (the Team plan includes one; never add
    // `cronTriggersIntegration`, which makes a billed monitor per trigger).
    // It is upserted by the check-in, alerts when a minute's tick goes
    // missing, and is reached only from `production` (src/sentry.ts sends
    // nothing else). Each sweep's own failure is a log line above, not a
    // failed check-in.
    //
    // One closing check-in per tick, captured here rather than through
    // `Sentry.withMonitor`: that forks the isolation scope and loses the
    // invocation's `waitUntil`, so its closing check-in was sent detached and
    // Cloudflare cancelled it when the tick returned — the monitor saw a run
    // that started and never finished, timed out, and regressed every hour.
    // Captured in this scope the check-in rides the SDK's end-of-invocation
    // flush. A tick that hangs never checks in and shows up as missed.
    const startedAt = Date.now();
    let status: "ok" | "error" = "ok";
    try {
      await Promise.all([
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
      ]);
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      Sentry.captureCheckIn(
        { monitorSlug: CLEANUP_MONITOR_SLUG, status, duration: (Date.now() - startedAt) / 1000 },
        CLEANUP_MONITOR_CONFIG,
      );
    }
  },
});
