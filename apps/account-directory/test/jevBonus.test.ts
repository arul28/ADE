import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupJevBonusDays, handleJevBonusRequest, type JevBonusEnv } from "../src/jevBonus";
import { FakeD1Database } from "./fakeD1";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

const URL_ = "https://directory.test/jev/systemone";
const NOW = Date.UTC(2026, 9, 21, 20, 0, 0);
const QUESTION = { state: "fix the login bug", questions: { pick: { type: "noul", instructions: "Is it a bug?" } } };
const ANSWER = { model: "jev-1.14.0", answers: { pick: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 300, output_tokens: 20 } };

function makeEnv(overrides: Partial<JevBonusEnv> = {}): JevBonusEnv & { DB: FakeD1Database } {
  return {
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    DB: new FakeD1Database(),
    JEV_API_KEY: "ts-test-key",
    ...overrides,
  } as JevBonusEnv & { DB: FakeD1Database };
}

async function post(env: JevBonusEnv, args: { body?: unknown; sub?: string; signedIn?: boolean; method?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.signedIn !== false) headers.authorization = `Bearer ${await mintToken({ sub: args.sub ?? "user_1" })}`;
  const method = args.method ?? "POST";
  return handleJevBonusRequest(
    new Request(URL_, { method, headers, body: method === "POST" ? JSON.stringify(args.body ?? QUESTION) : undefined }),
    env,
    NOW,
  );
}

/** Stubs TypeSafe only; the JWKS the bearer check reads still goes to the test's key server. */
function upstream(status = 200, body: unknown = ANSWER, headers: Record<string, string> = {}) {
  const realFetch = globalThis.fetch;
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.typesafe.ai/")) return realFetch(input, init);
    calls.push([url, init]);
    return new Response(JSON.stringify(body), { status, headers });
  });
  return calls;
}

/** TypeSafe answers 200, then the body stream breaks mid-read. */
function upstreamBodyFails() {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.typesafe.ai/")) return realFetch(input, init);
    const body = new ReadableStream({ pull(controller) { controller.error(new Error("connection reset")); } });
    return new Response(body, { status: 200 });
  });
}

/** The account claim succeeds; the fleet-wide claim right after it throws. */
function failSecondClaim(env: JevBonusEnv & { DB: FakeD1Database }) {
  const prepare = env.DB.prepare.bind(env.DB);
  let claims = 0;
  env.DB.prepare = ((sql: string) => {
    if (sql.includes("insert into jev_bonus_days") && ++claims === 2) throw new Error("D1_ERROR: injected failure");
    return prepare(sql);
  }) as typeof env.DB.prepare;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("POST /jev/systemone", () => {
  it.each([
    ["a caller who is not signed in", { signedIn: false }, {}, 401],
    ["a method other than POST", { method: "GET" }, {}, 405],
    ["a Worker with no Jev key", {}, { JEV_API_KEY: undefined }, 503],
    ["a body with no question", { body: { state: "x" } }, {}, 400],
  ] as const)("refuses %s without calling Jev", async (_label, request, env, status) => {
    quiet();
    const calls = upstream();
    const response = await post(makeEnv(env), request);
    expect(response.status).toBe(status);
    expect(calls).toHaveLength(0);
  });

  it("forwards the question with ADE's key and answers with Jev's response", async () => {
    quiet();
    const calls = upstream();
    const response = await post(makeEnv({ JEV_BONUS_DAILY_LIMIT: "5" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ANSWER);
    expect(response.headers.get("x-ade-jev-remaining")).toBe("4");
    const [url, init] = calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer ts-test-key");
    expect(JSON.parse(String(init!.body))).toEqual({ model: "jev-latest", ...QUESTION });
  });

  it("caps each account per UTC day, separately, until midnight", async () => {
    quiet();
    const calls = upstream();
    const env = makeEnv({ JEV_BONUS_DAILY_LIMIT: "2" });
    expect((await post(env)).status).toBe(200);
    expect((await post(env)).status).toBe(200);
    const refused = await post(env);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(4 * 60 * 60));
    expect((await post(env, { sub: "user_2" })).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("stops every account at the fleet ceiling", async () => {
    quiet();
    upstream();
    const env = makeEnv({ JEV_BONUS_DAILY_GLOBAL_LIMIT: "1" });
    expect((await post(env, { sub: "user_1" })).status).toBe(200);
    expect((await post(env, { sub: "user_2" })).status).toBe(429);
    // The refused account's own slot was given back.
    expect(env.DB.jevBonusDays.get("2026-10-21|user_2")).toBe(0);
  });

  it.each([
    ["Jev's own rate limit", () => upstream(429, { error: "nope" }), 429],
    // ADE's spend cap on the key: every brain is told to stop until midnight.
    ["a spent ADE key", () => upstream(402, { error: "nope" }), 429],
    ["a refused ADE key", () => upstream(401, { error: "nope" }), 503],
    ["a Jev outage", () => upstream(500, { error: "nope" }), 502],
    ["a reply body that fails to read", () => upstreamBodyFails(), 502],
    ["a fleet count that cannot be written", (env: JevBonusEnv & { DB: FakeD1Database }) => {
      upstream();
      failSecondClaim(env);
    }, 503],
  ] as const)("gives the slot back on %s", async (_label, arrange, status) => {
    quiet();
    const env = makeEnv({ JEV_BONUS_DAILY_LIMIT: "1" });
    arrange(env);
    expect((await post(env)).status).toBe(status);
    expect(env.DB.jevBonusDays.get("2026-10-21|user_1")).toBe(0);
    expect(env.DB.jevBonusDays.get("2026-10-21|__all__") ?? 0).toBe(0);
  });

  it("sweeps day rows older than a week", async () => {
    const env = makeEnv();
    env.DB.jevBonusDays.set("2026-10-10|user_1", 5);
    env.DB.jevBonusDays.set("2026-10-20|user_1", 5);
    await cleanupJevBonusDays(env, NOW);
    expect([...env.DB.jevBonusDays.keys()]).toEqual(["2026-10-20|user_1"]);
  });
});
