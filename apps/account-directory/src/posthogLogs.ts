// Operational logs to PostHog Logs (OTLP/HTTP, JSON), for log alerts and the
// self-driving "logs" scout.
//
// This file is the same in all four Workers (account-directory, push-relay,
// tunnel-relay, webhook-relay). Worker sources stay self-contained, so it is
// copied, not imported: change one, change all four.
//
// Privacy: a record carries only the worker name, an event name, a level, an
// HTTP method, a route TEMPLATE, a status code, a duration, and an error class.
// Never a URL, query, header, body, token, email, account id, machine key or IP.
// The route template is built by allow-listing path words (see
// `routeTemplate`), so a key in a path can never leave the Worker.
//
// Volume: successful requests are sampled at 2%, client errors at 10%, server
// errors and exceptions at 100%, and one isolate sends at most 120 records a
// minute. Skipped cleanly when no project token is configured. Never awaited
// by the request: it rides `ctx.waitUntil` with a 2 second timeout and swallows
// every failure.

export type PostHogLogsEnv = {
  /** Public `phc_` project token. Falls back to `POSTHOG_PROJECT_TOKEN`. */
  POSTHOG_LOGS_TOKEN?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  /** Ingestion host, default US cloud. Falls back to `POSTHOG_HOST`. */
  POSTHOG_LOGS_HOST?: string;
  POSTHOG_HOST?: string;
  SENTRY_ENVIRONMENT?: string;
  /** `ade@<version>`, set on every deploy; reported as `service.version`. */
  SENTRY_RELEASE?: string;
};

type LogsContext = { waitUntil(promise: Promise<unknown>): void };
type Level = "info" | "warn" | "error";

const PUBLIC_TOKEN = /^phc_[A-Za-z0-9_-]{8,}$/;
const DEFAULT_HOST = "https://us.i.posthog.com";
const SEVERITY: Record<Level, number> = { info: 9, warn: 13, error: 17 };
const SAMPLE_OK = 0.02;
const SAMPLE_CLIENT_ERROR = 0.1;
const MAX_RECORDS_PER_MINUTE = 120;
const SEND_TIMEOUT_MS = 2000;
// The static words of the four Workers' routes. A segment outside this list
// (a repository owner or name, a user name, an id) is `:id`, so a path segment
// a person chose never reaches a log. Add a word when a Worker gains a route.
const ROUTE_WORDS = new Set([
  "account", "ack", "agent", "agents", "approve", "attention", "bindings", "callback", "claim", "clerk",
  "code", "coding-agents", "connect", "cursor", "daily", "developer-token", "device", "diagnostics",
  "events", "graphql", "health", "hooks", "host", "integrations", "jev", "leaderboards", "linear",
  "machines", "models", "music", "notify", "oauth", "orgs", "pairing", "pipe", "prewarm", "register",
  "registry", "repos", "router", "settings", "state", "subscribe", "systemone", "token", "upload",
  "usage-research", "user", "vault", "webhook", "webhooks",
]);
// Segments after which the rest of the path is a secret (machine keys, hook tokens).
const KEY_CARRIERS = new Set(["host", "connect", "prewarm", "machines", "hooks", "webhooks"]);
const MAX_SEGMENTS = 5;

/** `/machines/abc123/state` becomes `/machines/:id`; only the Workers' own route words survive. */
export function routeTemplate(pathname: string): string {
  const out: string[] = [];
  for (const segment of pathname.split("/").slice(1, 1 + MAX_SEGMENTS)) {
    if (!segment) continue;
    if (!ROUTE_WORDS.has(segment)) {
      out.push(":id");
      continue;
    }
    out.push(segment);
    if (KEY_CARRIERS.has(segment)) {
      out.push(":id");
      break;
    }
  }
  return `/${out.join("/")}`;
}

let windowStart = 0;
let windowCount = 0;

function admit(status: number, now: number): boolean {
  const rate = status >= 500 ? 1 : status >= 400 ? SAMPLE_CLIENT_ERROR : SAMPLE_OK;
  if (rate < 1 && Math.random() >= rate) return false;
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_RECORDS_PER_MINUTE) return false;
  windowCount += 1;
  return true;
}

type Attr = string | number | boolean | undefined;

function attributeList(attrs: Record<string, Attr>) {
  const list: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    list.push({
      key,
      value: typeof value === "string" ? { stringValue: value }
        : typeof value === "boolean" ? { boolValue: value }
        : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
    });
  }
  return list;
}

function send(
  env: PostHogLogsEnv,
  ctx: LogsContext | undefined,
  worker: string,
  level: Level,
  event: string,
  attrs: Record<string, Attr>,
): void {
  try {
    // `||`: CI passes an empty POSTHOG_LOGS_TOKEN when its secret is unset.
    const token = (env.POSTHOG_LOGS_TOKEN?.trim() || env.POSTHOG_PROJECT_TOKEN?.trim() || "");
    if (!PUBLIC_TOKEN.test(token)) return;
    const host = (env.POSTHOG_LOGS_HOST ?? env.POSTHOG_HOST ?? DEFAULT_HOST).trim().replace(/\/+$/, "");
    const body = JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: attributeList({
            "service.name": worker,
            "deployment.environment": env.SENTRY_ENVIRONMENT?.trim() || "development",
            ...(env.SENTRY_RELEASE?.trim() ? { "service.version": env.SENTRY_RELEASE.trim().replace(/^ade@/, "") } : {}),
          }),
        },
        scopeLogs: [{
          scope: { name: "ade-worker-logs" },
          logRecords: [{
            timeUnixNano: `${Date.now()}000000`,
            severityNumber: SEVERITY[level],
            severityText: level.toUpperCase(),
            body: { stringValue: event },
            attributes: attributeList({ event, ...attrs }),
          }],
        }],
      }],
    });
    const pending = fetch(`${host}/i/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).then(() => undefined, () => undefined);
    ctx?.waitUntil(pending);
  } catch {
    // Logging never fails a request.
  }
}

export function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}

/** One record for a finished request. `/health` is never logged. */
export function reportRequest(
  env: PostHogLogsEnv,
  ctx: LogsContext | undefined,
  worker: string,
  request: Request,
  status: number,
  startedAt: number,
  error?: unknown,
): void {
  try {
    const route = routeTemplate(new URL(request.url).pathname);
    if (route === "/health") return;
    const failed = error !== undefined;
    if (!admit(failed ? 500 : status, Date.now())) return;
    const level: Level = failed || status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    send(env, ctx, worker, level, "request_completed", {
      method: request.method,
      route,
      status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      error_class: failed ? errorClass(error) : undefined,
    });
  } catch {
    // Logging never fails a request.
  }
}

/** One record for a failed background job (cron). Always sent, within the cap. */
export function reportJobFailure(
  env: PostHogLogsEnv,
  ctx: LogsContext | undefined,
  worker: string,
  job: string,
  error: unknown,
): void {
  if (!admit(500, Date.now())) return;
  send(env, ctx, worker, "error", "job_failed", { job: job.slice(0, 40), error_class: errorClass(error) });
}
