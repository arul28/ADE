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
 * along inside an error message, a URL or a log field. The one exception is
 * the log tail files a report attaches (`diagnostics.ts`): they carry log
 * lines as written, with only their secrets removed (`scrubDiagnosticText`).
 *
 * Pure TypeScript with no SDK import, so every process can load it.
 */

import { SECRET_TOKEN_PATTERNS } from "../secretTokenShapes";

const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 4_000;
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 50;

/** Secret shapes that can appear anywhere inside free text. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // A key cut off by a length limit still goes, with everything after it.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ...SECRET_TOKEN_PATTERNS,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // `key=value` and `"key": "value"` pairs whose key names a secret.
  // A quoted value goes whole, spaces and all.
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|cookie|session[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"',;&]+)/gi,
  // Credentials embedded in URLs: https://user:pass@host
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

/** Query parameters whose value is a credential. */
const SECRET_QUERY_PARAM = /([?&](?:token|access_token|refresh_token|id_token|code|state|key|api_key|apikey|secret|client_secret|signature|sig|password|auth)=)[^&#\s]*/gi;

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

export function scrubString(input: string, options?: { maxLength?: number }): string {
  if (!input) return input;
  const maxLength = options?.maxLength ?? MAX_STRING_LENGTH;
  let output = input.length > maxLength
    ? `${input.slice(0, maxLength)}… [truncated ${input.length - maxLength} chars]`
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

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// A home path (`~/x`), or an absolute path with at least one folder, also
// after a colon (`path:/Users/a/b`). The lookbehind keeps relative paths
// (`src/a.ts`) whole, and a URL's `//` never starts a folder, so its path stays.
const POSIX_ABSOLUTE_PATH = /(?<![\w./\\~-])(?:~\/[^\s"'`<>]+|\/(?:[^\s/"'`<>]+\/)+[^\s/"'`<>]*)/g;
// A `file:` URL, as Node and Electron stack frames print it, is a path too.
const FILE_URL = /\bfile:\/\/[^\s"'`<>]*/gi;
// `C:\a`, `C:/a` (not `C://`, a URL) and `\\server\share`.
const WINDOWS_ABSOLUTE_PATH = /(?:\b[A-Za-z]:(?=\\|\/(?!\/))|\\\\[^\s\\"'`]+(?=\\))[\\/][^\s"'`<>]*/g;

/**
 * Text a person typed and chose to send (a survey answer, a note on a report).
 * On top of {@link scrubString}'s secrets, it removes email addresses and
 * absolute paths, which name the person or their machine.
 */
export function scrubFreeText(input: string, options?: { maxLength?: number }): string {
  return scrubString(input, options)
    .replace(EMAIL, "[email]")
    .replace(FILE_URL, "[path]")
    .replace(WINDOWS_ABSOLUTE_PATH, "[path]")
    .replace(POSIX_ABSOLUTE_PATH, "[path]");
}

/**
 * How much of its input {@link scrubFreeTextThenCut} scrubs before cutting.
 * Far past any cut it is asked for, so the patterns see the text around the
 * cut point (the default 4,000-char bound would truncate first and leave a
 * secret there half matched), while a runaway input stays bounded.
 */
const SCRUB_THEN_CUT_MAX_INPUT = 64_000;

/**
 * {@link scrubFreeText}, then cut to `maxLength`. Scrubbing first means a
 * secret, email or path that straddles the cut is replaced whole, never left
 * as a prefix too short for its pattern to match. For process output (stderr
 * lines, error messages) bound for a report.
 *
 * Input past the scrub bound is cut first at the last whitespace before it,
 * dropping the token the bound landed in: a URL credential or token cut before
 * the part its pattern needs (the `@` of `scheme://user:pass@`) would otherwise
 * be left unmatched. A private key or quoted secret cut there still goes, since
 * those patterns run to the end of the text.
 */
export function scrubFreeTextThenCut(input: string, maxLength: number): string {
  const bound = Math.max(maxLength, SCRUB_THEN_CUT_MAX_INPUT);
  let bounded = input;
  if (input.length > bound) {
    const head = input.slice(0, bound);
    // A bound that lands on whitespace cut no token.
    const lastSpace = /\s/.test(input.charAt(bound)) ? bound : head.search(/\s\S*$/);
    bounded = lastSpace > 0 ? head.slice(0, lastSpace) : "";
  }
  const scrubbed = scrubFreeText(bounded, { maxLength: Math.max(bounded.length, 1) });
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** Longer than any END line, so one split across two chunks is still found. */
const PRIVATE_KEY_MARKER_CARRY = 64;

/** Whether `text` could still grow into a BEGIN line: the start of one cut by a chunk boundary. */
function couldBecomePrivateKeyBegin(text: string): boolean {
  const head = "-----BEGIN ";
  if (text.length <= head.length) return head.startsWith(text);
  if (!text.startsWith(head) || text.length > PRIVATE_KEY_MARKER_CARRY) return false;
  const rest = text.slice(head.length);
  return /^[A-Z ]*$/.test(rest) || /^[A-Z ]*PRIVATE KEY-{1,4}$/.test(rest);
}

/**
 * Takes private keys out of process output as it arrives, before any of it is
 * kept. A tail bounded by size can otherwise keep a key's body after the cut
 * dropped its BEGIN line, and the scrubber recognizes a key only by that line.
 * Everything from a BEGIN line through its END line becomes `[redacted]`; an
 * END that never comes keeps the rest out. One filter per stream, fed in
 * order; markers split across chunks are found (text that may be the start of
 * a BEGIN line is held until the next chunk says).
 */
export function createPrivateKeyStreamFilter(): { push(chunk: string): string } {
  let insideKey = false;
  // Inside a key: its last characters, to find an END split across chunks.
  // Outside: a possible start of a BEGIN line, held back from the output.
  let carry = "";
  return {
    push(chunk: string): string {
      let rest = carry + chunk;
      carry = "";
      let out = "";
      for (;;) {
        if (insideKey) {
          const end = PRIVATE_KEY_END.exec(rest);
          if (!end) {
            carry = rest.slice(-PRIVATE_KEY_MARKER_CARRY);
            return out;
          }
          insideKey = false;
          out += REDACTED;
          rest = rest.slice(end.index + end[0].length);
          continue;
        }
        const begin = PRIVATE_KEY_BEGIN.exec(rest);
        if (begin) {
          out += rest.slice(0, begin.index);
          insideKey = true;
          rest = rest.slice(begin.index + begin[0].length);
          continue;
        }
        const lineStart = rest.lastIndexOf("\n") + 1;
        for (let index = Math.max(lineStart, rest.length - PRIVATE_KEY_MARKER_CARRY); index < rest.length; index += 1) {
          if (rest.charAt(index) === "-" && couldBecomePrivateKeyBegin(rest.slice(index))) {
            carry = rest.slice(index);
            return out + rest.slice(0, index);
          }
        }
        return out + rest;
      }
    },
  };
}

/**
 * The last lines of a process's output, scrubbed for a report: the kept text
 * is scrubbed as one string before it is split or cut, because a private key
 * spans lines and its pattern runs from the BEGIN line on. A key whose BEGIN
 * line was cut off before the tail is taken out through its END line. Then the
 * last `maxLines` non-empty lines, each cut to `lineChars`. For the Claude
 * reaper's and the desktop drivers' stderr tails, which keep their text
 * through {@link createPrivateKeyStreamFilter} as well.
 */
export function scrubOutputTail(text: string, options: { maxLines: number; lineChars: number }): string[] {
  let kept = text;
  const end = PRIVATE_KEY_END.exec(kept);
  if (end) {
    const begin = kept.search(PRIVATE_KEY_BEGIN);
    if (begin === -1 || begin > end.index) {
      const lineEnd = kept.indexOf("\n", end.index);
      kept = lineEnd === -1 ? "" : kept.slice(lineEnd + 1);
    }
  }
  return scrubFreeTextThenCut(kept, Math.max(kept.length, 1))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-options.maxLines)
    .map((line) => (line.length > options.lineChars ? `${line.slice(0, options.lineChars)}…` : line));
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

/**
 * Secrets only, for the diagnostic files a report attaches (`diagnostics.ts`):
 * a log line keeps its content keys (`args`, `payload`, a prompt length or
 * text), because those files exist to show what the process was doing. Keys
 * that name a secret are still dropped and secret shapes still redacted.
 */
export function scrubSecretsValue(value: unknown, depth = 0, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && (typeof value === "string" || (typeof value === "object" && value !== null))) {
    return REDACTED;
  }
  if (typeof value === "string") return scrubString(value);
  if (value == null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubSecretsValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    output[entryKey] = scrubSecretsValue(entryValue, depth + 1, entryKey);
  }
  return output;
}

/**
 * Remove secrets from a diagnostic file line by line. A JSON line is scrubbed
 * by key (`accessToken`, `pushToken`, `secret`) as well as by shape; any other
 * line, including a JSON line cut short, by shape only.
 */
export function scrubDiagnosticText(text: string, maxLineLength = MAX_STRING_LENGTH): string {
  if (!text) return text;
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.stringify(scrubSecretsValue(JSON.parse(trimmed)));
      } catch {
        // Not JSON after all; scrub it as text.
      }
    }
    return scrubString(line, { maxLength: maxLineLength });
  }).join("\n");
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
