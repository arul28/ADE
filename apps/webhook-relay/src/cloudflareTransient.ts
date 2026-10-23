// Cloudflare's own short failures: D1 and Durable Object storage that is
// restarting, overloaded, or briefly unreachable. They come in bursts on
// Cloudflare's side and say nothing about ADE's code, so a Worker retries what
// is safe to retry and otherwise answers 503 with Retry-After, which every ADE
// client already treats as "try again shortly".
//
// This file is the same in all four Workers (account-directory, push-relay,
// tunnel-relay, webhook-relay). Worker sources stay self-contained, so it is
// copied, not imported: change one, change all four
// (`scripts/check-worker-sentry-scrub.mjs` fails when they drift).

// One entry per kind of failure, most specific first. The kind is also the
// Sentry fingerprint, so each carries one issue whatever its "reference = …".
const TRANSIENT_KINDS: ReadonlyArray<[RegExp, string]> = [
  [/Durable Object reset because its code was updated/, "durable-object-code-updated"],
  [/D1 DB is overloaded/, "d1-overloaded"],
  [/D1 DB storage caused object to be reset/, "d1-storage-reset"],
  [/D1_ERROR: internal error/, "d1-internal-error"],
  [/D1_ERROR:[^\n]*Durable Object instance is no longer active/, "d1-connection-closed"],
  [/Cannot resolve D1 DB due to transient issue/, "d1-transient"],
  [/Durable Object storage/, "durable-object-storage"],
  [/Durable Object instance is no longer active/, "durable-object-inactive"],
  [/Durable Object is overloaded/, "durable-object-overloaded"],
  [/internal error; reference =/i, "cloudflare-internal-error"],
  [/Network connection lost/, "network-connection-lost"],
];

/** The kind of Cloudflare transient failure a message describes, or null. */
export function cloudflareTransientKindOfText(text: string): string | null {
  return TRANSIENT_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

type CloudflareError = { message?: unknown; cause?: unknown; retryable?: unknown; overloaded?: unknown };

/**
 * The kind of Cloudflare transient failure an error is, or null for anything
 * else (a constraint, a bad query, a bug). D1 wraps the storage error in
 * `cause`, and a Durable Object error may carry only the `retryable` flag.
 */
export function cloudflareTransientKind(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as CloudflareError;
    if (candidate.overloaded === true) return "durable-object-overloaded";
    const kind = typeof candidate.message === "string" ? cloudflareTransientKindOfText(candidate.message) : null;
    if (kind) return kind;
    if (candidate.retryable === true) return "cloudflare-retryable";
    current = candidate.cause;
  }
  return null;
}

/**
 * Whether running the same operation again can succeed. An overloaded Durable
 * Object asks callers to back off, so it is never retried here; the caller's
 * own Retry-After backoff covers it.
 */
export function isRetryableCloudflareError(error: unknown): boolean {
  const kind = cloudflareTransientKind(error);
  return kind != null && kind !== "durable-object-overloaded";
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;

/**
 * Runs `operation`, and again (up to three tries, ~1 s in all) when it fails
 * with a retryable Cloudflare error. Only for operations that are safe to run
 * twice: a read, or a write whose second run leaves the same state.
 */
export async function withCloudflareRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS || !isRetryableCloudflareError(error)) throw error;
      // 100–200 ms, then 400–800 ms: past D1's own immediate retries, and
      // jittered so a burst's waiters do not all come back at once.
      const base = RETRY_BASE_DELAY_MS * 4 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
    }
  }
}

// A statement is read-only when it is a plain SELECT. Anything else (an
// upsert, a RETURNING write, a CTE) may change state, so retrying it is the
// caller's call, made with `withCloudflareRetry`.
const READ_ONLY_SQL = /^\s*select\b/i;

class ReadRetryStatement {
  constructor(readonly inner: D1PreparedStatement, readonly readOnly: boolean) {}

  bind(...values: unknown[]): ReadRetryStatement {
    return new ReadRetryStatement(this.inner.bind(...values), this.readOnly);
  }

  first(column?: string): Promise<unknown> {
    return this.call(() => (column === undefined ? this.inner.first() : this.inner.first(column)));
  }

  all(): Promise<unknown> {
    return this.call(() => this.inner.all());
  }

  run(): Promise<unknown> {
    return this.call(() => this.inner.run());
  }

  raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return this.call(() => this.inner.raw(options as { columnNames: true }));
  }

  private call<T>(operation: () => Promise<T>): Promise<T> {
    return this.readOnly ? withCloudflareRetry(operation) : operation();
  }
}

const unwrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
  statement instanceof ReadRetryStatement ? statement.inner : statement;

const retryingDatabases = new WeakSet<object>();

/**
 * The same database, with every read-only statement (and every all-read batch)
 * retried on a retryable Cloudflare error. Writes run once, as before.
 */
export function retryD1Reads(db: D1Database): D1Database {
  if (!db || retryingDatabases.has(db)) return db;
  const wrapped = {
    prepare: (sql: string) => new ReadRetryStatement(db.prepare(sql), READ_ONLY_SQL.test(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      const inner = statements.map(unwrapStatement);
      const readOnly = statements.every((statement) => statement instanceof ReadRetryStatement && statement.readOnly);
      return readOnly ? withCloudflareRetry(() => db.batch(inner)) : db.batch(inner);
    },
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraintOrBookmark?: string) => db.withSession(constraintOrBookmark),
  } as unknown as D1Database;
  retryingDatabases.add(wrapped);
  return wrapped;
}

/** Seconds a client should wait before retrying after a transient failure. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 5;

/** The answer to a request that hit a Cloudflare transient failure. */
export function transientUnavailableResponse(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "temporarily unavailable", code: "cloudflare_transient" }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": String(TRANSIENT_RETRY_AFTER_SECONDS),
        ...headers,
      },
    },
  );
}

/**
 * One structured log line per answered transient failure. Not sent to Sentry:
 * the request was answered and the client retries. The message is cut short;
 * Cloudflare's messages name no secrets, but a wrapped one could.
 */
export function logCloudflareTransient(worker: string, kind: string, path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    svc: worker,
    kind: "cloudflare_transient",
    transient: kind,
    path,
    message: message.slice(0, 120),
  }));
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * `stub.fetch` with Cloudflare's guidance for a failed Durable Object call:
 * a retryable failure gets one more try on a fresh stub, when the request is
 * safe to send twice. A WebSocket upgrade is never retried (the object may
 * have accepted its half of the socket before failing); the client reconnects.
 * `replayable` says whether a request with a body may be sent again.
 *
 * A transient failure that was not recovered comes back as `transient`, so the
 * caller answers 503 in its own shape; any other failure is rethrown.
 */
export async function fetchDurableObject(
  getStub: () => DurableObjectStub,
  request: Request,
  options: { replayable?: boolean } = {},
): Promise<{ response: Response } | { transient: string; error: unknown }> {
  const idempotent = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  const retry = !isWebSocketUpgrade(request) && (idempotent || options.replayable === true);
  // workers-types types `clone()` with incoming-request `cf` metadata; it is the same request.
  const second = retry && request.body ? (request.clone() as unknown as Request) : null;
  try {
    return { response: await getStub().fetch(request) };
  } catch (error) {
    const kind = cloudflareTransientKind(error);
    if (!kind) throw error;
    if (!retry || !isRetryableCloudflareError(error)) return { transient: kind, error };
    try {
      return { response: await getStub().fetch(second ?? request) };
    } catch (retryError) {
      const retryKind = cloudflareTransientKind(retryError);
      if (!retryKind) throw retryError;
      return { transient: retryKind, error: retryError };
    }
  }
}
