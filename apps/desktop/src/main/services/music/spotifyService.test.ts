import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MusicState } from "../../../shared/types/music";
import { startSpotifySignIn } from "./spotifyAuth";
import { createSpotifyService, SPOTIFY_CREDENTIAL_KEY } from "./spotifyService";

/**
 * Spotify's sign-in and Connect remote, with Spotify's HTTP faked at `fetch`
 * and the credential file in memory. The loopback callback is real HTTP.
 * These pin the races no UI can reach: late answers after a sign-out or after
 * the tab closed, and the one-shot callback.
 */

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokenBody = { access_token: "access", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh", scope: "" };

const playing = (progressMs: number) => ({
  device: { id: "d1", name: "Mac", type: "Computer", is_active: true, volume_percent: 50, supports_volume: true },
  is_playing: true,
  progress_ms: progressMs,
  shuffle_state: false,
  repeat_state: "off",
  item: { uri: "spotify:track:abc", name: "Song", duration_ms: 200_000, artists: [{ name: "Artist" }], album: { name: "Album", images: [] } },
});

function harness(options: { stored?: boolean; routes: (url: string, init?: RequestInit) => Promise<Response> | Response }) {
  const files = new Map<string, string>();
  if (options.stored) files.set(SPOTIFY_CREDENTIAL_KEY, JSON.stringify({ clientId: CLIENT_ID, refreshToken: "refresh" }));
  const credentials = {
    get: vi.fn(async (key: string) => files.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      files.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      files.delete(key);
    }),
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => options.routes(String(input), init)) as unknown as typeof fetch;
  const states: MusicState[] = [];
  const service = createSpotifyService({
    credentials,
    clientId: () => CLIENT_ID,
    openExternal: async () => {},
    broadcast: (state) => states.push(state),
    fetchImpl,
  });
  return { service, files, credentials, fetchImpl, states };
}


afterEach(() => {
  vi.useRealTimers();
});

describe("spotify service races", () => {
  it("a poll that lands after the tab closed does not bring the song back", async () => {
    vi.useFakeTimers();
    const player = deferred<Response>();
    const { service } = harness({
      stored: true,
      routes: (url) => (url.includes("/api/token") ? json(tokenBody) : url.includes("/me/player") ? player.promise : json({})),
    });
    await service.warm();
    await service.unloadPlayer();
    player.resolve(json(playing(10_000)));
    // Fake time: lets the late answer and any push it would cause run out.
    await vi.advanceTimersByTimeAsync(1_000);
    const state = await service.getState();
    expect(state.playback.nowPlaying).toBeNull();
    expect(state.host.status).toBe("stopped");
  });

  it("a session read still in flight when the user disconnects does not sign Spotify back in", async () => {
    const read = deferred<string | null>();
    const { service, credentials } = harness({ routes: () => json({}) });
    credentials.get.mockImplementationOnce(() => read.promise);
    const before = service.getState();
    await service.disconnect();
    read.resolve(JSON.stringify({ clientId: CLIENT_ID, refreshToken: "refresh" }));
    await before;
    expect((await service.getState()).authorized).toBe(false);
  });

  it("a Connect that finishes after a disconnect stays signed out and stores nothing", async () => {
    const me = deferred<Response>();
    const meAsked = deferred<void>();
    const files = new Map<string, string>();
    // The browser side of sign-in: ADE hands over the consent URL, the test follows it to the callback.
    const opened = deferred<string>();
    const svc = createSpotifyService({
      credentials: { get: async (k) => files.get(k) ?? null, set: async (k, v) => void files.set(k, v), delete: async (k) => void files.delete(k) },
      clientId: () => CLIENT_ID,
      openExternal: async (url) => opened.resolve(url),
      broadcast: () => {},
      fetchImpl: ((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/token")) return Promise.resolve(json(tokenBody));
        if (url.endsWith("/v1/me")) {
          meAsked.resolve();
          return me.promise;
        }
        return Promise.resolve(json({}));
      }) as typeof fetch,
    });
    const connecting = svc.connect();
    const consent = new URL(await opened.promise);
    const callback = new URL(consent.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "c");
    callback.searchParams.set("state", consent.searchParams.get("state")!);
    const page = await realFetch(callback);
    expect(page.status).toBe(200);
    // Connect is waiting on /v1/me: the user disconnects now.
    await meAsked.promise;
    await svc.disconnect();
    me.resolve(json({ id: "u" }));
    const result = await connecting;
    expect(result.ok).toBe(false);
    expect((await svc.getState()).authorized).toBe(false);
    expect(files.has(SPOTIFY_CREDENTIAL_KEY)).toBe(false);
  });

  it("a command that does not move the song keeps the position advancing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { service } = harness({
      stored: true,
      routes: (url) => (url.includes("/api/token") ? json(tokenBody) : url.includes("/me/player?") ? json(playing(10_000)) : new Response(null, { status: 204 })),
    });
    await service.warm();
    // The first poll lands (fake time; the next poll is 15 s away).
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(1_005_000);
    expect(await service.command({ type: "volume", value: 0.4 })).toEqual({ ok: true });
    const { playback } = await service.getState();
    expect(playback.position).toBeCloseTo(15, 0);
    service.dispose();
  });
});

