import { handleRequest } from "./directory";
import { logScheduledCleanupFailure } from "./logging";
import { cleanupExpiredPairingGrants } from "./pairingGrants";
import { cleanupExpiredDeviceAuthorizations } from "./deviceAuthorization";
import {
  cleanupDiagnosticsUploadDays,
  handleDiagnosticsRequest,
  isDiagnosticsRequest,
  type DiagnosticsEnv,
} from "./diagnostics";
import {
  cleanupUsageResearch,
  handleUsageResearchRequest,
  isUsageResearchRequest,
  type UsageResearchEnv,
} from "./usageResearch";

type WorkerEnv = DiagnosticsEnv & UsageResearchEnv;

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Diagnostics and usage research are matched before the directory because
    // they are the routes here that are not account-scoped: `handleRequest`
    // answers an unknown OPTIONS with 404 and applies the directory's
    // exact-origin CORS rule, neither of which fits a write-only sink that an
    // unauthenticated client has to be able to reach.
    const url = new URL(request.url);
    if (isDiagnosticsRequest(url)) return handleDiagnosticsRequest(request, env);
    if (isUsageResearchRequest(url)) return handleUsageResearchRequest(request, env);
    return handleRequest(request, env);
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
    ctx.waitUntil(Promise.all([
      settle("device_authorizations", () => cleanupExpiredDeviceAuthorizations(env)),
      settle("pairing_grants", () => cleanupExpiredPairingGrants(env)),
      // Only today's budget row is ever read; the rest is kept for a week so a
      // support question about a fleet-wide refusal still has a row to point at.
      settle("diagnostics_upload_days", () => cleanupDiagnosticsUploadDays(env)),
      // Usage research: reports past `USAGE_RESEARCH_RETENTION_DAYS` (500 rows
      // a tick), budget rows past a week, identity rows past their day.
      settle("usage_research", () => cleanupUsageResearch(env)),
    ]));
  },
};
