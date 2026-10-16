import * as Sentry from "@sentry/cloudflare";
import { RepoEventsDurableObject as RepoEventsDurableObjectClass } from "./repoEventsDurableObject";
import { handleRequest, type RelayEnv } from "./relay";
import { sentryOptions, type SentryEnv } from "./sentry";

// wrangler.jsonc binds this export name, so the wrapped class is exported under it. The
// class implements DurableObject rather than extending it, which the wrapper's
// `DurableObject<any>` constraint rejects, so the instance type is passed as `any`. The
// returned type is still the exact class.
export const RepoEventsDurableObject = Sentry.instrumentDurableObjectWithSentry<
  SentryEnv,
  any,
  typeof RepoEventsDurableObjectClass
>(sentryOptions, RepoEventsDurableObjectClass);

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: RelayEnv & SentryEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // This catch answers the request, so the Sentry wrapper never sees the error. Capture it here.
      Sentry.captureException(error);
      // Log the cause and answer with JSON instead of Cloudflare's bare 500
      // page. The message stays in the log: it can name config or D1 details.
      const message = error instanceof Error ? error.message : String(error);
      console.error("relay.unhandled_error", { path: new URL(request.url).pathname, message });
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
});
