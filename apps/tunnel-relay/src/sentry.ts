import type { CloudflareOptions } from "@sentry/cloudflare";
import { admitEvent, scrubBreadcrumb, scrubEvent, scrubSpan } from "./sentryScrub";

// Sentry for this Worker and its TunnelDurableObject. The DSN is public (wrangler.jsonc
// vars). SENTRY_RELEASE is injected by the deploy workflow. Nothing sent from here may
// carry tunnel frames, pairing or relay tokens, machine keys, request bodies, query
// strings, cookies, or IP addresses; `sentryScrub.ts` enforces that.

export type SentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
};

const WORKER_NAME = "ade-tunnel-relay";

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
    // Every tunnel frame runs webSocketMessage: never start a span for one, so
    // the hot path pays no tracing cost at all (not just a dropped send).
    tracesSampler: (context) => (context.name === "webSocketMessage" ? 0 : 0.01),
    // The brain and the phone talk over the tunnel, not HTTP, and this Worker calls
    // no other Worker. No trace headers on any outbound call.
    tracePropagationTargets: [],
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
