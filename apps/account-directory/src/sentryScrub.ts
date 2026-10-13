// What every ADE Worker removes from an event, a breadcrumb or a span before it
// goes to Sentry, and how many events one isolate may send.
//
// This file is the same in all four Workers (account-directory, push-relay,
// tunnel-relay, webhook-relay). Worker sources stay self-contained, so it is
// copied, not imported: change one, change all four. The secret shapes mirror
// `apps/desktop/src/shared/sentry/scrub.ts`.
//
// No SDK import: the types here are structural, so each Worker's `sentry.ts`
// passes its own SDK's event types.

const REDACTED = "[redacted]";

// Secret shapes, matched anywhere in a string.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bsntrys_[A-Za-z0-9_=-]{20,}/g,
  /\b(?:xai-|gsk_|hf_|npm_|sk_live_|sk_test_|rk_live_)[A-Za-z0-9_-]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
];

// A query string can carry a token, a code, or a signed value, so none of it is kept.
const URL_QUERY = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?"'<>]*)\?[^\s"'<>]*/gi;

// The relays carry a secret in the URL path: a machine is addressed by its
// machineKey (`/host/<key>`, `/connect/<key>`, `/prewarm/<key>`,
// `/machines/<key>/...`), and a custom webhook is delivered to
// `/hooks/<id>/<token>`. A Worker's own request URL, route and span names hold
// those paths, so they are rewritten wherever they appear.
const RELAY_KEY_PATH = /\/(host|connect|prewarm|machines)\/[^\s/?#"']+/g;
const RELAY_HOOK_PATH = /\/hooks\/(?!(?:register|events|ack|subscribe)(?:[/?#\s"']|$))[^\s/?#"']+\/[^\s/?#"']+/g;

// Object keys whose values are never sent, whatever object they sit in.
// "payload" covers tunnel frames and webhook deliveries; "body" covers HTTP bodies.
const SENSITIVE_KEY = /token|secret|passw|authorization|cookie|api[_-]?key|credential|private[_-]?key|signature|payload|body|machine[_-]?key|pairing/i;

export function scrubString(value: string): string {
  let out = value.replace(URL_QUERY, "$1?[redacted]");
  out = out.replace(RELAY_KEY_PATH, "/$1/[key]").replace(RELAY_HOOK_PATH, "/hooks/[id]/[token]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function scrubValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (!value || typeof value !== "object") return value;
  // Past a sane depth, drop the subtree rather than risk an unscrubbed secret inside it.
  if (depth > 8) return REDACTED as T;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1)) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(item, depth + 1);
  }
  return out as T;
}

type WorkerEvent = {
  request?: { data?: unknown; cookies?: unknown };
  user?: unknown;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  fingerprint?: string[];
  transaction?: string;
  message?: string;
};

// A Worker has no user of its own, and no body or cookie is ever worth the risk.
export function scrubEvent<T extends WorkerEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
  }
  delete event.user;
  // JSON.parse errors quote the input around the failure, which can be a token or a body.
  for (const exception of event.exception?.values ?? []) {
    if (exception.type === "SyntaxError") exception.value = REDACTED;
  }
  return scrubValue(event);
}

// Console lines are free text. The Worker's structured logs already keep them.
export function scrubBreadcrumb<T extends { category?: string }>(breadcrumb: T): T | null {
  if (breadcrumb.category === "console") return null;
  return scrubValue(breadcrumb);
}

// Spans never pass `beforeSend`; their name and attributes hold the request path.
export function scrubSpan<T extends { name?: string; attributes?: Record<string, unknown> }>(span: T): T {
  if (span.name) span.name = scrubString(span.name);
  if (span.attributes) span.attributes = scrubValue(span.attributes);
  return span;
}

// One isolate's hourly budget: a few events per failure and a hard total. The
// organization has 5,000 errors a month and no server-side rate limit, and a
// bad deploy on a hot route throws once per request. Isolates are many, so
// this bounds a burst rather than the month; it is the difference between
// thousands of copies and millions.
const PER_FAILURE_PER_HOUR = 5;
const TOTAL_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;
let windowStart = 0;
let total = 0;
const perFailure = new Map<string, number>();

export function admitEvent(event: WorkerEvent, nowMs = Date.now()): boolean {
  if (nowMs - windowStart >= HOUR_MS) {
    windowStart = nowMs;
    total = 0;
    perFailure.clear();
  }
  const exception = event.exception?.values?.[event.exception.values.length - 1];
  const key = event.fingerprint?.join("|")
    ?? `${exception?.type ?? "message"}|${event.transaction ?? ""}|${(exception?.value ?? event.message ?? "").slice(0, 80)}`;
  const seen = perFailure.get(key) ?? 0;
  if (total >= TOTAL_PER_HOUR || seen >= PER_FAILURE_PER_HOUR) return false;
  perFailure.set(key, seen + 1);
  total += 1;
  return true;
}
