/**
 * Redaction for everything ADE sends to Sentry, shared by the desktop main
 * process, the renderer, the brain and the forked workers.
 *
 * The line is drawn by `docs/logging.md` ("Error tracking"): error messages,
 * stack traces, file paths, ids and counts are kept, because they are what
 * makes a report actionable. Secrets are always removed, and the text of
 * prompts, transcripts, model output, file contents and terminal output never
 * goes at all. The second half is enforced at the call sites (nothing passes
 * that text to Sentry); this module is the backstop for secrets that ride
 * along inside an error message, a URL or a log field.
 *
 * Pure TypeScript with no SDK import, so every process can load it.
 */

const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 4_000;
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 50;

/** Secret shapes that can appear anywhere inside free text. */
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
  /\b(?:xai-|gsk_|sk_live_|sk_test_|rk_live_)[A-Za-z0-9_-]{16,}/g,
  // npm and Hugging Face tokens have no underscore after the prefix, unlike
  // the many `npm_config_*` variable names.
  /\b(?:npm|hf)_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // `key=value` and `"key": "value"` pairs whose key names a secret.
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|cookie|session[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
  // Credentials embedded in URLs: https://user:pass@host
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

/** Query parameters whose value is a credential. */
const SECRET_QUERY_PARAM = /([?&](?:token|access_token|refresh_token|id_token|code|state|key|api_key|apikey|secret|signature|sig|password|auth)=)[^&#\s]*/gi;

/**
 * Object keys whose string value is dropped wholesale, at any depth. Counts
 * stay: `inputTokens`, `tokenCount` and `tokenId` are not secrets, while
 * `accessToken`, `pushToken` and `token` are.
 */
const SECRET_KEY = /(?:api[_-]?key|apikey|secret|passw(?:or)?d|authorization|cookie|private[_-]?key|machine[_-]?key|pairing[_-]?(?:code|pin)|credential(?!s?[_-]?id)|dsn|token(?!s|[_-]?(?:count|usage|limit|budget|id|ttl|type)))|^pin(?:[_-]?code)?$/i;

/**
 * ADE's relays carry a secret in the URL path, not the query string: the
 * tunnel and push relays address a machine by its `machineKey`
 * (`/host/<key>`, `/connect/<key>`, `/prewarm/<key>`, `/machines/<key>/...`)
 * and the webhook relay delivers to `/hooks/<id>/<token>`. The brain calls
 * those URLs, so they reach breadcrumbs and spans.
 */
const RELAY_KEY_PATH = /\/(host|connect|prewarm|machines)\/[^\s/?#"']+/g;
const RELAY_HOOK_PATH = /\/hooks\/(?!(?:register|events|ack|subscribe)(?:[/?#\s"']|$))[^\s/?#"']+\/[^\s/?#"']+/g;
const URL_WITH_PATH = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;

/** Redacts relay path secrets in a bare path (`/host/<key>`), as a route or `url.path` holds it. */
export function scrubRelayPath(input: string): string {
  return input.replace(RELAY_KEY_PATH, "/$1/[key]").replace(RELAY_HOOK_PATH, "/hooks/[id]/[token]");
}

/**
 * Keys whose value is user content. Their value is replaced by its length, so a
 * report can still say "a 12,000 character prompt" without carrying it.
 */
const CONTENT_KEY = /^(?:prompt|prompts|text|content|contents|message_text|messageText|body|input|inputs|output|outputs|transcript|diff|patch|stdout|stderr_text|clipboard|selection|excerpt|messageExcerpt|query_text|instructions|raw|payload|args|argv|env)$/i;

export function scrubString(input: string): string {
  if (!input) return input;
  let output = input.length > MAX_STRING_LENGTH
    ? `${input.slice(0, MAX_STRING_LENGTH)}… [truncated ${input.length - MAX_STRING_LENGTH} chars]`
    : input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED);
  }
  SECRET_QUERY_PARAM.lastIndex = 0;
  output = output.replace(SECRET_QUERY_PARAM, `$1${REDACTED}`);
  // Only inside URLs: a file path such as `src/host/tunnel.ts` must stay whole.
  output = output.replace(URL_WITH_PATH, (url) => scrubRelayPath(url));
  return output;
}

export function scrubValue(value: unknown, depth = 0, key?: string): unknown {
  if (key !== undefined) {
    if (SECRET_KEY.test(key) && (typeof value === "string" || (typeof value === "object" && value !== null))) return REDACTED;
    if (CONTENT_KEY.test(key)) {
      if (typeof value === "string") return `[content: ${value.length} chars]`;
      if (Array.isArray(value)) return `[content: ${value.length} items]`;
      if (value && typeof value === "object") return `[content: ${Object.keys(value).length} keys]`;
    }
  }
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message), stack: value.stack ? scrubString(value.stack) : undefined };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= MAX_KEYS) {
        output["…"] = "[key limit]";
        break;
      }
      output[entryKey] = scrubValue(entryValue, depth + 1, entryKey);
    }
    return output;
  }
  return String(value);
}

