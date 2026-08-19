import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupDiagnosticsUploadDays,
  DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT,
  DIAGNOSTICS_BUDGET_RETENTION_DAYS,
  handleDiagnosticsRequest,
  isDiagnosticsRequest,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  MAX_DIAGNOSTIC_UPLOADS_PER_DAY,
  type DiagnosticsEnv,
} from "../src/diagnostics";
import worker from "../src/index";
import { FakeD1Database } from "./fakeD1";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

const UPLOAD_URL = "https://directory.test/diagnostics/upload";

/**
 * Fake R2, in the same spirit as the fake D1 in `./fakeD1`: enough of
 * the real surface to hold the contract (prefix listing, custom metadata,
 * stored bytes) and nothing else, so a test failure points at the route rather
 * than at the fake.
 */
class FakeR2Bucket {
  readonly objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string>; contentType: string | undefined }
  >();

  listCalls: Array<{ prefix?: string; limit?: number }> = [];

  /** Set to make every `put` reject, the way a bucket having a bad minute does. */
  putFailure: Error | null = null;

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
    if (this.putFailure) throw this.putFailure;
    const body = typeof value === "string"
      ? value
      : new TextDecoder().decode(value as ArrayBuffer);
    this.objects.set(key, {
      body,
      customMetadata: { ...(options?.customMetadata ?? {}) },
      contentType: options?.httpMetadata?.contentType,
    });
  }

  async list(
    options?: { prefix?: string; limit?: number },
  ): Promise<{ objects: Array<{ key: string }>; truncated: boolean }> {
    this.listCalls.push({ prefix: options?.prefix, limit: options?.limit });
    const prefix = options?.prefix ?? "";
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const limited = options?.limit === undefined ? keys : keys.slice(0, options.limit);
    return {
      objects: limited.map((key) => ({ key })),
      truncated: limited.length < keys.length,
    };
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

/**
 * The route now claims a slot out of a D1-held fleet budget before every write,
 * so a real fake database is part of the harness rather than a stub: an env
 * whose `DB` cannot answer is exactly the fail-closed case, and it has its own
 * test below.
 */
function makeEnv(
  overrides: Partial<DiagnosticsEnv> = {},
): DiagnosticsEnv & { DIAGNOSTICS: FakeR2Bucket; DB: FakeD1Database } {
  return {
    DB: new FakeD1Database(),
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    DIAGNOSTICS: new FakeR2Bucket(),
    ...overrides,
  } as unknown as DiagnosticsEnv & { DIAGNOSTICS: FakeR2Bucket; DB: FakeD1Database };
}

/** How much of today's fleet budget the route has claimed. */
function spentBudget(env: { DB: FakeD1Database }, dayKey = FIXED_DAY_KEY): number {
  return env.DB.diagnosticsUploadDays.get(dayKey) ?? 0;
}

/** Captures the structured upload lines a request emits. */
async function captureUploadLines<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
  const raw: string[] = [];
  const logged = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    raw.push(String(line));
  });
  try {
    const result = await run();
    return {
      result,
      lines: raw
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.kind === "diagnostics_upload"),
    };
  } finally {
    logged.mockRestore();
  }
}

/** A distinct address per test: the anonymous quota is keyed on the caller IP. */
let addressCounter = 0;
function nextIp(): string {
  addressCounter += 1;
  return `203.0.113.${addressCounter}`;
}

function uploadRequest(args: {
  body: string;
  contentType?: string;
  token?: string;
  /** `null` omits the header entirely — what a request that never crossed Cloudflare looks like. */
  ip?: string | null;
  url?: string;
  headers?: Record<string, string>;
}): Request {
  const ip = args.ip === undefined ? nextIp() : args.ip;
  return new Request(args.url ?? UPLOAD_URL, {
    method: "POST",
    headers: {
      "content-type": args.contentType ?? "application/json",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
      ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
      ...(args.headers ?? {}),
    },
    body: args.body,
  });
}

