import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { HomeNowPlayingCommand, HomeNowPlayingState } from "../../../shared/types/homeWidgets";

/**
 * What the computer is playing, from any player, for the home page's Now
 * Playing widget.
 *
 * - Windows: `ade-now-playing.exe` (native/ADENowPlayingWin), a long-lived
 *   helper that streams the Global System Media Transport Controls as NDJSON
 *   and takes play/pause/next/previous on stdin. Spawned async; nothing here
 *   ever blocks the main thread.
 * - macOS (unverified on this build machine): `mediaremote-adapter`
 *   (github.com/ungive/mediaremote-adapter) through /usr/bin/perl when its
 *   script and framework are bundled in resources/native/mediaremote-adapter;
 *   otherwise Music.app over AppleScript, polled every 2 s.
 * - Elsewhere: unavailable.
 *
 * The source runs only while at least one widget is subscribed (on screen);
 * the last unsubscribe stops it. A future in-app player (the Music tab) can
 * take over with `setOverride`: while set, its state is what the widget sees
 * and its controls are what the buttons press.
 */

export type NowPlayingOverride = {
  /** Current state; push changes with the `emit` given to `setOverride`. */
  getState: () => HomeNowPlayingState;
  command: (command: HomeNowPlayingCommand) => Promise<void> | void;
};

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

type Source = { stop: () => void; command: (command: HomeNowPlayingCommand) => void };

const EMPTY: HomeNowPlayingState = { available: true, session: null, source: null };

function resolveHelper(input: { isPackaged: boolean; resourcesPath: string; appPath: string }, name: string): string | null {
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "native", name)]
    : [path.join(input.appPath, "resources", "native", name), path.join(input.appPath, "apps", "desktop", "resources", "native", name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

type RawSession = {
  app?: string;
  title?: string;
  artist?: string;
  album?: string;
  status?: string;
  positionMs?: number;
  durationMs?: number;
  updatedAtMs?: number;
  canPlay?: boolean;
  canPause?: boolean;
  canNext?: boolean;
  canPrevious?: boolean;
  artwork?: string | null;
};

function friendlyApp(id: string | undefined): string | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  if (lower.includes("spotify")) return "Spotify";
  if (lower.includes("applemusic") || lower.includes("apple.music") || lower.includes("appleinc.applemusic")) return "Apple Music";
  if (lower.includes("zunemusic") || lower.includes("media.player")) return "Media Player";
  if (lower.includes("msedge")) return "Microsoft Edge";
  if (lower.includes("chrome")) return "Chrome";
  if (lower.includes("firefox")) return "Firefox";
  if (lower.includes("vlc")) return "VLC";
  if (lower.includes("com.apple.music")) return "Music";
  // "Publisher.App_hash!App" or "app.exe": the readable middle.
  const base = id.split("!")[0]!.split("_")[0]!.replace(/\.exe$/i, "");
  return base.split(".").at(-1) || base;
}

function toState(raw: RawSession | null, source: HomeNowPlayingState["source"]): HomeNowPlayingState {
  if (!raw || (!raw.title && !raw.artist)) return { available: true, session: null, source };
  const status = raw.status === "playing" || raw.status === "paused" || raw.status === "stopped" ? raw.status : raw.status === "changing" ? "playing" : "stopped";
  return {
    available: true,
    source,
    session: {
      app: friendlyApp(raw.app),
      title: raw.title ?? "",
      artist: raw.artist ?? "",
      album: raw.album ?? "",
      status,
      positionMs: Math.max(0, Number(raw.positionMs) || 0),
      durationMs: Math.max(0, Number(raw.durationMs) || 0),
      updatedAt: Number(raw.updatedAtMs) > 0 ? Number(raw.updatedAtMs) : Date.now(),
      canPlay: raw.canPlay !== false,
      canPause: raw.canPause !== false,
      canNext: raw.canNext !== false,
      canPrevious: raw.canPrevious !== false,
      artwork: typeof raw.artwork === "string" && raw.artwork.startsWith("data:image/") ? raw.artwork : null,
    },
  };
}

/** NDJSON lines from a stream, one callback per complete line. */
function onLines(stream: NodeJS.ReadableStream, handle: (line: string) => void) {
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handle(line);
      index = buffer.indexOf("\n");
    }
    // A runaway line (a giant artwork) never grows without bound.
    if (buffer.length > 16 * 1024 * 1024) buffer = "";
  });
}

