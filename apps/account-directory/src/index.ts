import { handleRequest, type Env } from "./directory";
import { cleanupExpiredDeviceAuthorizations } from "./deviceAuthorization";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredDeviceAuthorizations(env));
  },
};
