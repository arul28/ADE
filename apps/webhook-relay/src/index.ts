import * as Sentry from "@sentry/cloudflare";
import { runBetaTimer, type BetaTimerEnv } from "./betaTimer";
import { RepoEventsDurableObject as RepoEventsDurableObjectClass } from "./repoEventsDurableObject";
import { cloudflareTransientKind, logCloudflareTransient, retryD1Reads, transientUnavailableResponse } from "./cloudflareTransient";
import { handleRequest, type RelayEnv } from "./relay";
import { retryHookForwards } from "./customHooks";
import { scrubString } from "./sentryScrub";
import { reportJobFailure, reportRequest, routeTemplate, type PostHogLogsEnv } from "./posthogLogs";
import { sentryOptions, type SentryEnv } from "./sentry";

const WORKER_NAME = "ade-github-webhook-relay";

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
  async fetch(request: Request, env: RelayEnv & SentryEnv & PostHogLogsEnv, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    try {
      // Reads ride through D1's short Cloudflare-side outages.
      const response = await handleRequest(request, { ...env, DB: retryD1Reads(env.DB) }, ctx);
      reportRequest(env, ctx, WORKER_NAME, request, response.status, startedAt);
      return response;
    } catch (error) {
      // D1 or a Durable Object restarting under Cloudflare: answer 503 with
      // Retry-After rather than a 500, and keep it out of Sentry. ADE clients
      // retry; GitHub records the failed delivery for a manual redeliver.
      const transient = cloudflareTransientKind(error);
      if (transient) {
        logCloudflareTransient("ade-webhook-relay", transient, scrubString(new URL(request.url).pathname), error);
        const response = transientUnavailableResponse();
        reportRequest(env, ctx, WORKER_NAME, request, response.status, startedAt, error);
        return response;
      }
      // This catch answers the request, so the Sentry wrapper never sees the error. Capture it here.
      Sentry.captureException(error);
      reportRequest(env, ctx, WORKER_NAME, request, 500, startedAt, error);
      // Log the cause and answer with JSON instead of Cloudflare's bare 500
      // page. The message stays in the log: it can name config or D1 details.
      const message = error instanceof Error ? error.message : String(error);
      // The route template, never the raw path: a path can carry a hook token
      // or a repository key, and an error line must not store it.
      console.error("relay.unhandled_error", { route: routeTemplate(new URL(request.url).pathname), message: scrubString(message) });
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  // The cron jobs: start ADE's Beta workflow (src/betaTimer.ts), and send
  // forwarded webhook deliveries the account directory didn't take yet
  // (customHooks.ts; one indexed read when none waits). Awaited, so a throw
  // reaches the Sentry wrapper.
  async scheduled(_event: ScheduledEvent, env: BetaTimerEnv & RelayEnv & SentryEnv & PostHogLogsEnv, ctx: ExecutionContext): Promise<void> {
    const forwards = retryHookForwards({ ...env, DB: retryD1Reads(env.DB) }).catch((error: unknown) => {
      reportJobFailure(env, ctx, WORKER_NAME, "hook_forwards", error);
    });
    try {
      await runBetaTimer(env);
    } catch (error) {
      reportJobFailure(env, ctx, WORKER_NAME, "beta_timer", error);
      throw error;
    } finally {
      await forwards;
    }
  },
});
