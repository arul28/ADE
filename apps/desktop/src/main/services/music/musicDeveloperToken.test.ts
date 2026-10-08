import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeveloperTokenProvider, MusicTokenUnavailableError } from "./musicDeveloperToken";

/**
 * Where the desktop gets its Apple Music developer token: the account
 * directory (fetch faked), or in a dev build a local key file.
 */
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const dirs: string[] = [];

function workerFetch(lifetimesMs: number[]) {
  let issued = 0;
  return vi.fn(async () => {
    const life = lifetimesMs[Math.min(issued, lifetimesMs.length - 1)]!;
    issued += 1;
    return new Response(JSON.stringify({ token: `worker-token-${issued}`, expiresAt: Date.now() + life }), { status: 200 });
  });
}

function provider(fetchImpl: ReturnType<typeof vi.fn>, overrides: Partial<Parameters<typeof createDeveloperTokenProvider>[0]> = {}) {
  return createDeveloperTokenProvider({
    isPackaged: true,
    env: {},
    directoryBaseUrl: () => "https://directory.test/",
    getAccountToken: async () => "account-bearer",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("music developer token provider", () => {
  it.each([
    // [token lifetime, still cached at, fetched again at]
    ["a 30-day token: refreshed with a day left", 30 * 24 * HOUR, 28 * 24 * HOUR, 29 * 24 * HOUR + 1],
    ["a 2-hour token: refreshed at half its life, not on every call", 2 * HOUR, HOUR - 1, HOUR + 1],
  ])("keeps %s", async (_label, life, cachedAt, refetchAt) => {
    const fetchImpl = workerFetch([life]);
    const tokens = provider(fetchImpl);

    expect((await tokens.get()).token).toBe("worker-token-1");
    vi.setSystemTime(NOW + cachedAt);
    expect((await tokens.get()).token).toBe("worker-token-1");
    vi.setSystemTime(NOW + refetchAt);
    expect((await tokens.get()).token).toBe("worker-token-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]).toEqual(["https://directory.test/music/developer-token", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer account-bearer" }),
    })]);
  });

  it("asks the service once for callers that arrive together", async () => {
    const fetchImpl = workerFetch([30 * 24 * HOUR]);
    const tokens = provider(fetchImpl);

    const [a, b, c] = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set([a.token, b.token, c.token])).toEqual(new Set(["worker-token-1"]));
  });

  it.each([
    ["the service rejects the account", async () => "account-bearer", 401, "signed_out", 1],
    ["no one is signed in to ADE", async () => null, 200, "signed_out", 0],
    ["the service is down", async () => "account-bearer", 503, "service", 1],
  ])("says why there is no token when %s", async (_label, getAccountToken, status, reason, fetches) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    const tokens = provider(fetchImpl, { getAccountToken });

    const error = await tokens.get().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MusicTokenUnavailableError);
    expect((error as MusicTokenUnavailableError).reason).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(fetches);
  });

  it("signs with a local key only in a dev build, never in a packaged one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-musickit-"));
    dirs.push(dir);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = path.join(dir, "AuthKey_ABCDE12345.p8");
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const env = { ADE_MUSICKIT_KEY_PATH: keyPath };

    const packagedFetch = workerFetch([30 * 24 * HOUR]);
    const packaged = await provider(packagedFetch, { isPackaged: true, env }).get();
    expect(packaged).toMatchObject({ source: "worker", token: "worker-token-1" });

    const devFetch = workerFetch([30 * 24 * HOUR]);
    const dev = await provider(devFetch, { isPackaged: false, env }).get();
    expect(dev.source).toBe("local");
    expect(devFetch).not.toHaveBeenCalled();
    const [header, claims, signature] = dev.token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABCDE12345" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "VQ372F39G6", iat: NOW / 1000 });
    expect(crypto.verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});
