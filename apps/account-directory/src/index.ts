import { runCloudWakes } from "./cloudWake";
import { createComputer, handleCloudRequest, isCloudRequest } from "./cloud/routes";
import { noteAutomationLaunchProgress, runCloudAutomations } from "./cloud/automations";
import { handleInviteLookup, isInviteLookupRequest } from "./cloud/referrals";
import { runCloudMinuteCron } from "./cloud/cron";
import { expireCloudLaunches, failUnjoinedLaunches } from "./cloud/launches";
import { runProjectComputerDeletes } from "./cloud/projectComputers";
import { runPlanCleanupPicks } from "./cloud/planCleanup";
import { createCloudProvider } from "./cloud/provider";
import { handleCloudBillingPublicRequest, isCloudBillingPublicRequest, reportExtraHours } from "./cloud/billing";
import type { CloudEnv } from "./cloud/store";
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
import { cleanupLaneShares, handleLaneShareRequest, isLaneShareRequest, type LaneShareEnv } from "./laneShares/routes";
import { handleAccountProjectRequest, isAccountProjectRequest, type AccountProjectEnv } from "./accountProjects/routes";
import { handleGithubAppRequest, isGithubAppRequest, type GithubAppEnv } from "./githubApp/routes";
import { runGithubAppCron } from "./githubApp/grants";
import {
  cleanupUsageResearch,
  handleUsageResearchRequest,
  isUsageResearchRequest,
  type UsageResearchEnv,
} from "./usageResearch";

type WorkerEnv = DiagnosticsEnv & UsageResearchEnv & ModelRegistryEnv & MusicDeveloperTokenEnv & JevBonusEnv
  & SignupAnalyticsEnv & SentryEnv & PostHogLogsEnv & CloudEnv & LaneShareEnv & AccountProjectEnv & GithubAppEnv;

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
  // ADE Cloud (src/cloud): account bearer, the directory's exact-origin CORS for
  // the web client (routes.ts). Timed wakes ride the same gate. Everything
  // under /cloud answers 404 for an account not on the list, except a launch's
  // join, which a new computer makes with its one-time code.
  if (isCloudRequest(url)) return handleCloudRequest(request, env, held.waitUntil);
  // Stripe's webhook (signed, so no bearer and no access list) and the page
  // Stripe sends a person back to after Checkout or the billing portal.
  if (isCloudBillingPublicRequest(url)) return handleCloudBillingPublicRequest(request, env, held.waitUntil);
  // Clerk's sign-up webhook: Svix-signed, POST only, no CORS (Clerk is the
  // only caller). It records one `ade_signed_up` per account.
  if (isSignupAnalyticsRequest(url)) return handleSignupAnalyticsRequest(request, env);
  // The website's invite page: public and rate-limited, it answers only the
  // inviter's first name, and only for an inviter with ADE Cloud access.
  if (isInviteLookupRequest(url)) return handleInviteLookup(request, env);
  // Lane sharing (src/laneShares): account bearer, the directory's exact-origin
  // CORS for the web client, none for the host read (machines only).
  if (isLaneShareRequest(url)) return handleLaneShareRequest(request, env);
  // The account's project list (src/accountProjects): account bearer, the
  // directory's exact-origin CORS for the web client, none for the copies
  // route (machines only). Matched before the directory, which owns only
  // `/account/machines`.
  if (isAccountProjectRequest(url)) return handleAccountProjectRequest(request, env);
  // The account's GitHub App sign-in (src/githubApp): account bearer and the
  // same exact-origin CORS, except the callback and Setup URL pages that a
  // browser opens. 503 for every bearer route until its two secrets are set.
  if (isGithubAppRequest(url)) return handleGithubAppRequest(request, env, held.waitUntil);
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

  async scheduled(event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
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
        // Lane shares: clock-derived states written, rows closed 90 days ago
        // deleted, invite budget rows past a week. Bounded per tick.
        settle("lane_shares", () => cleanupLaneShares(env)),
        // the provider timed wakes: requests each due machine's wake URL.
        settle("cloud_wakes", () => runCloudWakes(env)),
        // ADE Cloud: reads the provider list once, meters hours, stops computers
        // at 0 hours, and runs the daily and ten-minute checks. No computers, no
        // provider calls.
        settle("cloud_account", () => runCloudMinuteCron(env, { waitUntil: (promise) => ctx.waitUntil(promise) })),
        // ADE Cloud extra hours: reports whole hours to the Stripe meter. One
        // indexed read when no account has extra hours on.
        settle("cloud_extra_hours", () => reportExtraHours(env)),
        // GitHub App sign-in: minute 17 of each hour prunes old sign-ins and
        // limit windows; 03:17 UTC also renews up to 50 grants whose refresh
        // token ends within 30 days. Every other tick makes no query.
        settle("github_app", () => runGithubAppCron(env, event.scheduledTime)),
        // The server launcher's records past their week (and a draft's day),
        // with their files. One indexed read when none is due.
        settle("cloud_launches", () => expireCloudLaunches(env)),
        // Launches whose computer never signed in: the computer deleted, the
        // launch failed (an automation's run follows). One indexed read when none.
        settle("cloud_launches_unjoined", async () => {
          const key = env.AGENT37_API_KEY?.trim();
          await failUnjoinedLaunches(env, {
            provider: key ? createCloudProvider(key) : null,
            onProgress: (record) => noteAutomationLaunchProgress(env, record, { now: Date.now() }),
          });
        }),
        // Automations whose home is ADE Cloud: due schedules and runs that need
        // the server, in one indexed read; nothing more when none is due.
        settle("cloud_automations", async () => {
          const key = env.AGENT37_API_KEY?.trim();
          const provider = key ? createCloudProvider(key) : null;
          const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
          await runCloudAutomations(env, {
            provider,
            createComputer: (userId, launchProvider, extras) => createComputer(env, userId, launchProvider, extras, { now: Date.now(), waitUntil }),
          });
        }),
        // "Delete the project's cloud computers" jobs: a few computers a tick.
        // One indexed read when no job waits.
        settle("cloud_project_deletes", async () => {
          const key = env.AGENT37_API_KEY?.trim();
          if (key) await runProjectComputerDeletes(env, createCloudProvider(key));
        }),
        // The computers a person picked to free for a cheaper plan: pushed,
        // then freed, a few a tick. One indexed read when no pick waits.
        settle("cloud_plan_cleanups", async () => {
          const key = env.AGENT37_API_KEY?.trim();
          if (key) await runPlanCleanupPicks(env, createCloudProvider(key));
        }),
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
