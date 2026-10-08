import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { HomeNowPlayingCommand, HomeNowPlayingSession, HomeNowPlayingState } from "../../../shared/types/homeWidgets";
import type { BrowserMediaSessions } from "./browserMediaSessions";
import { appSourceName } from "./nowPlayingSources";

/**
 * Now Playing for the home page's widget: one list of everything playing,
 * merged from three sources, best first.
 *
 * 1. ADE's own Apple Music player (the Music tab), through `setOverride`.
 * 2. ADE's built-in browser tabs playing media (`browserMediaSessions.ts`).
 * 3. Other apps on this computer, from the OS media session:
 *    - Windows: `ade-now-playing.exe` (native/ADENowPlayingWin), a long-lived
 *      helper that streams every Global System Media Transport Controls
 *      session as NDJSON (with each app's icon) and takes commands on stdin.
 *      Spawned async; nothing here ever blocks the main thread.
 *    - macOS (unverified on this build machine): `mediaremote-adapter`
 *      (github.com/ungive/mediaremote-adapter) through /usr/bin/perl when its
 *      script and framework are bundled in resources/native/mediaremote-adapter;
 *      otherwise Music.app over AppleScript, polled every 2 s.
 *    ADE's own sessions are skipped there: its browser tabs and its Apple
 *    Music player already come from 1 and 2.
 *
 * Order: a playing ADE player, a playing browser tab, a playing app, then
 * ADE's paused player, then the most recently paused anything. The widget
 * shows the first one unless the user picked another with `select`.
 *
 * The OS source and the browser's position polling run only while at least
 * one widget is subscribed (on screen); the last unsubscribe stops them.
 */

export type NowPlayingOverride = {
  /** Current state; push changes with the `emit` given to `setOverride`. */
  getState: () => HomeNowPlayingState;
  command: (command: HomeNowPlayingCommand) => Promise<void> | void;
};

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

type OsSourceKind = "windows-smtc" | "macos-mediaremote" | "macos-music";

/** What the OS source reports: every session it can see. */
type OsSnapshot = { available: boolean; error?: string; sessions: HomeNowPlayingSession[] };

type OsSource = { stop: () => void; command: (command: HomeNowPlayingCommand, rawId: string | null) => void };

