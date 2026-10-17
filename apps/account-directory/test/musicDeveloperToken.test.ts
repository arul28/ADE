import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMusicDeveloperTokenRequest, type MusicDeveloperTokenEnv } from "../src/musicDeveloperToken";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

const URL_ = "https://directory.test/music/developer-token";
const DAY_S = 24 * 60 * 60;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

async function musicKey(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return exportPKCS8(privateKey);
}

function makeEnv(overrides: Partial<MusicDeveloperTokenEnv> = {}): MusicDeveloperTokenEnv {
  return {
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    MUSICKIT_KEY_ID: "KEY1234567",
    MUSICKIT_TEAM_ID: "TEAM123456",
    ...overrides,
  };
}

async function get(env: MusicDeveloperTokenEnv, method = "GET", signedIn = true): Promise<Response> {
  const headers: Record<string, string> = signedIn ? { authorization: `Bearer ${await mintToken()}` } : {};
  return handleMusicDeveloperTokenRequest(new Request(URL_, { method, headers }), env);
}

async function tokenAt(env: MusicDeveloperTokenEnv, nowMs: number): Promise<string> {
  vi.setSystemTime(nowMs);
  const response = await get(env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("GET /music/developer-token", () => {
  it.each([
    ["a caller who is not signed in", { method: "GET", signedIn: false, key: "valid" }, 401, null],
    ["a method other than GET", { method: "POST", signedIn: true, key: "valid" }, 405, { error: "music_method_not_allowed" }],
    ["a Worker with no MusicKit key", { method: "GET", signedIn: true, key: "none" }, 503, { error: "music_unavailable" }],
    ["a Worker whose key cannot sign", { method: "GET", signedIn: true, key: "broken" }, 503, { error: "music_unavailable" }],
  ] as const)("refuses %s", async (_label, request, status, body) => {
    quiet();
    const broken = "-----BEGIN PRIVATE KEY-----\nTUlJQ0FOT1RBS0VZ\n-----END PRIVATE KEY-----";
    const key = request.key === "valid" ? await musicKey() : request.key === "broken" ? broken : undefined;
    const response = await get(makeEnv({ MUSICKIT_PRIVATE_KEY: key }), request.method, request.signedIn);

    expect(response.status).toBe(status);
    const text = await response.text();
    if (body) expect(JSON.parse(text)).toEqual(body);
    // Never a token, and never the signer's words about the key.
    expect(text).not.toMatch(/eyJ|PRIVATE KEY|TUlJQ0FOT1RBS0VZ|pkcs8/i);
  });

  it("signs an ES256 token for ADE's key and team, and hands the same one out while it has days left", async () => {
    quiet();
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = makeEnv({ MUSICKIT_PRIVATE_KEY: await musicKey() });

    const first = await tokenAt(env, NOW);
    expect(decodeProtectedHeader(first)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeJwt(first)).toEqual({ iss: "TEAM123456", iat: NOW / 1000, exp: NOW / 1000 + 30 * DAY_S });

    // 22 days in, eight are left: still the same token.
    expect(await tokenAt(env, NOW + 22 * DAY_S * 1000)).toBe(first);
    // Under seven days left: a fresh one, so a player that keeps it has days.
    const reissued = await tokenAt(env, NOW + 24 * DAY_S * 1000);
    expect(reissued).not.toBe(first);
    expect(decodeJwt(reissued).exp).toBe(NOW / 1000 + 54 * DAY_S);
  });

  it("signs anew the moment the key is rotated", async () => {
    quiet();
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = await tokenAt(makeEnv({ MUSICKIT_PRIVATE_KEY: await musicKey() }), NOW);
    const after = await tokenAt(makeEnv({ MUSICKIT_PRIVATE_KEY: await musicKey() }), NOW + 1_000);
    expect(after).not.toBe(before);
  });
});
