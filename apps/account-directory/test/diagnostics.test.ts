import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleDiagnosticsRequest,
  isDiagnosticsRequest,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  MAX_DIAGNOSTIC_UPLOADS_PER_DAY,
  type DiagnosticsEnv,
} from "../src/diagnostics";
import worker from "../src/index";
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

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
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

function makeEnv(
  overrides: Partial<DiagnosticsEnv> = {},
): DiagnosticsEnv & { DIAGNOSTICS: FakeR2Bucket } {
  return {
    DB: {} as unknown as D1Database,
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    DIAGNOSTICS: new FakeR2Bucket(),
    ...overrides,
  } as unknown as DiagnosticsEnv & { DIAGNOSTICS: FakeR2Bucket };
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
      );
      expect(accepted.status).toBe(200);
    }
    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("86400");
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);

    // A different caller is unaffected, and the durable half of the limit is a
    // prefix listing scoped to that caller's day.
    const other = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip: "198.51.100.8" }),
      env,
    );
    expect(other.status).toBe(200);
    expect(env.DIAGNOSTICS.listCalls.at(-1)?.prefix).toMatch(/^reports\/\d{4}-\d{2}-\d{2}\/anon-/);
    expect(env.DIAGNOSTICS.listCalls.at(-1)?.limit).toBe(MAX_DIAGNOSTIC_UPLOADS_PER_DAY + 1);
  });

  it("enforces the day quota from stored objects when this isolate has no memory of them", async () => {
    // The isolate counter is only a fast path; a recycled isolate must still
    // refuse a caller who already spent the day's quota, which is what the R2
    // prefix listing is for.
    const env = makeEnv();
    const ip = "198.51.100.30";
    const identity = `anon-${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
    const prefix = `reports/${new Date().toISOString().slice(0, 10)}/${identity}/`;
    for (let index = 0; index < MAX_DIAGNOSTIC_UPLOADS_PER_DAY; index += 1) {
      await env.DIAGNOSTICS.put(`${prefix}seeded-${index}.md`, "stored by an earlier isolate");
    }

    const refused = await handleDiagnosticsRequest(
      uploadRequest({ body: JSON.stringify({ report: REPORT }), ip }),
      env,
    );
    expect(refused.status).toBe(429);
    expect(env.DIAGNOSTICS.keys()).toHaveLength(MAX_DIAGNOSTIC_UPLOADS_PER_DAY);
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