function startWindows(helper: string, emit: (state: HomeNowPlayingState) => void, logger?: Logger): Source {
  let lastArtwork: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = spawn(helper, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => {
    logger?.warn("home.now_playing.helper_error", { error: error.message });
    emit({ available: false, session: null, source: "windows-smtc", error: "The Now Playing helper could not start." });
  });
  child.on("exit", (code) => {
    if (child) logger?.warn("home.now_playing.helper_exit", { code });
    child = null;
  });
  onLines(child.stdout, (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; session?: RawSession | null; message?: string };
      if (message.type === "state") {
        const raw = message.session ?? null;
        // The helper sends artwork only when it changes; keep the last one.
        if (raw && raw.artwork === undefined) raw.artwork = lastArtwork;
        lastArtwork = raw?.artwork ?? null;
        emit(toState(raw, "windows-smtc"));
      }
      else if (message.type === "error") logger?.warn("home.now_playing.helper_message", { message: message.message });
    } catch {
      // A partial or foreign line: skip it.
    }
  });
  child.stderr.resume();
  return {
    stop: () => {
      const running = child;
      child = null;
      if (!running) return;
      try {
        running.stdin.end("quit\n");
      } catch {
        // Already closing.
      }
      // Closing stdin ends it; make sure.
      setTimeout(() => {
        if (running.exitCode == null) running.kill();
      }, 1500).unref?.();
    },
    command: (command) => {
      try {
        child?.stdin.write(`${command}\n`);
      } catch {
        // The helper exited; the next subscribe restarts it.
      }
    },
  };
}

const MAC_SEND_IDS: Record<HomeNowPlayingCommand, number> = { play: 0, pause: 1, toggle: 2, next: 4, previous: 5 };

function startMacAdapter(dir: string, emit: (state: HomeNowPlayingState) => void, logger?: Logger): Source {
  const script = path.join(dir, "mediaremote-adapter.pl");
  const framework = path.join(dir, "MediaRemoteAdapter.framework");
  let latest: RawSession | null = null;
  let child: ChildProcessWithoutNullStreams | null = spawn("/usr/bin/perl", [script, framework, "stream", "--no-diff", "--debounce=150"], { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => logger?.warn("home.now_playing.adapter_error", { error: error.message }));
  child.on("exit", () => {
    child = null;
  });
  onLines(child.stdout, (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (message.type !== "data") return;
      const payload = message.payload ?? {};
      if (!payload.title && !payload.artist) {
        latest = null;
        emit(toState(null, "macos-mediaremote"));
        return;
      }
      const mime = typeof payload.artworkMimeType === "string" ? payload.artworkMimeType : "image/jpeg";
      latest = {
        app: typeof payload.bundleIdentifier === "string" ? payload.bundleIdentifier : undefined,
        title: String(payload.title ?? ""),
        artist: String(payload.artist ?? ""),
        album: String(payload.album ?? ""),
        status: payload.playing ? "playing" : "paused",
        // Seconds in the adapter's default output.
        positionMs: Math.round(Number(payload.elapsedTime ?? 0) * 1000),
        durationMs: Math.round(Number(payload.duration ?? 0) * 1000),
        updatedAtMs: typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Date.now(),
        artwork: typeof payload.artworkData === "string" ? `data:${mime};base64,${payload.artworkData}` : null,
      };
      emit(toState(latest, "macos-mediaremote"));
    } catch {
      // Skip a malformed line.
    }
  });
  child.stderr.resume();
  return {
    stop: () => {
      child?.kill("SIGTERM");
      child = null;
    },
    command: (command) => {
      execFile("/usr/bin/perl", [script, framework, "send", String(MAC_SEND_IDS[command])], { timeout: 5000 }, () => {});
    },
  };
}

const MUSIC_SCRIPT = `
if application "Music" is running then
  tell application "Music"
    if player state is stopped then return "stopped"
    set t to current track
    return (player state as text) & "\\t" & (name of t) & "\\t" & (artist of t) & "\\t" & (album of t) & "\\t" & (player position as text) & "\\t" & (duration of t as text)
  end tell
else
  return "closed"
end if`;

