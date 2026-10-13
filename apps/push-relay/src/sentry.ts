import type { Breadcrumb, CloudflareOptions, ErrorEvent } from "@sentry/cloudflare";

// Sentry for this Worker. The DSN is public (wrangler.jsonc vars). SENTRY_RELEASE is
// injected by the deploy workflow. Nothing sent from here may carry request bodies,
// query strings, cookies, IP addresses, APNs or device tokens, Live Activity push
// tokens, or attention payloads.

export type SentryEnv = {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
};

const WORKER_NAME = "ade-push-relay";

// Secret shapes from the ADE Sentry spec, matched anywhere in a string.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/g,
  /xox[abpr]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /Bearer\s+\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi,
];

// A query string can carry a token, a code, or a signed value, so none of it is kept.
const URL_QUERY = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?"'<>]*)\?[^\s"'<>]*/gi;

// Object keys whose values are never sent, whatever object they sit in.
const SENSITIVE_KEY = /token|secret|passw|authorization|cookie|api[_-]?key|credential|private[_-]?key|signature|payload|body/i;

function scrubString(value: string): string {
  let out = value.replace(URL_QUERY, "$1?[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function scrubValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (!value || typeof value !== "object") return value;
  // Past a sane depth, drop the subtree rather than risk an unscrubbed secret inside it.
  if (depth > 8) return "[redacted]" as T;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1)) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : scrubValue(item, depth + 1);
  }
  return out as T;
}

function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
  }
  delete event.user;
  // JSON.parse errors quote the input around the failure, which can be a token or a payload.
  for (const exception of event.exception?.values ?? []) {
    if (exception.type === "SyntaxError") exception.value = "[redacted]";
  }
  return scrubValue(event);
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console lines are free text. The Worker's structured logs already keep them.
  if (breadcrumb.category === "console") return null;
  return scrubValue(breadcrumb);
}

export function sentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    dist: `worker-${WORKER_NAME}`,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    initialScope: { tags: { worker: WORKER_NAME } },
    // About 750K requests a day. 5M spans a month on the free plan is about 167K a day, so sample at 0.1%.
    tracesSampleRate: 0.001,
    // This Worker calls no other Worker. No trace headers on any outbound call (APNs, Clerk, ...).
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
    beforeSend: scrubEvent,
    beforeSendTransaction: (event) => scrubValue(event),
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
