import { MusicHostError, startMusicHost, type MusicHost, type MusicHostEvent } from "./musicHostProcess";

/**
 * Spotify playing inside ADE: Spotify's Web Playback SDK on a page
 * (`native/ADEMusicHostWin/page-spotify`) in the same player host Apple Music
 * uses, with its own profile. WebView2 plays Spotify's Widevine streams on
 * Windows and WebKit its FairPlay streams on macOS, so the audio comes out of
 * ADE and ADE shows up in Spotify as a Connect device named "ADE".
 *
 * The host starts on demand and `stop` ends it; `spotifyService` decides when.
 * The SDK asks for an access token whenever it needs one (`needToken`); the
 * token is sent on the pipe and never logged.
 */

export type SpotifyLocalState = {
  paused: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: number;
  loading: boolean;
  track: {
    uri: string;
    id: string;
    name: string;
    duration_ms: number;
    type?: string;
    album: { name: string; uri: string; images: Array<{ url: string; width?: number | null; height?: number | null }> } | null;
    artists: Array<{ name: string; uri: string }>;
  } | null;
};

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

const READY_TIMEOUT_MS = 20_000;

export type SpotifyLocalPlayer = ReturnType<typeof createSpotifyLocalPlayer>;

export function createSpotifyLocalPlayer(args: {
  hostExecutable: string | null;
  userDataDir: string;
  /** A current access token with the `streaming` scope, or null when signed out. */
  accessToken: () => Promise<string | null>;
  onState: (state: SpotifyLocalState | null) => void;
  /** The player stopped on its own (a crash, a lost device). */
  onLost: (reason: string) => void;
  logger?: Logger;
  name?: string;
}) {
  let host: MusicHost | null = null;
  let deviceId: string | null = null;
  let starting: Promise<string> | null = null;
  let stopping: Promise<void> | null = null;
  let volume = 0.8;

  const available = () => Boolean(args.hostExecutable);

  const onEvent = (h: MusicHost, event: MusicHostEvent) => {
    if (host !== h && starting === null) return;
    switch (event.event) {
      case "needToken":
        void args.accessToken().then(
          (token) => { if (token) h.send({ cmd: "token", rid: "t", token }); },
          () => {},
        );
        break;
      case "state":
        if (host === h) args.onState((event.state as SpotifyLocalState | null) ?? null);
        break;
      case "notReady":
        if (host === h) args.logger?.warn("music.spotify.local_not_ready");
        break;
      case "playerError":
        args.logger?.warn("music.spotify.local_error", { kind: String(event.kind ?? ""), message: String(event.message ?? "") });
        break;
      default:
        break;
    }
  };

  const start = (): Promise<string> => {
    if (host && deviceId) return Promise.resolve(deviceId);
    if (starting) return starting;
    if (!args.hostExecutable) return Promise.reject(new Error("Spotify plays in ADE on Windows and macOS."));
    starting = (async () => {
      if (stopping) await stopping;
      const t0 = Date.now();
      const h = startMusicHost({
        executable: args.hostExecutable!,
        userDataDir: args.userDataDir,
        logger: args.logger,
        page: "page-spotify",
        show: process.env.ADE_MUSIC_HOST_SHOW === "1",
      });
      // Commands sent before the page listens are lost: wait for its first word.
      let loadedResolve!: () => void;
      const loaded = new Promise<void>((resolve) => { loadedResolve = resolve; });
      let readyResolve!: (id: string) => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<string>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      ready.catch(() => {});
      const offEvent = h.onEvent((event) => {
        if (event.event === "loaded") loadedResolve();
        else if (event.event === "ready" && typeof event.deviceId === "string") readyResolve(event.deviceId);
        else if (event.event === "playerError" && ["initialization_error", "authentication_error", "account_error"].includes(String(event.kind))) {
          readyReject(new Error(
            event.kind === "account_error"
              ? "Spotify needs Premium to play in ADE."
              : event.kind === "authentication_error"
                ? "Spotify needs you to connect again."
                : "Spotify's player couldn't start here.",
          ));
        }
        onEvent(h, event);
      });
      h.onExit(({ code }) => {
        readyReject(new Error("The Spotify player closed before it was ready."));
        if (host !== h) return;
        host = null;
        deviceId = null;
        offEvent();
        args.onState(null);
        if (code !== 0) args.onLost("The Spotify player closed unexpectedly. Press play to start it again.");
      });
      const timer = setTimeout(() => readyReject(new Error("Spotify's player didn't start in time.")), READY_TIMEOUT_MS);
      try {
        await h.ready;
        await Promise.race([loaded, ready.then(() => undefined)]);
        await h.request("configure", { name: args.name ?? "ADE", volume }, READY_TIMEOUT_MS);
        const id = await ready;
        host = h;
        deviceId = id;
        args.logger?.info("music.spotify.local_started", { pid: h.pid, ms: Date.now() - t0 });
        return id;
      } catch (error) {
        await h.stop(1_000).catch(() => {});
        throw error instanceof MusicHostError ? new Error(error.message) : error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return starting.finally(() => {
      starting = null;
    });
  };

  const stop = async (): Promise<void> => {
    const h = host;
    host = null;
    deviceId = null;
    if (!h) return;
    const t0 = Date.now();
    stopping = h.stop(2_000).finally(() => {
      stopping = null;
    });
    await stopping;
    args.logger?.info("music.spotify.local_stopped", { ms: Date.now() - t0 });
  };

  /** A command for the SDK player; false when no player runs. */
  const send = async (cmd: "pause" | "resume" | "toggle" | "next" | "previous" | "activate", params: Record<string, unknown> = {}): Promise<boolean> => {
    if (!host) return false;
    await host.request(cmd, params, 10_000);
    return true;
  };

  return {
    available,
    start,
    stop,
    /** The SDK device id while the player runs. */
    deviceId: (): string | null => deviceId,
    running: (): boolean => host !== null,
    pause: () => send("pause"),
    resume: () => send("resume"),
    toggle: () => send("toggle"),
    activate: () => send("activate"),
    seek: async (ms: number): Promise<boolean> => {
      if (!host) return false;
      await host.request("seek", { ms }, 10_000);
      return true;
    },
    setVolume: async (value: number): Promise<boolean> => {
      volume = value;
      if (!host) return false;
      await host.request("volume", { value }, 10_000);
      return true;
    },
  };
}
