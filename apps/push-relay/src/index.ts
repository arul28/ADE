import * as Sentry from "@sentry/cloudflare";
import { retryD1Reads } from "./cloudflareTransient";
import { handleRequest, pruneRelayState, sweepRelayState, type PushRelayEnv } from "./relay";
import { sentryOptions, type SentryEnv } from "./sentry";

export default Sentry.withSentry(sentryOptions, {
  fetch(request: Request, env: PushRelayEnv & SentryEnv): Promise<Response> {
    return handleRequest(request, env);
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
  async scheduled(_event: ScheduledEvent, env: PushRelayEnv & SentryEnv, ctx: ExecutionContext): Promise<void> {
    // Reads ride through D1's short outages here as they do in requests.
    const cronEnv = { ...env, DB: retryD1Reads(env.DB) };
    ctx.waitUntil((async () => {
      await sweepRelayState(cronEnv);
      await pruneRelayState(cronEnv);
    })().catch((error: unknown) => {
      // The sweep runs once an hour, so every failure is worth an event. waitUntil
      // would otherwise drop it. Rethrow so Cloudflare still logs it.
      Sentry.captureException(error);
      throw error;
    }));
  },
});
