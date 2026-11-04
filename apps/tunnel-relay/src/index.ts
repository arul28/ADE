import * as Sentry from "@sentry/cloudflare";
import { handleRequest, TunnelDurableObject as TunnelDurableObjectClass, type TunnelRelayEnv } from "./relay";
import { reportRequest, type PostHogLogsEnv } from "./posthogLogs";
import { sentryOptions, type SentryEnv } from "./sentry";

// wrangler.jsonc binds this export name, so the wrapped class is exported under it. The
// class implements DurableObject rather than extending it, which the wrapper's
// `DurableObject<any>` constraint rejects, so the instance type is passed as `any`. The
// returned type is still the exact class.
const WORKER_NAME = "ade-tunnel-relay";

export const TunnelDurableObject = Sentry.instrumentDurableObjectWithSentry<
  TunnelRelayEnv,
  any,
  typeof TunnelDurableObjectClass
>(sentryOptions, TunnelDurableObjectClass);

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: TunnelRelayEnv & PostHogLogsEnv, ctx?: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await handleRequest(request, env, ctx);
      reportRequest(env, ctx, WORKER_NAME, request, response.status, startedAt);
      return response;
    } catch (error) {
      reportRequest(env, ctx, WORKER_NAME, request, 500, startedAt, error);
      throw error;
    }
  },
});
