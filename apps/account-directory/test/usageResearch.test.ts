import { describe, expect, it, vi } from "vitest";
import {
  cleanupUsageResearch,
  handleUsageResearchRequest,
  isUsageResearchRequest,
  MAX_USAGE_RESEARCH_BODY_BYTES,
  MAX_USAGE_RESEARCH_STORAGE_CEILING_MB,
  MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY,
  MIN_USAGE_RESEARCH_RETENTION_DAYS,
  USAGE_RESEARCH_ROW_OVERHEAD_BYTES,
  USAGE_RESEARCH_SWEEP_BATCH_ROWS,
  type UsageResearchEnv,
} from "../src/usageResearch";
import { quotaAddress } from "../src/sinkUtils";
import worker from "../src/index";
import { FakeD1Database, type StoredUsageResearchRow } from "./fakeD1";

const URL_ = "https://directory.test/usage-research/daily";

/** 2026-09-23 12:00 UTC: twelve hours to the next UTC midnight. */
const FIXED_NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const TODAY = "2026-09-23";
const MB = 1024 * 1024;

type Env = UsageResearchEnv & { DB: FakeD1Database };

function makeEnv(overrides: Partial<UsageResearchEnv> = {}): Env {
  return { DB: new FakeD1Database(), ...overrides } as unknown as Env;
}

/** What a report row counts against the storage ceiling. */
function storedSize(report: unknown): number {
  return new TextEncoder().encode(JSON.stringify(report)).byteLength + USAGE_RESEARCH_ROW_OVERHEAD_BYTES;
}

function installId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

const REPORT = {
  turns: 42,
  providers: { claude: { inputTokens: 1200, cacheReadTokens: 9000 } },
  note: "résumé",
};

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    installId: installId(1),
    day: "2026-09-22",
    appVersion: "1.2.78",
    platform: "darwin",
    arch: "arm64",
    utcOffsetMinutes: -240,
    report: REPORT,
    ...overrides,
  };
}

function omit(key: string): Record<string, unknown> {
  const body = envelope();
  delete body[key];
  return body;
}

let addressCounter = 0;
function nextIp(): string {
  addressCounter += 1;
  return `198.51.100.${addressCounter % 250}`;
}

function post(args: {
  body?: unknown;
  raw?: string;
  contentType?: string | null;
  ip?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const contentType = args.contentType === undefined ? "application/json" : args.contentType;
  return new Request(URL_, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      "cf-connecting-ip": args.ip ?? nextIp(),
      ...(args.headers ?? {}),
    },
    body: args.raw ?? JSON.stringify(args.body ?? envelope()),
  });
}

function send(env: Env, request: Request, now = FIXED_NOW): Promise<Response> {
  return handleUsageResearchRequest(request, env, { now: () => now });
}

function onlyRow(env: Env): StoredUsageResearchRow {
  const rows = [...env.DB.usageResearchRows.values()];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function fleetSpent(env: Env, day = TODAY): number {
  return env.DB.usageResearchDays.get(day) ?? 0;
}

function identitySpent(env: Env): number {
  return [...env.DB.usageResearchIdentityDays.values()].reduce((sum, count) => sum + count, 0);
}

function storedBytes(env: Env): number {
  return [...env.DB.usageResearchRows.values()].reduce((sum, row) => sum + row.bytes, 0);
}

async function captureLines<T>(run: () => Promise<T>): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
  const raw: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    raw.push(String(line));
  });
  try {
    const result = await run();
    return {
      result,
      lines: raw
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.kind === "usage_research_upload"),
    };
  } finally {
    spy.mockRestore();
  }
}