describe("spotify sign-in callback", () => {
  it("ignores a stale state and exchanges the code once, even when the callback arrives twice", async () => {
    const exchange = deferred<Response>();
    let exchanges = 0;
    let verifier = "";
    const exchangeAsked = deferred<void>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/token")) {
        exchanges += 1;
        exchangeAsked.resolve();
        verifier = new URLSearchParams(String(init?.body)).get("code_verifier") ?? "";
      }
      return exchange.promise;
    }) as typeof fetch;
    const signIn = await startSpotifySignIn({ clientId: CLIENT_ID, fetchImpl });
    const consent = new URL(signIn.authorizeUrl);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(consent.searchParams.get("redirect_uri")!);
    expect(callback.hostname).toBe("127.0.0.1");

    const stale = new URL(callback);
    stale.searchParams.set("code", "x");
    stale.searchParams.set("state", "not-the-state");
    expect((await realFetch(stale)).status).toBe(400);

    const good = new URL(callback);
    good.searchParams.set("code", "c");
    good.searchParams.set("state", consent.searchParams.get("state")!);
    // The page waits for the exchange; a reload while it waits is refused.
    const first = realFetch(good);
    await exchangeAsked.promise;
    expect((await realFetch(good)).status).toBe(404);
    exchange.resolve(json(tokenBody));
    expect((await first).status).toBe(200);
    await expect(signIn.result).resolves.toMatchObject({ refreshToken: "refresh" });
    expect(exchanges).toBe(1);
    // Spotify accepts the code only when the verifier hashes to the challenge sent first.
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(consent.searchParams.get("code_challenge")).toBe(challenge);
  });
});

describe("spotify tokens and polling budget", () => {
  it("a Disconnect whose saved sign-in can't be deleted says so, and is signed out meanwhile", async () => {
    const { service, credentials } = harness({ stored: true, routes: () => json({}) });
    await service.getState();
    credentials.delete.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(service.disconnect()).rejects.toThrow(/couldn't delete the saved sign-in/);
    expect((await service.getState()).authorized).toBe(false);
  });

  it("keeps the rotated refresh token Spotify returns, since the old one stops working", async () => {
    const { service, files } = harness({
      stored: true,
      routes: (url) => (url.includes("/api/token") ? json({ ...tokenBody, refresh_token: "refresh-2" }) : json({ items: [] })),
    });
    // The read returns only after the refresh, and its write, are done.
    await service.library({ kind: "playlists" });
    expect(JSON.parse(files.get(SPOTIFY_CREDENTIAL_KEY)!)).toEqual({ clientId: CLIENT_ID, refreshToken: "refresh-2" });
  });

  it("in fake time: no requests while the tab is closed, and a bounded number while songs play", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const TRACK_MS = 200_000;
    let playerReads = 0;
    const { service, fetchImpl, states } = harness({
      stored: true,
      routes: (url) => {
        if (url.includes("/api/token")) return json(tokenBody);
        if (url.includes("/me/player?")) {
          playerReads += 1;
          const elapsed = Date.now() - startedAt;
          const body = playing(elapsed % TRACK_MS);
          return json({ ...body, item: { ...body.item, uri: `spotify:track:t${Math.floor(elapsed / TRACK_MS)}` } });
        }
        return json({});
      },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(states).toHaveLength(0);

    await service.warm();
    const before = states.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Three songs in ten minutes: a read every 15 s at most, plus one at each song's end.
    expect(playerReads).toBeGreaterThanOrEqual(3);
    expect(playerReads).toBeLessThanOrEqual(46);
    // A steady song pushes nothing; each new song pushes once.
    expect(states.length - before).toBeLessThanOrEqual(6);

    await service.unloadPlayer();
    const afterClose = playerReads;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(playerReads).toBe(afterClose);
    service.dispose();
  });
});