export function scrubRecord(record: Record<string, unknown> | undefined | null): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return scrubValue(record) as Record<string, unknown>;
}

/** Structural view of the parts of a Sentry event this module rewrites. */
type ScrubbableException = { value?: string; stacktrace?: { frames?: Array<{ vars?: Record<string, unknown> }> } };
type ScrubbableRequest = { url?: string; query_string?: unknown; headers?: Record<string, string>; cookies?: unknown; data?: unknown };
export type ScrubbableEvent = {
  message?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown[] };
  exception?: { values?: ScrubbableException[] };
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  tags?: Record<string, unknown>;
  request?: ScrubbableRequest;
  user?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
};
export type ScrubbableBreadcrumb = { message?: string; data?: Record<string, unknown> };

const KEEP_CONTEXT_KEYS = new Set(["os", "device", "app", "runtime", "culture", "gpu", "trace", "electron", "chrome", "node"]);

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry) {
    if (event.logentry.message) event.logentry.message = scrubString(event.logentry.message);
    if (event.logentry.formatted) event.logentry.formatted = scrubString(event.logentry.formatted);
    if (event.logentry.params) event.logentry.params = event.logentry.params.map((param) => scrubValue(param));
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      // Local variables can hold anything; ADE never sends them.
      if (frame.vars) delete frame.vars;
    }
  }
  if (event.extra) event.extra = scrubRecord(event.extra);
  if (event.contexts) {
    for (const [name, context] of Object.entries(event.contexts)) {
      if (!context || KEEP_CONTEXT_KEYS.has(name)) continue;
      event.contexts[name] = scrubRecord(context);
    }
  }
  if (event.tags) {
    for (const [name, tag] of Object.entries(event.tags)) {
      event.tags[name] = typeof tag === "string" ? scrubString(tag) : tag;
    }
  }
  if (event.request) {
    if (event.request.url) event.request.url = scrubString(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      event.request.headers = scrubValue(event.request.headers) as Record<string, string>;
    }
  }
  if (event.user) {
    // Only the pseudonymous id travels. No email, username or IP.
    const id = event.user.id;
    event.user = id === undefined ? {} : { id };
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  return event;
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  if (crumb.message) crumb.message = scrubString(crumb.message);
  if (crumb.data) crumb.data = scrubRecord(crumb.data);
  return crumb;
}

/** Structural view of a streamed span (`beforeSendSpan`). */
export type ScrubbableSpan = { name?: string; attributes?: Record<string, unknown> };

/** Attributes that hold a URL or a request path; `code.filepath` and the like are files. */
const URLISH_ATTRIBUTE = /^(?:url\.|http\.(?:route|target|url)$|server\.address$)|href$/i;

/**
 * Spans carry the URLs of outgoing requests in their name and attributes, and
 * `beforeSend` never sees them. A URL-like attribute may hold a bare path, so
 * those also get the relay path rule that `scrubString` applies inside URLs.
 */
export function scrubSpan<T extends ScrubbableSpan>(span: T): T {
  if (span.name) span.name = scrubRelayPath(scrubString(span.name));
  if (span.attributes) {
    for (const [key, raw] of Object.entries(span.attributes)) {
      const holder = raw && typeof raw === "object" && "value" in raw ? raw as { value: unknown } : null;
      const value = holder ? holder.value : raw;
      const scrubbed = scrubValue(value, 0, key);
      const next = typeof scrubbed === "string" && URLISH_ATTRIBUTE.test(key) ? scrubRelayPath(scrubbed) : scrubbed;
      if (holder) holder.value = next;
      else span.attributes[key] = next;
    }
  }
  return span;
}

/** Structural view of a Sentry log record. */
export type ScrubbableLog = { message?: unknown; attributes?: Record<string, unknown> };

export function scrubLog<T extends ScrubbableLog>(log: T): T {
  if (typeof log.message === "string") log.message = scrubString(log.message);
  if (log.attributes) log.attributes = scrubRecord(log.attributes);
  return log;
}