describe("usage research route", () => {
  it("matches only its own path", () => {
    expect(isUsageResearchRequest(new URL(URL_))).toBe(true);
    expect(isUsageResearchRequest(new URL(`${URL_}/`))).toBe(true);
    expect(isUsageResearchRequest(new URL("https://directory.test/usage-research"))).toBe(false);
    expect(isUsageResearchRequest(new URL("https://directory.test/diagnostics/upload"))).toBe(false);
  });

  it("stores a first report with 201 and the report re-serialized compactly", async () => {
    const env = makeEnv();
    // Pretty-printed on the wire; stored compact.
    const response = await send(env, post({ raw: JSON.stringify(envelope(), null, 2) }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, stored: "inserted" });
    const row = onlyRow(env);
    expect(row).toEqual({
      install_id: installId(1),
      day: "2026-09-22",
      schema_version: 1,
      app_version: "1.2.78",
      platform: "darwin",
      arch: "arm64",
      utc_offset_minutes: -240,
      report: JSON.stringify(REPORT),
      bytes: storedSize(REPORT),
      received_at: FIXED_NOW,
      updated_at: FIXED_NOW,
    });
    // UTF-8 bytes, not UTF-16 code units: each "é" is two of them. Plus the
    // fixed per-row overhead the storage ceiling counts.
    expect(row.bytes).toBe(JSON.stringify(REPORT).length + 2 + USAGE_RESEARCH_ROW_OVERHEAD_BYTES);
    expect(env.DB.usageResearchTotalBytes).toBe(row.bytes);
    expect(fleetSpent(env)).toBe(1);
    expect(identitySpent(env)).toBe(1);
  });

  it("replaces a re-send with 200, keeping the first arrival time", async () => {
    const env = makeEnv();
    await send(env, post());
    const changed = { ...REPORT, turns: 43, extra: "x".repeat(500) };
    const response = await send(env, post({ body: envelope({ report: changed, appVersion: "1.2.79" }) }), FIXED_NOW + 60_000);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stored: "replaced" });
    const row = onlyRow(env);
    expect(row.report).toBe(JSON.stringify(changed));
    expect(row.app_version).toBe("1.2.79");
    expect(row.received_at).toBe(FIXED_NOW);
    expect(row.updated_at).toBe(FIXED_NOW + 60_000);
    // The running total moved by the difference, not by the whole new report.
    expect(env.DB.usageResearchTotalBytes).toBe(row.bytes);
  });

  it("does not count an identical re-send against any budget", async () => {
    const env = makeEnv();
    await send(env, post());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { result, lines } = await captureLines(() => send(env, post(), FIXED_NOW + attempt));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ ok: true, stored: "replaced" });
      expect(lines).toEqual([expect.objectContaining({ outcome: "unchanged", status: 200 })]);
    }
    expect(fleetSpent(env)).toBe(1);
    expect(identitySpent(env)).toBe(1);
    expect(onlyRow(env).updated_at).toBe(FIXED_NOW);

    // A CHANGED re-send is a write and is counted.
    const changed = await send(env, post({ body: envelope({ utcOffsetMinutes: -300 }) }));
    expect(changed.status).toBe(200);
    expect(fleetSpent(env)).toBe(2);
    expect(identitySpent(env)).toBe(2);
  });

  it("rejects every malformed envelope with 400 and stores nothing", async () => {
    const cases: Array<[string, string]> = [
      ["not json", "{nope"],
      ["an array", JSON.stringify([envelope()])],
      ["schemaVersion 2", JSON.stringify(envelope({ schemaVersion: 2 }))],
      ["schemaVersion as a string", JSON.stringify(envelope({ schemaVersion: "1" }))],
      ["missing schemaVersion", JSON.stringify(omit("schemaVersion"))],
      ["uppercase installId", JSON.stringify(envelope({ installId: installId(1).toUpperCase().replace(/0/g, "A") }))],
      ["short installId", JSON.stringify(envelope({ installId: "abc" }))],
      ["missing installId", JSON.stringify(omit("installId"))],
      ["impossible day", JSON.stringify(envelope({ day: "2026-02-30" }))],
      ["unpadded day", JSON.stringify(envelope({ day: "2026-9-22" }))],
      ["timestamp day", JSON.stringify(envelope({ day: "2026-09-22T00:00:00Z" }))],
      ["empty appVersion", JSON.stringify(envelope({ appVersion: "" }))],
      ["long appVersion", JSON.stringify(envelope({ appVersion: "1".repeat(41) }))],
      ["control char appVersion", JSON.stringify(envelope({ appVersion: "1.2\n" }))],
      ["missing appVersion", JSON.stringify(omit("appVersion"))],
      ["long platform", JSON.stringify(envelope({ platform: "p".repeat(17) }))],
      ["numeric arch", JSON.stringify(envelope({ arch: 64 }))],
      ["offset past +14h", JSON.stringify(envelope({ utcOffsetMinutes: 841 }))],
      ["fractional offset", JSON.stringify(envelope({ utcOffsetMinutes: 330.5 }))],
      ["string offset", JSON.stringify(envelope({ utcOffsetMinutes: "0" }))],
      ["array report", JSON.stringify(envelope({ report: [1, 2] }))],
      ["null report", JSON.stringify(envelope({ report: null }))],
      ["string report", JSON.stringify(envelope({ report: "{}" }))],
      ["missing report", JSON.stringify(omit("report"))],
      ["unknown top-level field", JSON.stringify(envelope({ userId: "user_1" }))],
    ];
    const env = makeEnv();
    for (const [label, raw] of cases) {
      const response = await send(env, post({ raw }));
      expect({ label, status: response.status }).toEqual({ label, status: 400 });
      expect(await response.json()).toEqual({ error: "usage_research_invalid" });
    }
    expect(env.DB.usageResearchRows.size).toBe(0);
    expect(fleetSpent(env)).toBe(0);
    expect(identitySpent(env)).toBe(0);
    expect(env.DB.usageResearchTotalBytes).toBe(0);
  });

  it("accepts any local day on Earth from eight days back to today, and nothing outside it", async () => {
    // At 12:00 UTC the latest local date anywhere (UTC+14) is tomorrow, and the
    // earliest local "today" (UTC−12) is today, so the window is [today−8, today+1].
    const env = makeEnv({ USAGE_RESEARCH_DAILY_GLOBAL_LIMIT: "100" });
    const status = async (day: string, n: number) =>
      (await send(env, post({ body: envelope({ day, installId: installId(n) }) }))).status;

    expect(await status("2026-09-24", 1)).toBe(201);
    expect(await status("2026-09-15", 2)).toBe(201);
    expect(await status("2026-09-25", 3)).toBe(400);
    expect(await status("2026-09-14", 4)).toBe(400);

    // Just after midnight UTC, UTC−12 is still on the previous date, so the
    // window reaches one day further back.
    const earlyNow = Date.UTC(2026, 8, 23, 1, 0, 0);
    const early = await send(env, post({ body: envelope({ day: "2026-09-14", installId: installId(5) }) }), earlyNow);
    expect(early.status).toBe(201);
  });

  it("refuses a body over 32 KB with 413 before parsing it", async () => {
    const env = makeEnv();
    const padded = envelope({ report: { pad: "x".repeat(MAX_USAGE_RESEARCH_BODY_BYTES) } });
    const response = await send(env, post({ body: padded }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "usage_research_too_large" });
    expect(env.DB.usageResearchRows.size).toBe(0);
  });

  it("counts a streamed body instead of trusting content-length", async () => {
    const env = makeEnv();
    const chunk = new TextEncoder().encode("y".repeat(8 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await send(env, request);
    expect(response.status).toBe(413);
  });

  it("refuses a report that re-serializes past the cap even when the body fit", async () => {
    // `1e20` is four characters on the wire and twenty-one once re-serialized.
    const env = makeEnv();
    const body = JSON.stringify(envelope({ report: { n: Array.from({ length: 6_000 }, () => 1e20) } }))
      .replace(/100000000000000000000/g, "1e20");
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_USAGE_RESEARCH_BODY_BYTES);
    const response = await send(env, post({ raw: body }));
    expect(response.status).toBe(413);
    expect(env.DB.usageResearchRows.size).toBe(0);
  });

  it("answers 415 to anything but JSON and 405 to anything but POST", async () => {
    const env = makeEnv();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const response = await send(env, post({ contentType }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "usage_research_unsupported_media_type" });
    }
    const withCharset = await send(env, post({ contentType: "Application/JSON; charset=utf-8" }));
    expect(withCharset.status).toBe(201);

    for (const method of ["GET", "PUT", "OPTIONS"]) {
      const response = await send(env, new Request(URL_, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      // No CORS on this route: a browser page must not be able to write here.
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("allows 20 writes per identity per UTC day, then 429 without spending fleet budget", async () => {
    const env = makeEnv();
    const ip = "203.0.113.7";
    for (let n = 0; n < MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY; n += 1) {
      const response = await send(env, post({ ip, body: envelope({ installId: installId(100 + n) }) }));
      expect(response.status).toBe(201);
    }
    const refused = await send(env, post({ ip, body: envelope({ installId: installId(999) }) }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "usage_research_identity_limit" });
    expect(refused.headers.get("retry-after")).toBe("43200");
    expect(fleetSpent(env)).toBe(MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY);
    expect(env.DB.usageResearchRows.size).toBe(MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY);

    // A different address is a different identity.
    const other = await send(env, post({ ip: "203.0.113.8", body: envelope({ installId: installId(999) }) }));
    expect(other.status).toBe(201);

    // The next UTC day is a fresh quota.
    const tomorrow = await send(
      env,
      post({ ip, body: envelope({ installId: installId(998), day: "2026-09-23" }) }),
      FIXED_NOW + 86_400_000,
    );
    expect(tomorrow.status).toBe(201);
  });

  it("keys the quota on the address alone and stores nothing about the caller", async () => {
    const env = makeEnv();
    const ip = "203.0.113.20";
    for (let n = 0; n < MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY; n += 1) {
      await send(env, post({ ip, body: envelope({ installId: installId(200 + n) }) }));
    }
    // An account token buys no quota of its own: the route never reads it.
    const withToken = await send(env, post({
      ip,
      headers: { authorization: "Bearer user_secret_42" },
      body: envelope({ installId: installId(299) }),
    }));
    expect(withToken.status).toBe(429);
    expect(await withToken.json()).toEqual({ error: "usage_research_identity_limit" });

    const everything = JSON.stringify({
      rows: [...env.DB.usageResearchRows.values()],
      identities: [...env.DB.usageResearchIdentityDays.keys()],
      days: [...env.DB.usageResearchDays.keys()],
    });
    expect(everything).not.toContain("user_secret_42");
    expect(everything).not.toContain(ip);
    for (const key of env.DB.usageResearchIdentityDays.keys()) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}\|[0-9a-f]{64}$/);
    }
  });

  it("counts every IPv6 address in one /64 as one caller", async () => {
    const env = makeEnv();
    const prefix = "2001:db8:aa:bb";
    for (let n = 0; n < MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY; n += 1) {
      const response = await send(env, post({ ip: `${prefix}::${(n + 1).toString(16)}`, body: envelope({ installId: installId(500 + n) }) }));
      expect(response.status).toBe(201);
    }
    // A fresh interface id inside the same /64 is the same caller.
    const sameNetwork = await send(env, post({ ip: `${prefix.toUpperCase()}:1234:5678:9abc:def0`, body: envelope({ installId: installId(599) }) }));
    expect(sameNetwork.status).toBe(429);
    expect(await sameNetwork.json()).toEqual({ error: "usage_research_identity_limit" });
    // The next /64 is someone else.
    const nextNetwork = await send(env, post({ ip: "2001:db8:aa:bc::1", body: envelope({ installId: installId(599) }) }));
    expect(nextNetwork.status).toBe(201);
    // IPv4 is unchanged: two addresses are two callers.
    expect(env.DB.usageResearchIdentityDays.size).toBe(2);
  });

  it("stops the whole fleet at the daily limit without touching the caller's quota", async () => {
    const env = makeEnv({ USAGE_RESEARCH_DAILY_GLOBAL_LIMIT: "3" });
    for (let n = 0; n < 3; n += 1) {
      expect((await send(env, post({ body: envelope({ installId: installId(300 + n) }) }))).status).toBe(201);
    }
    const writesBefore = env.DB.ranStatements.length;
    const refused = await send(env, post({ ip: "192.0.2.50", body: envelope({ installId: installId(303) }) }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "usage_research_daily_limit" });
    expect(refused.headers.get("retry-after")).toBe("43200");
    expect(fleetSpent(env)).toBe(3);
    // A spent fleet answers from a read: the refused caller's quota was never
    // touched, and the refusal wrote nothing at all.
    expect(identitySpent(env)).toBe(3);
    expect(env.DB.usageResearchIdentityDays.size).toBe(3);
    expect(env.DB.ranStatements.slice(writesBefore)).toEqual([]);
    expect(env.DB.usageResearchRows.size).toBe(3);

    // An identical re-send of a stored report still succeeds at the cap: it writes nothing.
    const resend = await send(env, post({ body: envelope({ installId: installId(300) }) }));
    expect(resend.status).toBe(200);
  });

  it("treats 0 as a kill switch that writes nothing, and an unreadable limit as the default", async () => {
    const stopped = makeEnv({ USAGE_RESEARCH_DAILY_GLOBAL_LIMIT: "0" });
    const refused = await send(stopped, post());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "usage_research_daily_limit" });
    expect(stopped.DB.usageResearchRows.size).toBe(0);
    expect(stopped.DB.usageResearchDays.size).toBe(0);
    expect(stopped.DB.usageResearchIdentityDays.size).toBe(0);
    // Not a claim-then-refund: no statement ran against the database at all.
    expect(stopped.DB.ranStatements).toEqual([]);

    for (const limit of ["lots", "", "-5"]) {
      const env = makeEnv({ USAGE_RESEARCH_DAILY_GLOBAL_LIMIT: limit });
      expect((await send(env, post())).status).toBe(201);
    }
  });

  it("refuses growth past the storage ceiling but always allows a shrinking replace", async () => {
    const env = makeEnv({ USAGE_RESEARCH_STORAGE_CEILING_MB: "1" });
    await send(env, post());
    const firstBytes = onlyRow(env).bytes;
    // Pretend the table is full to within a few bytes of 1 MB.
    env.DB.usageResearchTotalBytes = MB - 10;

    const refused = await send(env, post({ body: envelope({ installId: installId(2) }) }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "usage_research_storage_full" });
    expect(refused.headers.get("retry-after")).toBe("43200");
    expect(env.DB.usageResearchRows.size).toBe(1);
    // Both earlier claims were refunded.
    expect(fleetSpent(env)).toBe(1);
    expect(identitySpent(env)).toBe(1);
    expect(env.DB.usageResearchTotalBytes).toBe(MB - 10);

    const shrink = await send(env, post({ body: envelope({ report: {} }) }));
    expect(shrink.status).toBe(200);
    expect(onlyRow(env).report).toBe("{}");
    expect(env.DB.usageResearchTotalBytes).toBe(MB - 10 - (firstBytes - storedSize({})));
  });

  it("clamps the storage ceiling so no var can point it past the database", async () => {
    const env = makeEnv({ USAGE_RESEARCH_STORAGE_CEILING_MB: "999999" });
    env.DB.usageResearchTotalBytes = MAX_USAGE_RESEARCH_STORAGE_CEILING_MB * MB - 10;
    const refused = await send(env, post());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "usage_research_storage_full" });

    const stopped = makeEnv({ USAGE_RESEARCH_STORAGE_CEILING_MB: "0" });
    expect((await send(stopped, post())).status).toBe(429);
  });

  it("answers 503 when the database binding is missing", async () => {
    const env = makeEnv({ DB: undefined });
    const response = await send(env, post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "usage_research_unavailable" });
  });

  it("fails closed when a step cannot run, and gives back every claim it took", async () => {
    for (const failing of [
      /from usage_research_daily/,
      /from usage_research_days/,
      /insert into usage_research_identity_days/,
      /insert into usage_research_days/,
      /insert into usage_research_totals/,
    ]) {
      const env = makeEnv();
      env.DB.failingStatements = failing;
      const response = await send(env, post());
      expect({ failing: String(failing), status: response.status }).toEqual({ failing: String(failing), status: 503 });
      expect(env.DB.usageResearchRows.size).toBe(0);
      expect(fleetSpent(env)).toBe(0);
      expect(identitySpent(env)).toBe(0);
      expect(env.DB.usageResearchTotalBytes).toBe(0);
    }

    const env = makeEnv();
    env.DB.failingStatements = /insert into usage_research_daily/;
    const response = await send(env, post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "usage_research_unavailable" });
    expect(fleetSpent(env)).toBe(0);
    expect(identitySpent(env)).toBe(0);
    expect(env.DB.usageResearchTotalBytes).toBe(0);

    // The replace path's write failing gives its claims back too.
    const replacing = makeEnv();
    await send(replacing, post());
    const before = replacing.DB.usageResearchTotalBytes;
    replacing.DB.failingStatements = /update usage_research_daily/;
    const failedReplace = await send(replacing, post({ body: envelope({ report: { turns: 1 } }) }));
    expect(failedReplace.status).toBe(503);
    expect(fleetSpent(replacing)).toBe(1);
    expect(identitySpent(replacing)).toBe(1);
    expect(replacing.DB.usageResearchTotalBytes).toBe(before);
    expect(onlyRow(replacing).report).toBe(JSON.stringify(REPORT));
  });

  it("lets only one of two racing first sends write, and keeps the byte total exact", async () => {
    const env = makeEnv();
    // Both requests read "no row" before either writes.
    env.DB.synchronizeUsageResearchReads(2);
    const small = { turns: 1 };
    const large = { turns: 2, pad: "x".repeat(4_000) };
    const [first, second] = await Promise.all([
      send(env, post({ body: envelope({ report: small }) })),
      send(env, post({ body: envelope({ report: large }) })),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 503]);
    const loser = first.status === 503 ? first : second;
    expect(await loser.json()).toEqual({ error: "usage_research_unavailable" });

    const row = onlyRow(env);
    // The winner's row is intact, and the loser's claims all came back.
    expect(env.DB.usageResearchTotalBytes).toBe(row.bytes);
    expect(env.DB.usageResearchTotalBytes).toBe(storedBytes(env));
    expect(fleetSpent(env)).toBe(1);
    expect(identitySpent(env)).toBe(1);
  });

  it("lets only one of two racing replaces write, and keeps the byte total exact", async () => {
    const env = makeEnv();
    await send(env, post());
    env.DB.synchronizeUsageResearchReads(2);
    const [first, second] = await Promise.all([
      send(env, post({ body: envelope({ report: { turns: 7 } }) })),
      send(env, post({ body: envelope({ report: { turns: 8, pad: "y".repeat(3_000) } }) })),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 503]);
    expect(env.DB.usageResearchTotalBytes).toBe(onlyRow(env).bytes);
    expect(fleetSpent(env)).toBe(2);
    expect(identitySpent(env)).toBe(2);
  });

  it("answers 400 with one log line when the body stream breaks mid-read", async () => {
    const env = makeEnv();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("{\"schemaVersion\":"));
          return;
        }
        controller.error(new Error("client went away"));
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const { result, lines } = await captureLines(() => send(env, request));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "usage_research_invalid" });
    expect(lines).toEqual([expect.objectContaining({ outcome: "rejected", status: 400, reason: "body_unreadable" })]);
    expect(env.DB.ranStatements).toEqual([]);
  });

  it("logs one line per request with outcome and bytes, never the report", async () => {
    const env = makeEnv();
    const secret = "prompt text that must never reach a log";
    const { lines } = await captureLines(async () => {
      await send(env, post({ body: envelope({ report: { secret } }) }));
      await send(env, post({ body: envelope({ report: { secret } }) }));
      await send(env, post({ body: envelope({ report: { secret, more: 1 } }) }));
      await send(env, post({ body: envelope({ day: "nope", report: { secret } }) }));
      await send(env, post({ contentType: "text/plain" }));
    });
    expect(lines.map((line) => [line.outcome, line.status, line.reason])).toEqual([
      ["inserted", 201, undefined],
      ["unchanged", 200, undefined],
      ["replaced", 200, undefined],
      ["rejected", 400, "day"],
      ["rejected", 415, "unsupported_media_type"],
    ]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ["bytes", "kind", "outcome", "status", "svc", "ts", ...(line.reason ? ["reason"] : [])].sort(),
      );
      expect(typeof line.bytes).toBe("number");
    }
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain(installId(1));
  });

  it("is reachable through the Worker entry point", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      post({ body: envelope({ day: new Date().toISOString().slice(0, 10) }) }),
      env as never,
    );
    expect(response.status).toBe(201);
    expect(env.DB.usageResearchRows.size).toBe(1);
  });
});

