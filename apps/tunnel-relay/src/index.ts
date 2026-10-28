import * as Sentry from "@sentry/cloudflare";
import { handleRequest, TunnelDurableObject as TunnelDurableObjectClass, type TunnelRelayEnv } from "./relay";
import { sentryOptions, type SentryEnv } from "./sentry";

// wrangler.jsonc binds this export name, so the wrapped class is exported under it. The
// class implements DurableObject rather than extending it, which the wrapper's
// `DurableObject<any>` constraint rejects, so the instance type is passed as `any`. The
// returned type is still the exact class.
export const TunnelDurableObject = Sentry.instrumentDurableObjectWithSentry<
  TunnelRelayEnv,
  any,
  typeof TunnelDurableObjectClass
>(sentryOptions, TunnelDurableObjectClass);

export default Sentry.withSentry(sentryOptions, {
  fetch(request: Request, env: TunnelRelayEnv, ctx?: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
});
