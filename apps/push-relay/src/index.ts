import { handleRequest, pruneRelayState, type PushRelayEnv } from "./relay";

export default {
  fetch(request: Request, env: PushRelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },

  // Hourly cron: prune expired suppression, registration, and rate-limit rows.
  // Request handlers only prune opportunistically (after a signed publish/upsert),
  // so pure /claim, 404, or unauthorized traffic never triggers cleanup — this
  // keeps `rate_counters` (and the rest) bounded even under abuse from rotating
  // IPs that never reach an authenticated path.
  async scheduled(_event: ScheduledEvent, env: PushRelayEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pruneRelayState(env));
  },
};
