import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MUSIC_SPOTIFY_REDIRECT_URI, type MusicState } from "../../../shared/types/music";
import type { MusicHost, MusicHostEvent } from "./musicHostProcess";
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

function harness(options: { stored?: boolean; playerHost?: boolean; routes: (url: string, init?: RequestInit) => Promise<Response> | Response }) {
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
    ...(options.playerHost ? { playerHost: { executable: "/fake/ade-music-host", userDataDir: "/fake/profile" } } : {}),
    fetchImpl,
  });
  return { service, files, credentials, fetchImpl, states };
}


/**
 * The music host is a child process; ADE's own Spotify player is faked at that
 * boundary. Each test drives the page's events (`loaded`, `ready`, `state`)
 * and sees which requests ADE sent and whether it stopped the process.
 */
type FakeHost = MusicHost & {
  emit: (event: MusicHostEvent) => void;
  requests: string[];
  stopped: boolean;
  /** Runs before a request's reply, as the SDK's own state event does on a pause. */
  beforeReply: Partial<Record<string, () => void>>;
};
const hosts: FakeHost[] = [];
let hostStarted = deferred<FakeHost>();

vi.mock("./musicHostProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./musicHostProcess")>()),
  startMusicHost: () => {
    const events = new Set<(event: MusicHostEvent) => void>();
    const exits = new Set<(info: { code: number | null; signal: string | null }) => void>();
    const host: FakeHost = {
      pid: 4242,
      ready: Promise.resolve({ browserPid: null, origin: "https://music.ade.local" }),
      requests: [],
      stopped: false,
      beforeReply: {},
      request: async <T,>(cmd: string) => {
        host.requests.push(cmd);
        // The page answers on a later turn, after the caller has moved on.
        await Promise.resolve();
        host.beforeReply[cmd]?.();
        return (cmd === "configure" ? { connected: true } : null) as T;
      },
      send: () => {},
      onEvent: (cb) => {
        events.add(cb);
        return () => events.delete(cb);
      },
      onExit: (cb) => {
        exits.add(cb);
        return () => exits.delete(cb);
      },
      stop: async () => {
        host.stopped = true;
        for (const cb of exits) cb({ code: 0, signal: null });
      },
      emit: (event) => {
        for (const cb of events) cb(event);
      },
    };
    hosts.push(host);
    // The page says it listens once ADE has subscribed to its events.
    queueMicrotask(() => {
      host.emit({ event: "loaded" });
      hostStarted.resolve(host);
    });
    return host;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  hosts.length = 0;
  hostStarted = deferred<FakeHost>();
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
    // Exactly the URI the setup guide has the user register: Spotify refuses any other.
    expect(callback.toString()).toBe(MUSIC_SPOTIFY_REDIRECT_URI);

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

describe("ADE's own Spotify player", () => {
  const streaming = { ...tokenBody, scope: "streaming user-read-email user-read-private" };
  const routes = (url: string) =>
    url.includes("/api/token") ? json(streaming) : url.includes("/me/player") ? new Response(null, { status: 204 }) : json({});
  const track = {
    uri: "spotify:track:abc",
    id: "abc",
    name: "Song",
    duration_ms: 200_000,
    album: { name: "Album", uri: "spotify:album:a", images: [] },
    artists: [{ name: "Artist", uri: "spotify:artist:a" }],
  };

  it("closing the tab while the player starts stops it, instead of leaving one running", async () => {
    const { service } = harness({ stored: true, playerHost: true, routes });
    await service.warm();
    const host = await hostStarted.promise;
    await service.unloadPlayer();
    // The SDK registers the device only now, after the tab closed.
    host.emit({ event: "ready", deviceId: "ade-device" });
    await vi.waitFor(() => expect(host.stopped).toBe(true));
    expect(host.requests).toContain("configure");
    expect(hosts).toHaveLength(1);
    expect((await service.getState()).playback.nowPlaying).toBeNull();
  });

  it("a song the player reports while the tab closes does not come back", async () => {
    const { service } = harness({ stored: true, playerHost: true, routes });
    await service.warm();
    const host = await hostStarted.promise;
    host.emit({ event: "ready", deviceId: "ade-device" });
    await vi.waitFor(() => expect(host.requests).toContain("activate"));
    host.emit({ event: "state", state: { paused: false, position: 5_000, duration: 200_000, shuffle: false, repeat: 0, loading: false, track } });
    expect((await service.getState()).playback.nowPlaying?.title).toBe("Song");
    // Pausing makes the SDK report the paused song before the pause returns.
    host.beforeReply.pause = () =>
      host.emit({ event: "state", state: { paused: true, position: 5_100, duration: 200_000, shuffle: false, repeat: 0, loading: false, track } });
    await service.unloadPlayer();
    await vi.waitFor(() => expect(host.stopped).toBe(true));
    expect(host.requests).toContain("pause");
    const state = await service.getState();
    expect(state.playback.nowPlaying).toBeNull();
    expect(state.playback.isPlaying).toBe(false);
  });
});