describe("usage research sweep", () => {
  function dayOffset(days: number): string {
    return new Date(FIXED_NOW + days * 86_400_000).toISOString().slice(0, 10);
  }

  function seedReport(env: Env, n: number, day: string, bytes = 100): void {
    env.DB.usageResearchRows.set(`${installId(n)}|${day}`, {
      install_id: installId(n),
      day,
      schema_version: 1,
      app_version: "1.2.78",
      platform: "darwin",
      arch: "arm64",
      utc_offset_minutes: 0,
      report: "{}",
      bytes,
      received_at: 0,
      updated_at: 0,
    });
    env.DB.usageResearchTotalBytes = (env.DB.usageResearchTotalBytes ?? 0) + bytes;
  }

  it("deletes only reports older than the retention window, and keeps the byte total exact", async () => {
    const env = makeEnv();
    seedReport(env, 1, dayOffset(-400), 111);
    seedReport(env, 2, dayOffset(-181), 222);
    seedReport(env, 3, dayOffset(-180), 333);
    seedReport(env, 4, dayOffset(-10), 444);
    seedReport(env, 5, TODAY, 555);

    const result = await cleanupUsageResearch(env, FIXED_NOW);

    expect(result.reports).toBe(2);
    // `day < cutoff`: the cutoff day itself is kept.
    expect([...env.DB.usageResearchRows.values()].map((row) => row.day).sort()).toEqual(
      [dayOffset(-180), dayOffset(-10), TODAY].sort(),
    );
    expect(env.DB.usageResearchTotalBytes).toBe(333 + 444 + 555);
    expect(env.DB.usageResearchTotalBytes).toBe(storedBytes(env));
  });

  it("drains a backlog in bounded batches, oldest first", async () => {
    const env = makeEnv();
    for (let n = 0; n < 1_200; n += 1) seedReport(env, n, n < 1_100 ? dayOffset(-300 + (n % 50)) : TODAY, 10 + (n % 7));

    const first = await cleanupUsageResearch(env, FIXED_NOW);
    expect(first.reports).toBe(USAGE_RESEARCH_SWEEP_BATCH_ROWS);
    expect(env.DB.usageResearchTotalBytes).toBe(storedBytes(env));
    const remainingOld = [...env.DB.usageResearchRows.values()].filter((row) => row.day < TODAY);
    // 22 rows per backlog day, so 500 rows is the 22 oldest days plus part of
    // the 23rd. Oldest went first: what is left is the backlog's newest end.
    expect(remainingOld.every((row) => row.day >= dayOffset(-300 + 22))).toBe(true);
    expect(remainingOld.some((row) => row.day === dayOffset(-300 + 49))).toBe(true);

    await cleanupUsageResearch(env, FIXED_NOW);
    const third = await cleanupUsageResearch(env, FIXED_NOW);
    expect(third.reports).toBe(100);
    expect((await cleanupUsageResearch(env, FIXED_NOW)).reports).toBe(0);
    expect(env.DB.usageResearchRows.size).toBe(100);
    expect(env.DB.usageResearchTotalBytes).toBe(storedBytes(env));
    // The four statements always travel as one transaction.
    expect(env.DB.batchedStatementCounts.every((count) => count === 4)).toBe(true);
  });

  it("honors the retention var, never below the accepted window", async () => {
    const seeded = (): Env => {
      const env = makeEnv();
      for (const [n, offset] of [[1, -40], [2, -31], [3, -30], [4, -10], [5, -9], [6, -8]] as const) {
        seedReport(env, n, dayOffset(offset));
      }
      return env;
    };

    const thirty = seeded();
    thirty.USAGE_RESEARCH_RETENTION_DAYS = "30";
    expect((await cleanupUsageResearch(thirty, FIXED_NOW)).reports).toBe(2);

    // 0 is "as short as is safe": the accepted window is today−8 (today−9 from
    // UTC−12), so nothing inside it may be swept.
    const zero = seeded();
    zero.USAGE_RESEARCH_RETENTION_DAYS = "0";
    expect((await cleanupUsageResearch(zero, FIXED_NOW)).reports).toBe(4);
    expect([...zero.DB.usageResearchRows.values()].map((row) => row.day).sort()).toEqual(
      [dayOffset(-MIN_USAGE_RESEARCH_RETENTION_DAYS), dayOffset(-8)],
    );

    const garbage = seeded();
    garbage.USAGE_RESEARCH_RETENTION_DAYS = "forever";
    expect((await cleanupUsageResearch(garbage, FIXED_NOW)).reports).toBe(0);
  });

  it("prunes fleet-budget rows after a week and identity rows once their day is over", async () => {
    const env = makeEnv();
    for (const offset of [-30, -8, -7, -1, 0]) env.DB.usageResearchDays.set(dayOffset(offset), 5);
    env.DB.usageResearchIdentityDays.set(`${dayOffset(-2)}|${"a".repeat(64)}`, 3);
    env.DB.usageResearchIdentityDays.set(`${dayOffset(-1)}|${"b".repeat(64)}`, 3);
    env.DB.usageResearchIdentityDays.set(`${TODAY}|${"c".repeat(64)}`, 3);

    const result = await cleanupUsageResearch(env, FIXED_NOW);

    expect(result.budgetDays).toBe(2);
    expect([...env.DB.usageResearchDays.keys()].sort()).toEqual([dayOffset(-7), dayOffset(-1), TODAY]);
    expect(result.identityDays).toBe(2);
    expect([...env.DB.usageResearchIdentityDays.keys()]).toEqual([`${TODAY}|${"c".repeat(64)}`]);
  });

  it("does nothing without a database binding", async () => {
    expect(await cleanupUsageResearch({ DB: undefined }, FIXED_NOW)).toEqual({
      reports: 0,
      budgetDays: 0,
      identityDays: 0,
    });
  });

  it("keeps sweeping when another cron cleanup throws", async () => {
    const env = makeEnv();
    const today = new Date().toISOString().slice(0, 10);
    seedReport(env, 1, "2020-01-01");
    seedReport(env, 2, today);
    env.DB.failingStatements = /diagnostics_upload_days/;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      let cleanup: Promise<unknown> = Promise.resolve();
      await worker.scheduled(
        {} as ScheduledEvent,
        env as never,
        { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
      );
      // The tick settles instead of rejecting, and the other sweeps still ran.
      await expect(cleanup).resolves.toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect([...env.DB.usageResearchRows.values()].map((row) => row.day)).toEqual([today]);
    const failures = errors
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.kind === "scheduled_cleanup_failed");
    expect(failures).toEqual([expect.objectContaining({ task: "diagnostics_upload_days" })]);
  });

  it("runs from the Worker's scheduled handler", async () => {
    const env = makeEnv();
    const today = new Date().toISOString().slice(0, 10);
    seedReport(env, 1, "2020-01-01");
    seedReport(env, 2, today);
    let cleanup: Promise<unknown> = Promise.resolve();
    await worker.scheduled(
      {} as ScheduledEvent,
      env as never,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;
    expect([...env.DB.usageResearchRows.values()].map((row) => row.day)).toEqual([today]);
  });
});

describe("quota address", () => {
  it("cuts an IPv6 address to its /64 and leaves anything else alone", () => {
    expect(quotaAddress("198.51.100.7")).toBe("198.51.100.7");
    expect(quotaAddress("unknown-client")).toBe("unknown-client");
    expect(quotaAddress("2001:db8:aa:bb::1")).toBe("2001:db8:aa:bb::/64");
    expect(quotaAddress("2001:0DB8:00AA:00BB:1:2:3:4")).toBe("2001:db8:aa:bb::/64");
    expect(quotaAddress("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(quotaAddress("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(quotaAddress("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    // Not addresses: returned as given, so they stay their own bucket.
    for (const junk of ["1::2::3", "2001:db8:gg::1", "1:2:3:4:5:6:7:8:9", "1:2:3"]) {
      expect(quotaAddress(junk)).toBe(junk);
    }
  });
});
