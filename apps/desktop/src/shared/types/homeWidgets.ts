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
} as const;

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

export type HomeWeather = {
  temperatureC: number;
  apparentC: number | null;
  code: number;
  isDay: boolean;
  windKph: number | null;
  todayMaxC: number | null;
  todayMinC: number | null;
  days: HomeWeatherDay[];
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
};
