import * as Sentry from "@sentry/cloudflare";
import { retryD1Reads } from "./cloudflareTransient";
import { handleRequest, pruneRelayState, sweepRelayState, type PushRelayEnv } from "./relay";
import { reportJobFailure, reportRequest, type PostHogLogsEnv } from "./posthogLogs";
import { sentryOptions, type SentryEnv } from "./sentry";

const WORKER_NAME = "ade-push-relay";

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: PushRelayEnv & SentryEnv & PostHogLogsEnv, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await handleRequest(request, env);
      reportRequest(env, ctx, WORKER_NAME, request, response.status, startedAt);
      return response;
    } catch (error) {
      reportRequest(env, ctx, WORKER_NAME, request, 500, startedAt, error);
      throw error;
    }
  },

  // Hourly cron. Two jobs, and the split matters:
  //
  // - `pruneRelayState` prunes expired suppression, registration, and rate-limit
  //   rows. Request handlers also prune opportunistically (after a signed
  //   publish/upsert), so pure /claim, 404, or unauthorized traffic never
  //   triggers cleanup — this keeps `rate_counters` (and the rest) bounded even
  //   under abuse from rotating IPs that never reach an authenticated path.
  // - `sweepRelayState` retires expired Attention items and orphaned machine
  //   Activity. Those sweeps fan out into per-account revision commits and
  //   outbound APNs pushes, so they run HERE ONLY and never inside a request.
  async scheduled(_event: ScheduledEvent, env: PushRelayEnv & SentryEnv & PostHogLogsEnv, ctx: ExecutionContext): Promise<void> {
    // Reads ride through D1's short outages here as they do in requests.
    const cronEnv = { ...env, DB: retryD1Reads(env.DB) };
    ctx.waitUntil((async () => {
      await sweepRelayState(cronEnv);
      await pruneRelayState(cronEnv);
    })().catch((error: unknown) => {
      // The sweep runs once an hour, so every failure is worth an event. waitUntil
      // would otherwise drop it. Rethrow so Cloudflare still logs it.
      Sentry.captureException(error);
      reportJobFailure(env, ctx, WORKER_NAME, "hourly_sweep", error);
      throw error;
    }));
  },
});
