import type { CloudflareOptions } from "@sentry/cloudflare";
import { admitEvent, scrubBreadcrumb, scrubEvent, scrubSpan } from "./sentryScrub";

// Sentry for this Worker. The DSN is public (wrangler.jsonc vars). SENTRY_RELEASE is
// injected by the deploy workflow. Nothing sent from here may carry request bodies,
// query strings, cookies, IP addresses, account or device tokens, diagnostics
// uploads, or usage research rows; `sentryScrub.ts` enforces that.

export type SentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
};

const WORKER_NAME = "ade-account-directory";

// The one Worker this one calls (ACTIVITY_RELAY). Trace headers go only there.
const PUSH_RELAY_HOST = "ade-push-relay.arulsharma1028.workers.dev";

export function sentryOptions(env: SentryEnv): CloudflareOptions {
  // `SENTRY_ENVIRONMENT` is set to `production` only in the deployed config
  // (wrangler.jsonc). Anything else, `wrangler dev` included, is
  // `development` and sends nothing, so local runs never spend the quota.
  const environment = env.SENTRY_ENVIRONMENT?.trim() || "development";
  return {
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    dist: `worker-${WORKER_NAME}`,
    environment,
    enabled: environment !== "development",
    initialScope: { tags: { worker: WORKER_NAME } },
    tracesSampleRate: 0.01,
    tracePropagationTargets: [PUSH_RELAY_HOST],
    ignoreErrors: ["AbortError", "The operation was aborted", "Network connection lost"],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ["user-agent", "content-type", "content-length", "accept", "cf-ray"] },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: (event) => (admitEvent(event) ? scrubEvent(event) : null),
    beforeSendSpan: (span) => scrubSpan(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
}