function resolveHelper(input: { isPackaged: boolean; resourcesPath: string; appPath: string }, name: string): string | null {
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "native", name)]
    : [path.join(input.appPath, "resources", "native", name), path.join(input.appPath, "apps", "desktop", "resources", "native", name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

type RawSession = {
  id?: string;
  app?: string;
  name?: string | null;
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
  icon?: string | null;
};

const dataImage = (value: unknown): string | null =>
  typeof value === "string" && value.startsWith("data:image/") ? value : null;

function toSession(raw: RawSession, rawId: string): HomeNowPlayingSession | null {
  if (!raw.title && !raw.artist) return null;
  const status = raw.status === "playing" || raw.status === "paused" || raw.status === "stopped" ? raw.status : raw.status === "changing" ? "playing" : "stopped";
  return {
    id: `app:${rawId}`,
    kind: "app",
    app: appSourceName(raw.app, raw.name),
    appIcon: dataImage(raw.icon),
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
    artwork: dataImage(raw.artwork),
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
    if (buffer.length > 32 * 1024 * 1024) buffer = "";
  });
}

function startWindows(helper: string, isOwn: (appId: string) => boolean, emit: (snapshot: OsSnapshot) => void, logger?: Logger): OsSource {
  // The helper sends artwork, icon and name only when they change; keep the last ones per session.
  const kept = new Map<string, { artwork: string | null; icon: string | null; name: string | null }>();
  let child: ChildProcessWithoutNullStreams | null = spawn(helper, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => {
    logger?.warn("home.now_playing.helper_error", { error: error.message });
    emit({ available: false, sessions: [], error: "The Now Playing helper could not start." });
  });
  child.on("exit", (code) => {
    if (child) logger?.warn("home.now_playing.helper_exit", { code });
    child = null;
  });
  const remember = (rawId: string, raw: RawSession) => {
    const previous = kept.get(rawId) ?? { artwork: null, icon: null, name: null };
    const next = {
      artwork: raw.artwork === undefined ? previous.artwork : raw.artwork,
      icon: raw.icon === undefined ? previous.icon : raw.icon,
      name: raw.name === undefined ? previous.name : raw.name,
    };
    kept.set(rawId, next);
    return { ...raw, ...next };
  };
  onLines(child.stdout, (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; sessions?: RawSession[]; session?: RawSession | null; current?: string | null; message?: string };
      if (message.type === "sessions" && Array.isArray(message.sessions)) {
        const seen = new Set<string>();
        const sessions: HomeNowPlayingSession[] = [];
        for (const raw of message.sessions) {
          const rawId = String(raw.id ?? raw.app ?? "");
          if (!rawId) continue;
          seen.add(rawId);
          const full = remember(rawId, raw);
          if (isOwn(String(raw.app ?? rawId))) continue;
          const session = toSession(full, rawId);
          if (session) sessions.push(session);
        }
        for (const rawId of kept.keys()) if (!seen.has(rawId)) kept.delete(rawId);
        // Windows' own idea of the current session goes first among equals.
        const current = message.current ? `app:${message.current}` : null;
        sessions.sort((a, b) => Number(b.id === current) - Number(a.id === current));
        emit({ available: true, sessions });
      } else if (message.type === "state") {
        // An older helper: just the current session.
        const raw = message.session ?? null;
        const full = raw ? remember("current", raw) : null;
        const session = full && !isOwn(String(full.app ?? "")) ? toSession(full, "current") : null;
        emit({ available: true, sessions: session ? [session] : [] });
      } else if (message.type === "error") {
        logger?.warn("home.now_playing.helper_message", { message: message.message });
      }
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
    command: (command, rawId) => {
      try {
        child?.stdin.write(rawId && rawId !== "current" ? `${command} ${rawId}\n` : `${command}\n`);
      } catch {
        // The helper exited; the next subscribe restarts it.
      }
    },
  };
}

const MAC_SEND_IDS: Record<HomeNowPlayingCommand, number> = { play: 0, pause: 1, toggle: 2, next: 4, previous: 5 };

/** The app's icon on macOS (unverified): its bundle found by Spotlight, drawn by Electron. */
function macAppIcon(bundleId: string, getAppIcon: ((appPath: string) => Promise<string | null>) | undefined): Promise<string | null> {
  if (!getAppIcon || !/^[A-Za-z0-9.-]+$/.test(bundleId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 4000 }, (error, stdout) => {
      const appPath = error ? null : String(stdout).split("\n").find((line) => line.endsWith(".app")) ?? null;
      if (!appPath) {
        resolve(null);
        return;
      }
      getAppIcon(appPath).then(resolve, () => resolve(null));
    });
  });
}