function startMacMusicApp(emit: (state: HomeNowPlayingState) => void): Source {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const poll = () => {
    execFile("/usr/bin/osascript", ["-e", MUSIC_SCRIPT], { timeout: 4000 }, (error, stdout) => {
      if (stopped) return;
      if (!error) {
        const [state, title, artist, album, position, duration] = String(stdout).trim().split("\t");
        if (state === "playing" || state === "paused") {
          emit(toState({
            app: "com.apple.Music",
            title,
            artist,
            album,
            status: state,
            positionMs: Math.round(Number(position) * 1000),
            durationMs: Math.round(Number(duration) * 1000),
            updatedAtMs: Date.now(),
          }, "macos-music"));
        } else {
          emit(toState(null, "macos-music"));
        }
      }
      timer = setTimeout(poll, 2000);
    });
  };
  poll();
  const verbs: Record<HomeNowPlayingCommand, string> = { play: "play", pause: "pause", toggle: "playpause", next: "next track", previous: "previous track" };
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    command: (command) => {
      execFile("/usr/bin/osascript", ["-e", `tell application "Music" to ${verbs[command]}`], { timeout: 4000 }, () => {
        if (!stopped) {
          if (timer) clearTimeout(timer);
          poll();
        }
      });
    },
  };
}

export function createNowPlayingService(args: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  /** Sends a state to every subscribed renderer. */
  broadcast: (state: HomeNowPlayingState) => void;
  logger?: Logger;
}) {
  const platform = args.platform ?? process.platform;
  const subscribers = new Set<number>();
  let source: Source | null = null;
  let state: HomeNowPlayingState = EMPTY;
  let override: NowPlayingOverride | null = null;

  const publish = (next: HomeNowPlayingState) => {
    state = next;
    if (!override && subscribers.size > 0) args.broadcast(next);
  };

  const startSource = () => {
    if (source || override) return;
    if (platform === "win32") {
      const helper = resolveHelper(args, "ade-now-playing.exe");
      if (!helper) {
        publish({ available: false, session: null, source: "windows-smtc", error: "The Now Playing helper is missing from this build." });
        return;
      }
      source = startWindows(helper, publish, args.logger);
    } else if (platform === "darwin") {
      const adapterDir = path.join(args.isPackaged ? path.join(args.resourcesPath, "native") : path.join(args.appPath, "resources", "native"), "mediaremote-adapter");
      source = fs.existsSync(path.join(adapterDir, "mediaremote-adapter.pl"))
        ? startMacAdapter(adapterDir, publish, args.logger)
        : startMacMusicApp(publish);
    } else {
      publish({ available: false, session: null, source: null, error: "Now Playing is not available on this system yet." });
    }
  };

  const stopSource = () => {
    source?.stop();
    source = null;
    state = EMPTY;
  };

  return {
    /** A renderer's widget came on screen. Returns the current state at once. */
    subscribe(id: number): HomeNowPlayingState {
      subscribers.add(id);
      if (override) return override.getState();
      startSource();
      return state;
    },
    /** The widget left the screen, or its window closed. The last one stops the source. */
    unsubscribe(id: number) {
      subscribers.delete(id);
      if (subscribers.size === 0) stopSource();
    },
    async command(command: HomeNowPlayingCommand) {
      if (override) {
        await override.command(command);
        return;
      }
      source?.command(command);
    },
    /**
     * Hook for an in-app player (the future Music tab): while set, it is the
     * widget's source and the OS source is stopped. Returns the function the
     * player calls to push its state; pass null to hand back to the OS.
     */
    setOverride(next: NowPlayingOverride | null): (state: HomeNowPlayingState) => void {
      override = next;
      if (next) {
        source?.stop();
        source = null;
        if (subscribers.size > 0) args.broadcast(next.getState());
      } else if (subscribers.size > 0) {
        startSource();
        args.broadcast(state);
      }
      return (pushed) => {
        if (override === next && subscribers.size > 0) args.broadcast(pushed);
      };
    },
    dispose() {
      subscribers.clear();
      stopSource();
    },
  };
}

export type NowPlayingService = ReturnType<typeof createNowPlayingService>;
