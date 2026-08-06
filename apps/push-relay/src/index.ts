import { handleRequest, pruneRelayState, sweepRelayState, type PushRelayEnv } from "./relay";

export default {
  fetch(request: Request, env: PushRelayEnv): Promise<Response> {
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
  async scheduled(_event: ScheduledEvent, env: PushRelayEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await sweepRelayState(env);
      await pruneRelayState(env);
    })());
  },
};
