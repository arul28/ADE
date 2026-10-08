/**
 * The home page's machine-backed widgets: clipboard history, machine health
 * and weather. The renderer cannot read the clipboard in the background, list
 * other processes' ports or fetch from the internet (its CSP has no https
 * connect-src), so the desktop main process answers these. Each call is async
 * and cheap; see `main/services/home/homeWidgetsService.ts` for the costs.
 */

export const HOME_WIDGETS_IPC = {
  clipboardGetState: "ade.home.clipboard.getState",
  clipboardConfigure: "ade.home.clipboard.configure",
  clipboardClear: "ade.home.clipboard.clear",
  clipboardRemove: "ade.home.clipboard.remove",
  clipboardCopy: "ade.home.clipboard.copy",
  clipboardChanged: "ade.home.clipboard.changed",
  machineHealth: "ade.home.machine.health",
  machineListeners: "ade.home.machine.listeners",
  machineKill: "ade.home.machine.kill",
  weatherSearch: "ade.home.weather.search",
  weatherGet: "ade.home.weather.get",
  shareCopyImage: "ade.home.share.copyImage",
  shareSaveImage: "ade.home.share.saveImage",
  nowPlayingSubscribe: "ade.home.nowPlaying.subscribe",
  nowPlayingUnsubscribe: "ade.home.nowPlaying.unsubscribe",
  nowPlayingCommand: "ade.home.nowPlaying.command",
  nowPlayingSelect: "ade.home.nowPlaying.select",
  nowPlayingChanged: "ade.home.nowPlaying.changed",
} as const;

export type HomeNowPlayingCommand = "play" | "pause" | "toggle" | "next" | "previous";

/**
 * Where a Now Playing session comes from:
 * - `ade-music`: ADE's own Apple Music player (the Music tab).
 * - `browser`: a tab in ADE's built-in browser playing media.
 * - `app`: another app on this computer, through the OS media session.
 */
export type HomeNowPlayingSourceKind = "ade-music" | "browser" | "app";

export type HomeNowPlayingSession = {
  /** Stable while the source lives: "ade-music", "tab:<id>" or "app:<OS session id>". */
  id: string;
  kind: HomeNowPlayingSourceKind;
  /** The player or site, in words ("Spotify", "YouTube Music"), when it is known. */
  app: string | null;
  /** The source's own icon as a data URL: the app's icon, or the site's largest favicon. */
  appIcon: string | null;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped";
  /** Position at `updatedAt`; the widget runs it forward while playing. */
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Album art as a data URL (or an https URL for ADE's own player), when the player shares one. */
  artwork: string | null;
  /** A tab of the Browser top tab: the widget can bring it to the front. */
  browserTabId?: string | null;
};

export type HomeNowPlayingState = {
  /** False when nothing can be read here (no OS source and nothing in ADE). */
  available: boolean;
  /** The session the widget shows: the best one, or the one the user picked. */
  session: HomeNowPlayingSession | null;
  /**
   * Every source with something loaded, best first (ADE's player, then a
   * playing browser tab, then a playing app, then the most recent paused).
   * Artwork is left out here; `session` carries it.
   */
  sessions?: HomeNowPlayingSession[];
  source: "windows-smtc" | "macos-mediaremote" | "macos-music" | "ade-music" | "ade-browser" | null;
  error?: string;
};

/** A PNG the renderer drew (a data URL), to copy or save. Nothing is uploaded. */
export type HomeShareResult = { ok: true; path?: string } | { ok: false; canceled?: boolean; error?: string };

export type HomeClipboardEntry = {
  id: string;
  text: string;
  /** Epoch ms of the copy ADE noticed. */
  copiedAt: number;
  /** Characters in the original copy; `text` is cut at the history's size cap. */
  length: number;
};

export type HomeClipboardState = {
  /** Watching the clipboard (the widget is on someone's home page). */
  enabled: boolean;
  /** History survives a restart (written to this computer's ADE user data). */
  persist: boolean;
  entries: HomeClipboardEntry[];
  /** Copies left out because they looked like a secret or a password manager marked them. */
  skippedSecrets: number;
};

export type HomeMachineHealth = {
  /** 0–100 across all cores since the previous call; null on the first call. */
  cpuPercent: number | null;
  cpuCount: number;
  cpuModel: string | null;
  memTotalBytes: number;
  memUsedBytes: number;
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  uptimeSec: number;
  hostname: string;
  platform: NodeJS.Platform;
};

export type HomeListeningProcess = {
  pid: number;
  name: string | null;
  ports: number[];
  /** A dev runtime (node, bun, python…) rather than a system or desktop app. */
  dev: boolean;
  /** One of ADE's own processes: never offered for killing. */
  protected: boolean;
};

export type HomeListenersResult =
  | { ok: true; processes: HomeListeningProcess[]; scannedAt: number }
  | { ok: false; error: string };

export type HomeKillResult = { ok: true } | { ok: false; error: string };

export type HomeWeatherPlace = {
  name: string;
  /** Region and country, for telling two Springfields apart. */
  detail: string | null;
  latitude: number;
  longitude: number;
  timezone: string | null;
};

export type HomeWeatherDay = { date: string; code: number; maxC: number; minC: number };

/** One forecast hour, in the place's own local hour (0–23). */
export type HomeWeatherHour = { hour: number; code: number; tempC: number; isDay: boolean };

export type HomeWeather = {
  temperatureC: number;
  apparentC: number | null;
  code: number;
  isDay: boolean;
  windKph: number | null;
  todayMaxC: number | null;
  todayMinC: number | null;
  days: HomeWeatherDay[];
  /** The next twelve hours; absent on a cached reading from before hours were read. */
  hours?: HomeWeatherHour[];
  fetchedAt: number;
};

export type HomeWeatherResult = { ok: true; weather: HomeWeather } | { ok: false; error: string };
export type HomeWeatherSearchResult = { ok: true; places: HomeWeatherPlace[] } | { ok: false; error: string };

export type HomeWidgetsBridge = {
  clipboard: {
    getState: () => Promise<HomeClipboardState>;
    configure: (args: { enabled?: boolean; persist?: boolean }) => Promise<HomeClipboardState>;
    clear: () => Promise<HomeClipboardState>;
    remove: (id: string) => Promise<HomeClipboardState>;
    copy: (id: string) => Promise<boolean>;
    onChanged: (cb: (state: HomeClipboardState) => void) => () => void;
  };
  machine: {
    health: () => Promise<HomeMachineHealth>;
    listeners: () => Promise<HomeListenersResult>;
    kill: (pid: number) => Promise<HomeKillResult>;
  };
  weather: {
    search: (query: string) => Promise<HomeWeatherSearchResult>;
    get: (args: { latitude: number; longitude: number }) => Promise<HomeWeatherResult>;
  };
  nowPlaying: {
    /** The widget is on screen: start the source (if needed) and get the state now. */
    subscribe: () => Promise<HomeNowPlayingState>;
    unsubscribe: () => Promise<void>;
    /** Sends to `sessionId`, or to the session shown when it is omitted. */
    command: (command: HomeNowPlayingCommand, sessionId?: string) => Promise<void>;
    /** Show this session instead of the best one (null: back to the best one). */
    select: (sessionId: string | null) => Promise<void>;
    onChanged: (cb: (state: HomeNowPlayingState) => void) => () => void;
  };
  share: {
    copyImage: (pngDataUrl: string) => Promise<HomeShareResult>;
    saveImage: (args: { pngDataUrl: string; fileName: string }) => Promise<HomeShareResult>;
  };
};