const REPORT = "# ADE diagnostic report\n\n- surface: brain_repair\n- installId: abc123\n";

const KEY_SHAPE =
  /^reports\/\d{4}-\d{2}-\d{2}\/(u-[A-Za-z0-9_-]+|anon-[0-9a-f]{16})\/[0-9a-f-]{36}\.md$/;

/**
 * A fixed clock for every test that reasons about the day bucket.
 *
 * The quota key is the UTC day, so a test that spans midnight — either by
 * deriving the prefix itself while the route derives its own, or by making
 * several requests in a row — would silently be asking about two different
 * days. `handleDiagnosticsRequest` takes `now` for exactly this.
 */
const FIXED_NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const FIXED_DAY_KEY = new Date(FIXED_NOW).toISOString().slice(0, 10);
const FIXED_CLOCK = { now: () => FIXED_NOW };

describe("diagnostics upload route", () => {
  it("matches only the upload path", () => {
    expect(isDiagnosticsRequest(new URL(UPLOAD_URL))).toBe(true);
    expect(isDiagnosticsRequest(new URL(`${UPLOAD_URL}/`))).toBe(true);
    expect(isDiagnosticsRequest(new URL("https://directory.test/diagnostics"))).toBe(false);
    expect(isDiagnosticsRequest(new URL("https://directory.test/account/machines"))).toBe(false);
  });

  it("stores an anonymous upload under a dated per-caller key", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({
        body: JSON.stringify({ report: REPORT, installId: "install-9", appVersion: "1.2.60" }),
        ip: "203.0.113.200",
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; id: string };
    expect(payload.ok).toBe(true);
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);

    const keys = env.DIAGNOSTICS.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(KEY_SHAPE);
    expect(keys[0]).toContain("/anon-");
    expect(keys[0]?.endsWith(`${payload.id}.md`)).toBe(true);

    const stored = env.DIAGNOSTICS.objects.get(keys[0]!)!;
    // The body is the report byte-for-byte: redaction happens upstream, on the
    // machine, and this route must not touch what it was handed.
    expect(stored.body).toBe(REPORT);
    expect(stored.contentType).toBe("text/markdown; charset=utf-8");
    expect(stored.customMetadata).toEqual({ installId: "install-9", appVersion: "1.2.60" });
  });

  it("never echoes the report back", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      env,
    );
    const raw = await response.text();
    expect(raw).not.toContain("ADE diagnostic report");
    expect(JSON.parse(raw)).toEqual({ ok: true, id: expect.any(String) });
  });

  it("keys an authenticated upload by Clerk user id and records it in metadata", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({
        body: JSON.stringify({ report: REPORT, installId: "install-7" }),
        token: await mintToken({ sub: "user_42" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const keys = env.DIAGNOSTICS.keys();
    expect(keys[0]).toMatch(KEY_SHAPE);
    expect(keys[0]).toContain("/u-user_42/");
    expect(env.DIAGNOSTICS.objects.get(keys[0]!)!.customMetadata).toEqual({
      userId: "user_42",
      installId: "install-7",
    });
  });

  it("rejects a bearer token that does not verify instead of storing it anonymously", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), token: "not-a-jwt" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("refuses an Authorization header it cannot parse instead of downgrading it", async () => {
    const env = makeEnv();
    // A client that believes it is signed in and is not. Storing this anonymously
    // would hide the broken sign-in from the one user in a position to report it.
    const response = await handleDiagnosticsRequest(
      uploadRequest({
        body: JSON.stringify({ report: REPORT }),
        headers: { authorization: "Token abc123" },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("answers 503, not 401, when this Worker has no Clerk configuration", async () => {
    // A deployment fault, not a bad token: 401 would send the user to sign in
    // again forever. The account routes classify it the same way.
    const env = makeEnv({ CLERK_JWKS_URL: "" });
    const response = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), token: await mintToken() }),
      env,
    );
    expect(response.status).toBe(503);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("refuses a cross-site browser upload but not ADE's own renderer", async () => {
    const env = makeEnv();
    const hostile = await handleDiagnosticsRequest(
      uploadRequest({
        body: JSON.stringify({ report: REPORT }),
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
      }),
      env,
    );
    expect(hostile.status).toBe(403);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);

    // Electron's renderer is cross-site to this Worker too: `file://` in a
    // packaged build sends `Origin: null`, development sends loopback. Both are
    // the real "Send to ADE" button and neither may be caught by this.
    for (const origin of ["null", "http://localhost:5173"]) {
      const renderer = await handleDiagnosticsRequest(
        uploadRequest({
          body: JSON.stringify({ report: REPORT }),
          headers: { "sec-fetch-site": "cross-site", origin },
        }),
        env,
      );
      expect(renderer.status).toBe(200);
    }
    // The CLI and every other non-browser sender set no fetch-metadata header.
    const cli = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      env,
    );
    expect(cli.status).toBe(200);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(3);
  });

  it("never lets a caller-set forwarding header buy a fresh quota", async () => {
    // Off Cloudflare there is no trustworthy address, so everyone shares one
    // bucket. Trusting `x-forwarded-for` would make the quota opt-out.
    const env = makeEnv();
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const accepted = await handleDiagnosticsRequest(
        uploadRequest({
          body: JSON.stringify({ report: REPORT }),
          ip: null,
          headers: { "x-forwarded-for": `198.51.100.${attempt}` },
        }),
        env,
        FIXED_CLOCK,
      );
      expect(accepted.status).toBe(200);
    }
    const refused = await handleDiagnosticsRequest(
      uploadRequest({
        body: JSON.stringify({ report: REPORT }),
        ip: null,
        headers: { "x-forwarded-for": "198.51.100.99" },
      }),
      env,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
  });

  it("accepts a text/plain body with query metadata", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({
        body: REPORT,
        contentType: "text/plain; charset=utf-8",
        url: `${UPLOAD_URL}?installId=install-plain&appVersion=9.9.9`,
      }),
      env,
    );
    expect(response.status).toBe(200);
    const stored = env.DIAGNOSTICS.objects.get(env.DIAGNOSTICS.keys()[0]!)!;
    expect(stored.body).toBe(REPORT);
    expect(stored.customMetadata).toEqual({
      installId: "install-plain",
      appVersion: "9.9.9",
    });
  });

  it("rejects an empty or unparseable report", async () => {
    const env = makeEnv();
    const blank = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: "   " }) }),
      env,
    );
    expect(blank.status).toBe(400);
    const garbage = await handleDiagnosticsRequest(
      uploadRequest({ body: "{not json" }),
      env,
    );
    expect(garbage.status).toBe(400);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("rejects a report over the size cap without storing it", async () => {
    const env = makeEnv();
    const oversized = "x".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1_024);
    const response = await handleDiagnosticsRequest(
      uploadRequest({ body: oversized, contentType: "text/plain" }),
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "report too large" });
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("counts the streamed body rather than trusting content-length", async () => {
    const env = makeEnv();
    const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(UPLOAD_URL, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": "10",
        "cf-connecting-ip": nextIp(),
      },
      body: stream,
      // Node's fetch requires this for a streaming request body.
      duplex: "half",
    } as RequestInit);

    const response = await handleDiagnosticsRequest(request, env);
    expect(response.status).toBe(413);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
  });

  it("allows five uploads a day per caller and refuses the sixth", async () => {
    const env = makeEnv();
    const ip = "198.51.100.7";
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const accepted = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
      expect(accepted.status).toBe(200);
    }
    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("86400");
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);

    // A different caller is unaffected, and the durable half of the limit is a
    // prefix listing scoped to that caller's day.
    const other = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "198.51.100.8" }),
      env,
      FIXED_CLOCK,
    );
    expect(other.status).toBe(200);
    expect(env.DIAGNOSTICS.listCalls.at(-1)?.prefix).toBe(
      `reports/${FIXED_DAY_KEY}/anon-${createHash("sha256").update("198.51.100.8").digest("hex").slice(0, 16)}/`,
    );
    expect(env.DIAGNOSTICS.listCalls.at(-1)?.limit).toBe(MAX_DIAGNOSTIC_UPLOADS_PER_DAY + 1);
  });

  it("enforces the day quota from stored objects when this isolate has no memory of them", async () => {
    // The isolate counter is only a fast path; a recycled isolate must still
    // refuse a caller who already spent the day's quota, which is what the R2
    // prefix listing is for.
    const env = makeEnv();
    const ip = "198.51.100.30";
    const identity = `anon-${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
    const prefix = `reports/${FIXED_DAY_KEY}/${identity}/`;
    for (let index = 0; index < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; index += 1) {
      await env.DIAGNOSTICS.put(`${prefix}seeded-${index}.md`, "stored by an earlier isolate");
    }

    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
  });

  it("answers a bounded status and still logs one line when the store refuses the write", async () => {
    // The log line is the only record that an upload happened, so the one path
    // where the store itself fails must not be the path that answers silently.
    const env = makeEnv();
    env.DIAGNOSTICS.putFailure = new Error("R2 unavailable");
    const lines: string[] = [];
    const logged = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    let response: Response;
    try {
      response = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
        env,
      );
    } finally {
      logged.mockRestore();
    }

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "diagnostics upload failed" });
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);

    const uploadLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.kind === "diagnostics_upload");
    expect(uploadLines).toHaveLength(1);
    expect(uploadLines[0]).toMatchObject({
      outcome: "rejected",
      status: 502,
      reason: "storage_write_failed",
      authenticated: false,
    });
  });

  it("answers 503 when the bucket binding is missing", async () => {
    const env = makeEnv({ DIAGNOSTICS: undefined });
    const response = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      env,
    );
    expect(response.status).toBe(503);
  });

  it("answers the browser preflight and refuses other methods", async () => {
    const env = makeEnv();
    const preflight = await handleDiagnosticsRequest(
      new Request(UPLOAD_URL, {
        method: "OPTIONS",
        headers: { origin: "null", "access-control-request-method": "POST" },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const wrongMethod = await handleDiagnosticsRequest(
      new Request(UPLOAD_URL, { method: "GET" }),
      env,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("stops the whole fleet at the daily budget, whoever is uploading", async () => {
    // The per-caller quota bounds one person. This bounds the bill: clients now
    // send reports automatically on failure, so the number of DISTINCT callers
    // is the thing that runs away, and no per-caller limit can see that.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "3" });
    for (let caller = 0; caller < 3; caller += 1) {
      const accepted = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: `192.0.2.${caller}` }),
        env,
        FIXED_CLOCK,
      );
      expect(accepted.status).toBe(200);
    }
    expect(spentBudget(env)).toBe(3);

    // A caller who has never uploaded before, well inside their own five.
    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.99" }),
      env,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "daily diagnostics budget exhausted" });
    // Honest seconds to the reset rather than a flat day: FIXED_NOW is UTC noon.
    expect(refused.headers.get("retry-after")).toBe("43200");
    expect(env.DIAGNOSTICS.keys()).toHaveLength(3);
    // The refusal did not bump the counter past the ceiling it enforces.
    expect(spentBudget(env)).toBe(3);
  });

  it("keeps the fleet 429 distinguishable from the per-caller 429", async () => {
    // A client that cannot tell them apart cannot decide whether backing off
    // its own sends would help, and an auto-sender that reads a fleet-wide stop
    // as its own quota retries forever.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "1000" });
    const ip = "198.51.100.61";
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
    }
    const perCaller = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
      FIXED_CLOCK,
    );
    expect(perCaller.status).toBe(429);
    expect(await perCaller.json()).toEqual({ error: "rate limited" });
    expect(perCaller.headers.get("retry-after")).toBe("86400");

    // And a caller refused by their OWN quota must not have spent fleet budget:
    // otherwise one abusive sender denies the route to everybody else.
    expect(spentBudget(env)).toBe(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
  });

  it("does not spend a caller's day on uploads the fleet budget refused", async () => {
    // Regression: the per-identity counter advanced when the limit was CHECKED,
    // so five refusals the caller did not cause — a fleet budget that was out
    // for the day — locked that install out of the route until UTC midnight,
    // having stored nothing. Both halves of the quota count stored objects.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "0" });
    const ip = "198.51.100.71";
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const refused = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: "daily diagnostics budget exhausted" });
    }
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);

    // The kill switch comes off and this caller still has their whole day.
    env.DIAGNOSTICS_DAILY_GLOBAL_LIMIT = "1000";
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const accepted = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
      expect(accepted.status).toBe(200);
    }
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
  });

  it("does not spend a caller's day on uploads the bucket dropped", async () => {
    // Same rule from the other side: the refund the fleet budget already gets
    // for a failed `put` has to apply to the per-identity quota too, or a
    // bucket having a bad minute costs the user their reports for the day.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "1000" });
    const ip = "198.51.100.72";
    env.DIAGNOSTICS.putFailure = new Error("R2 is having a moment");
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const failed = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
      expect(failed.status).toBe(502);
    }
    expect(spentBudget(env)).toBe(0);

    env.DIAGNOSTICS.putFailure = null;
    const accepted = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
      FIXED_CLOCK,
    );
    expect(accepted.status).toBe(200);
  });

  it("still enforces the per-caller quota under a generous fleet budget", async () => {
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "1000" });
    const ip = "198.51.100.62";
    for (let attempt = 0; attempt < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; attempt += 1) {
      const accepted = await handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
        env,
        FIXED_CLOCK,
      );
      expect(accepted.status).toBe(200);
    }
    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
  });

  it("counts the fleet budget per UTC day, not per rolling window", async () => {
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "1" });
    const first = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.10" }),
      env,
      FIXED_CLOCK,
    );
    expect(first.status).toBe(200);
    const sameDay = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.11" }),
      env,
      FIXED_CLOCK,
    );
    expect(sameDay.status).toBe(429);

    const nextDayMs = FIXED_NOW + 86_400_000;
    const nextDay = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.12" }),
      env,
      { now: () => nextDayMs },
    );
    expect(nextDay.status).toBe(200);
    expect(spentBudget(env, new Date(nextDayMs).toISOString().slice(0, 10))).toBe(1);
  });

  it("treats a configured zero as a kill switch and an unreadable value as the default", async () => {
    const off = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "0" });
    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      off,
      FIXED_CLOCK,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "daily diagnostics budget exhausted" });
    // Nothing is written for an upload that was never going to happen.
    expect(off.DB.diagnosticsUploadDays.size).toBe(0);

    // A typo must not uncap the bill OR close the route; it falls back.
    const typo = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "four hundred" });
    const accepted = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      typo,
      FIXED_CLOCK,
    );
    expect(accepted.status).toBe(200);
    expect(DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT).toBe(400);
  });

  it("refuses rather than storing uncounted when the budget cannot be claimed", async () => {
    // Fail closed on purpose: a ceiling that is skipped whenever D1 hiccups is
    // not a ceiling, and this route is the least critical thing the Worker does.
    const env = makeEnv();
    env.DB.prepare = () => {
      throw new Error("no such table: diagnostics_upload_days");
    };
    const { result: response, lines } = await captureUploadLines(() =>
      handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
        env,
        FIXED_CLOCK,
      )
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "diagnostics upload unavailable" });
    expect(env.DIAGNOSTICS.keys()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 503, reason: "budget_unavailable" });
  });

  it("gives the budget slot back when the store refuses the write", async () => {
    // The claim has to precede the put, so an R2 outage would otherwise burn the
    // day's ceiling on reports nobody can ever read.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "1" });
    env.DIAGNOSTICS.putFailure = new Error("R2 unavailable");
    const failed = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.20" }),
      env,
      FIXED_CLOCK,
    );
    expect(failed.status).toBe(502);
    expect(spentBudget(env)).toBe(0);

    // Proof the refund is real and not just a decremented number: the slot it
    // returned is spendable by the next upload.
    env.DIAGNOSTICS.putFailure = null;
    const accepted = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "192.0.2.21" }),
      env,
      FIXED_CLOCK,
    );
    expect(accepted.status).toBe(200);
    expect(spentBudget(env)).toBe(1);
  });

  it("stores and logs the auto flag and failure code an automatic send carries", async () => {
    const env = makeEnv();
    const { result: response, lines } = await captureUploadLines(() =>
      handleDiagnosticsRequest(
        uploadRequest({
          body: JSON.stringify({
            report: REPORT,
            installId: "install-auto",
            auto: true,
            failureCode: "brain_start_timeout",
          }),
        }),
        env,
        FIXED_CLOCK,
      )
    );
    expect(response.status).toBe(200);
    const stored = env.DIAGNOSTICS.objects.get(env.DIAGNOSTICS.keys()[0]!)!;
    expect(stored.customMetadata).toEqual({
      installId: "install-auto",
      auto: "true",
      failureCode: "brain_start_timeout",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: "stored",
      auto: true,
      failureCode: "brain_start_timeout",
    });
  });

  it("reads the auto flag and failure code from query parameters for a text/plain send", async () => {
    const env = makeEnv();
    const response = await handleDiagnosticsRequest(
      uploadRequest({
        body: REPORT,
        contentType: "text/plain; charset=utf-8",
        url: `${UPLOAD_URL}?auto=1&failureCode=sync-handshake_9`,
      }),
      env,
      FIXED_CLOCK,
    );
    expect(response.status).toBe(200);
    expect(env.DIAGNOSTICS.objects.get(env.DIAGNOSTICS.keys()[0]!)!.customMetadata).toEqual({
      auto: "true",
      failureCode: "sync-handshake_9",
    });
  });

  it("records a manual send as manual and leaves its metadata untouched", async () => {
    const env = makeEnv();
    const { result: response, lines } = await captureUploadLines(() =>
      handleDiagnosticsRequest(
        uploadRequest({ body: JSON.stringify({ report: REPORT, auto: false }) }),
        env,
        FIXED_CLOCK,
      )
    );
    expect(response.status).toBe(200);
    // Absent means manual: an upload from a sender that predates the flag stores
    // exactly the metadata it always did.
    expect(env.DIAGNOSTICS.objects.get(env.DIAGNOSTICS.keys()[0]!)!.customMetadata).toEqual({});
    // Logged as false rather than omitted, so "how many sends were automatic"
    // is a ratio with both sides present.
    expect(lines[0]).toMatchObject({ auto: false });
    expect(lines[0]).not.toHaveProperty("failureCode");
  });

  it("drops a failure code that does not match the shape without refusing the report", async () => {
    // The label is cosmetic; the report is not. Failing the upload over a bad
    // one would lose exactly the diagnostics the auto-send path exists to
    // collect.
    const env = makeEnv();
    const malformed = [
      "Brain_Start",
      "9lives",
      "has space",
      "trailing!",
      "x".repeat(49),
      "",
    ];
    for (const failureCode of malformed) {
      const { result: response, lines } = await captureUploadLines(() =>
        handleDiagnosticsRequest(
          uploadRequest({ body: JSON.stringify({ report: REPORT, auto: true, failureCode }) }),
          env,
          FIXED_CLOCK,
        )
      );
      expect(response.status).toBe(200);
      expect(lines[0]).not.toHaveProperty("failureCode");
    }
    for (const key of env.DIAGNOSTICS.keys()) {
      expect(env.DIAGNOSTICS.objects.get(key)!.customMetadata).toEqual({ auto: "true" });
    }
    expect(env.DIAGNOSTICS.keys()).toHaveLength(malformed.length);

    // The boundary the shape does allow: 48 characters, the first a letter.
    const longest = `a${"b".repeat(47)}`;
    await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT, failureCode: longest }) }),
      env,
      FIXED_CLOCK,
    );
    expect(env.DIAGNOSTICS.objects.get(env.DIAGNOSTICS.keys().at(-1)!)!.customMetadata).toEqual({
      failureCode: longest,
    });
  });

  it("carries the auto flag onto the refusal lines, not just the stored one", async () => {
    // The day the fleet budget is first exhausted, "which failure is generating
    // all this traffic" has to be answerable from the refusals.
    const env = makeEnv({ DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "0" });
    const { lines } = await captureUploadLines(() =>
      handleDiagnosticsRequest(
        uploadRequest({
          body: JSON.stringify({ report: REPORT, auto: true, failureCode: "sync_wedged" }),
        }),
        env,
        FIXED_CLOCK,
      )
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: "rejected",
      status: 429,
      reason: "global_budget_exhausted",
      auto: true,
      failureCode: "sync_wedged",
    });
  });

  it("is reachable through the Worker entry point without account authentication", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      uploadRequest({ body: JSON.stringify({ report: REPORT }) }),
      env,
    );
    expect(response.status).toBe(200);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(1);
  });
});

describe("diagnostics budget sweep", () => {
  function seedDays(env: { DB: FakeD1Database }, days: Record<string, number>): void {
    for (const [day, count] of Object.entries(days)) env.DB.diagnosticsUploadDays.set(day, count);
  }

  function dayOffset(days: number): string {
    return new Date(FIXED_NOW + days * 86_400_000).toISOString().slice(0, 10);
  }

  it("prunes budget rows past the retention window and never today's", async () => {
    const env = makeEnv();
    seedDays(env, {
      [dayOffset(-30)]: 400,
      [dayOffset(-8)]: 12,
      [dayOffset(-DIAGNOSTICS_BUDGET_RETENTION_DAYS)]: 7,
      [dayOffset(-1)]: 3,
      [FIXED_DAY_KEY]: 5,
    });

    const removed = await cleanupDiagnosticsUploadDays(env, FIXED_NOW);

    expect(removed).toBe(2);
    // The cutoff day itself is kept — `day < cutoff`, so retention is inclusive
    // — and today is never in range, which is what stops a sweep from handing
    // back budget the running day has already spent.
    expect([...env.DB.diagnosticsUploadDays.keys()].sort()).toEqual(
      [dayOffset(-DIAGNOSTICS_BUDGET_RETENTION_DAYS), dayOffset(-1), FIXED_DAY_KEY].sort(),
    );
    expect(env.DB.diagnosticsUploadDays.get(FIXED_DAY_KEY)).toBe(5);
  });

  it("runs from the Worker's scheduled handler alongside the other sweeps", async () => {
    // The cron is the only thing that stops this table from growing a row a day
    // forever, so it has to be wired into the handler, not just exported.
    const env = makeEnv();
    // The handler passes no clock, so "today" here is the real one.
    const today = new Date().toISOString().slice(0, 10);
    seedDays(env, { "2020-01-01": 9, [today]: 2 });
    let cleanup: Promise<unknown> = Promise.resolve();
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;

    expect(env.DB.diagnosticsUploadDays.has("2020-01-01")).toBe(false);
    expect(env.DB.diagnosticsUploadDays.get(today)).toBe(2);
  });
});
