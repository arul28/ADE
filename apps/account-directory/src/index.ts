import { handleRequest, type Env } from "./directory";
import { cleanupExpiredPairingGrants } from "./pairingGrants";
import { cleanupExpiredDeviceAuthorizations } from "./deviceAuthorization";
import { handleDiagnosticsRequest, isDiagnosticsRequest, type DiagnosticsEnv } from "./diagnostics";

export default {
  fetch(request: Request, env: DiagnosticsEnv): Promise<Response> {
    // Diagnostics is matched before the directory because it is the one route
    // here that is not account-scoped: `handleRequest` answers an unknown
    // OPTIONS with 404 and applies the directory's exact-origin CORS rule,
    // neither of which fits a write-only sink an unauthenticated Electron
    // renderer has to be able to reach.
    const url = new URL(request.url);
    if (isDiagnosticsRequest(url)) return handleDiagnosticsRequest(request, env);
    return handleRequest(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      cleanupExpiredDeviceAuthorizations(env),
      cleanupExpiredPairingGrants(env),
    ]));
  },
};