function startMacAdapter(
  dir: string,
  isOwn: (appId: string) => boolean,
  emit: (snapshot: OsSnapshot) => void,
  getAppIcon: ((appPath: string) => Promise<string | null>) | undefined,
  logger?: Logger,
): OsSource {
  const script = path.join(dir, "mediaremote-adapter.pl");
  const framework = path.join(dir, "MediaRemoteAdapter.framework");
  const icons = new Map<string, string | null>();
  let latest: RawSession | null = null;
  const publish = () => {
    const session = latest && !isOwn(String(latest.app ?? "")) ? toSession({ ...latest, icon: icons.get(String(latest.app)) ?? null }, String(latest.app ?? "current")) : null;
    emit({ available: true, sessions: session ? [session] : [] });
  };
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
        publish();
        return;
      }
      const mime = typeof payload.artworkMimeType === "string" ? payload.artworkMimeType : "image/jpeg";
      const bundleId = typeof payload.bundleIdentifier === "string" ? payload.bundleIdentifier : undefined;
      latest = {
        app: bundleId,
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
      if (bundleId && !icons.has(bundleId)) {
        icons.set(bundleId, null);
        void macAppIcon(bundleId, getAppIcon).then((icon) => {
          icons.set(bundleId, icon);
          if (icon && latest?.app === bundleId) publish();
        });
      }
      publish();
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

function startMacMusicApp(emit: (snapshot: OsSnapshot) => void): OsSource {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const poll = () => {
    execFile("/usr/bin/osascript", ["-e", MUSIC_SCRIPT], { timeout: 4000 }, (error, stdout) => {
      if (stopped) return;
      if (!error) {
        const [state, title, artist, album, position, duration] = String(stdout).trim().split("\t");
        const session = state === "playing" || state === "paused"
          ? toSession({
            app: "com.apple.Music",
            title,
            artist,
            album,
            status: state,
            positionMs: Math.round(Number(position) * 1000),
            durationMs: Math.round(Number(duration) * 1000),
            updatedAtMs: Date.now(),
          }, "com.apple.Music")
          : null;
        emit({ available: true, sessions: session ? [session] : [] });
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

/** Lower is better. */
function rank(session: HomeNowPlayingSession): number {
  if (session.status === "playing") return session.kind === "ade-music" ? 0 : session.kind === "browser" ? 1 : 2;
  return session.kind === "ade-music" ? 3 : 4;
}

export function createNowPlayingService(args: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  /**
   * OS media sessions that are ADE itself (its AppUserModelId, its bundle id,
   * the Music tab's player host): skipped, since ADE reports those directly.
   */
  isOwnApp?: (appId: string) => boolean;
  /** macOS: an app bundle's icon as a data URL (Electron's `app.getFileIcon`). */
  getAppIcon?: (appPath: string) => Promise<string | null>;
  /** Sends a state to every subscribed renderer. */
  broadcast: (state: HomeNowPlayingState) => void;
  logger?: Logger;
}) {
  const platform = args.platform ?? process.platform;
  const isOwn = args.isOwnApp ?? (() => false);
  const subscribers = new Set<number>();
  let osSource: OsSource | null = null;
  let osKind: OsSourceKind | null = null;
  let os: OsSnapshot = { available: true, sessions: [] };
  let override: NowPlayingOverride | null = null;
  let browser: BrowserMediaSessions | null = null;
  let pinnedId: string | null = null;
  /** When each session started playing (orders the playing ones) and was last seen playing (the paused ones). */
  const startedAt = new Map<string, number>();
  const lastPlaying = new Map<string, number>();
  let state: HomeNowPlayingState = { available: true, session: null, sessions: [], source: null };
  let lastSignature = "";
  let scheduled = false;

  const merged = (): HomeNowPlayingSession[] => {
    const list: HomeNowPlayingSession[] = [];
    const own = override?.getState().session;
    if (own) list.push({ ...own, id: "ade-music", kind: "ade-music" });
    if (browser) {
      for (const { lastPlayingAt: _ignored, ...session } of browser.sessions()) list.push(session);
    }
    list.push(...os.sessions);
    return list;
  };

  const sourceOf = (session: HomeNowPlayingSession | null): HomeNowPlayingState["source"] => {
    if (!session) return osKind;
    if (session.kind === "ade-music") return "ade-music";
    if (session.kind === "browser") return "ade-browser";
    return osKind;
  };

  const recompute = () => {
    scheduled = false;
    const now = Date.now();
    const list = merged();
    const ids = new Set(list.map((session) => session.id));
    let startedOther = false;
    for (const session of list) {
      if (session.status === "playing") {
        lastPlaying.set(session.id, now);
        if (!startedAt.has(session.id)) {
          startedAt.set(session.id, now);
          if (session.id !== pinnedId) startedOther = true;
        }
      } else {
        startedAt.delete(session.id);
      }
    }
    for (const id of lastPlaying.keys()) {
      if (!ids.has(id)) {
        lastPlaying.delete(id);
        startedAt.delete(id);
      }
    }
    const recency = (session: HomeNowPlayingSession) =>
      (session.status === "playing" ? startedAt.get(session.id) : lastPlaying.get(session.id)) ?? 0;
    // A pick lasts until its source goes away or something else starts playing.
    if (pinnedId && (!ids.has(pinnedId) || startedOther)) pinnedId = null;
    const order = list
      .map((session, index) => ({ session, index }))
      .sort((a, b) => rank(a.session) - rank(b.session)
        || recency(b.session) - recency(a.session)
        || a.index - b.index)
      .map(({ session }) => session);
    const selected = (pinnedId ? order.find((session) => session.id === pinnedId) : null) ?? order[0] ?? null;
    const anySource = os.available || Boolean(override) || Boolean(browser);
    state = {
      available: anySource,
      session: selected,
      // The switcher needs names and icons, not every cover.
      sessions: order.map((session) => ({ ...session, artwork: null })),
      source: sourceOf(selected),
      ...(selected || os.available ? {} : { error: os.error }),
    };
    browser?.setPollTarget(subscribers.size > 0 && selected?.kind === "browser" && selected.status === "playing" ? selected.id : null);
    if (subscribers.size === 0) return;
    const signature = JSON.stringify(state);
    if (signature === lastSignature) return;
    lastSignature = signature;
    args.broadcast(state);
  };

  /** Coalesces a burst of source updates into one broadcast. */
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(recompute, 16);
  };

  const publishOs = (snapshot: OsSnapshot) => {
    os = snapshot;
    changed();
  };

  const startOs = () => {
    if (osSource) return;
    if (platform === "win32") {
      osKind = "windows-smtc";
      const helper = resolveHelper(args, "ade-now-playing.exe");
      if (!helper) {
        publishOs({ available: false, sessions: [], error: "The Now Playing helper is missing from this build." });
        return;
      }
      osSource = startWindows(helper, isOwn, publishOs, args.logger);
    } else if (platform === "darwin") {
      const adapterDir = path.join(args.isPackaged ? path.join(args.resourcesPath, "native") : path.join(args.appPath, "resources", "native"), "mediaremote-adapter");
      if (fs.existsSync(path.join(adapterDir, "mediaremote-adapter.pl"))) {
        osKind = "macos-mediaremote";
        osSource = startMacAdapter(adapterDir, isOwn, publishOs, args.getAppIcon, args.logger);
      } else {
        osKind = "macos-music";
        osSource = startMacMusicApp(publishOs);
      }
    } else {
      publishOs({ available: false, sessions: [], error: "Now Playing is not available on this system yet." });
    }
  };

  const stopOs = () => {
    osSource?.stop();
    osSource = null;
    os = { available: true, sessions: [] };
  };

  const find = (sessionId: string | null | undefined): HomeNowPlayingSession | null => {
    if (!sessionId) return state.session;
    return merged().find((session) => session.id === sessionId) ?? null;
  };

  return {
    /** A renderer's widget came on screen. Returns the current state at once. */
    subscribe(id: number): HomeNowPlayingState {
      subscribers.add(id);
      startOs();
      lastSignature = "";
      recompute();
      lastSignature = JSON.stringify(state);
      return state;
    },
    /** The widget left the screen, or its window closed. The last one stops the OS source and polling. */
    unsubscribe(id: number) {
      subscribers.delete(id);
      if (subscribers.size === 0) {
        stopOs();
        browser?.setPollTarget(null);
      }
    },
    async command(command: HomeNowPlayingCommand, sessionId?: string | null) {
      const target = find(sessionId);
      if (!target) return;
      if (target.kind === "ade-music") {
        await override?.command(command);
      } else if (target.kind === "browser") {
        await browser?.command(target.id, command);
      } else {
        osSource?.command(command, target.id.replace(/^app:/, ""));
      }
    },
    /** Show this session instead of the best one; null goes back to the best one. */
    select(sessionId: string | null) {
      pinnedId = sessionId && merged().some((session) => session.id === sessionId) ? sessionId : null;
      recompute();
    },
    /**
     * Hook for ADE's own player (the Music tab): while set, its session joins
     * the list (first while it plays). Returns the function the player calls
     * to push its state; pass null when the player has nothing loaded.
     */
    setOverride(next: NowPlayingOverride | null): (state: HomeNowPlayingState) => void {
      override = next;
      changed();
      return () => {
        if (override === next) changed();
      };
    },
    /** The built-in browser's media tabs. */
    setBrowserSource(next: BrowserMediaSessions | null) {
      browser = next;
      changed();
    },
    /** A source changed outside the calls above (the browser's tabs). */
    notifyChanged: changed,
    dispose() {
      subscribers.clear();
      stopOs();
      browser?.dispose();
    },
  };
}

export type NowPlayingService = ReturnType<typeof createNowPlayingService>;
