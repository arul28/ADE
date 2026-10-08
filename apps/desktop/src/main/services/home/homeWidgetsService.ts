import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import type {
  HomeClipboardEntry,
  HomeClipboardState,
  HomeKillResult,
  HomeListenersResult,
  HomeListeningProcess,
  HomeMachineHealth,
  HomeWeather,
  HomeWeatherPlace,
  HomeWeatherResult,
  HomeWeatherSearchResult,
} from "../../../shared/types/homeWidgets";
import { HOME_WIDGETS_IPC } from "../../../shared/types/homeWidgets";

/**
 * The main-process half of the home page's widgets.
 *
 * Every rule here exists because of the Windows main-thread stall (a 2s
 * synchronous PowerShell probe every 2s made the whole app stutter): nothing
 * in this file spawns synchronously, nothing starts PowerShell, and nothing
 * runs unless a widget asked for it.
 *
 * - Clipboard history polls `clipboard.readText()` once a second, only while
 *   the Clipboard widget is on the home page (`enabled`). A read is a few
 *   hundred microseconds; a slow read (a huge copy) backs the poll off.
 * - Machine health is `os` counters plus one async `statfs`, answered when the
 *   widget asks (every few seconds while it is on screen).
 * - Listening ports come from `netstat -ano` and `tasklist` on Windows (native
 *   tools, ~50 ms and ~400 ms, async) and `lsof` elsewhere, cached for 5 s and
 *   single-flight, so two windows asking at once run one scan.
 * - Weather is two small HTTPS reads to Open-Meteo (free, no key), cached 15
 *   minutes per place.
 */

export type HomeWidgetsClipboard = {
  readText: () => string;
  writeText: (text: string) => void;
  readBuffer: (format: string) => Buffer;
};

export type HomeWidgetsServiceDeps = {
  userDataDir: string;
  clipboard: HomeWidgetsClipboard;
  /** Pids of ADE's own processes, which the kill action refuses. */
  ownPids: () => number[];
  broadcast: (channel: string, payload: unknown) => void;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
  platform?: NodeJS.Platform;
};

const CLIPBOARD_MAX_ENTRIES = 50;
const CLIPBOARD_MAX_CHARS = 20_000;
const CLIPBOARD_POLL_MS = 1_000;
const CLIPBOARD_SLOW_POLL_MS = 3_000;
/** A read slower than this (a multi-megabyte copy) moves the poll to the slow interval. */
const CLIPBOARD_SLOW_READ_MS = 8;
const LISTENERS_TTL_MS = 5_000;
const WEATHER_TTL_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Formats password managers put on the clipboard to say "do not record this".
 * Windows: the clipboard-history opt-outs. macOS: the nspasteboard.org markers.
 */
const CONCEALED_FORMATS: Record<string, string[]> = {
  win32: ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory"],
  darwin: ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"],
};

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i,
];

function shannonBitsPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True for a copy that should not be kept: a known token shape, a private key,
 * or a lone high-entropy string that mixes letters, digits and symbols the way
 * generated passwords do. Hashes and ids (hex, base32) pass, because they use
 * fewer character classes.
 */
export function looksLikeSecret(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (/\s/.test(trimmed) || trimmed.length < 12 || trimmed.length > 128) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(trimmed)).length;
  return classes >= 4 && shannonBitsPerChar(trimmed) >= 3.5;
}

const DEV_PROCESS_NAMES = new Set([
  "node", "bun", "deno", "python", "python3", "pythonw", "py", "ruby", "java", "go", "php", "php-cgi", "dotnet",
  "rails", "puma", "uvicorn", "gunicorn", "beam.smp", "erl", "cargo", "esbuild", "vite", "next-server", "hugo",
  "caddy", "nginx", "httpd", "postgres", "redis-server", "mysqld", "mongod", "docker-proxy", "com.docker.backend",
  "wrangler", "workerd", "air", "uv", "ngrok", "cloudflared", "jekyll", "flask", "rustc",
]);

function processBaseName(name: string | null): string {
  return (name ?? "").toLowerCase().replace(/\.exe$/, "");
}

function runText(command: string, args: string[], timeoutMs = 6_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

function windowsSystemTool(name: string): string {
  // Never PATH's copy: a planted netstat.exe would run on every scan.
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

function portOf(address: string): number | null {
  const match = /:(\d{1,5})$/.exec(address.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** `netstat -ano` rows in the listening state, keyed by owner pid. Locale-proof: a listener's remote end is port 0. */
export function parseNetstatListeners(text: string): Map<number, Set<number>> {
  const byPid = new Map<number, Set<number>>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP/i.test(parts[0]!)) continue;
    const local = parts[1]!;
    const remote = parts[2]!;
    if (!/:0$/.test(remote)) continue;
    const pid = Number(parts.at(-1));
    const port = portOf(local);
    if (!Number.isInteger(pid) || pid <= 0 || port == null) continue;
    const ports = byPid.get(pid) ?? new Set<number>();
    ports.add(port);
    byPid.set(pid, ports);
  }
  return byPid;
}

/** `tasklist /FO CSV /NH`: `"name","pid",…` per line. */
export function parseTasklist(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) names.set(Number(match[2]), match[1]!);
  }
  return names;
}

function parseLsof(text: string): { byPid: Map<number, Set<number>>; names: Map<number, string> } {
  const byPid = new Map<number, Set<number>>();
  const names = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (tag === "c" && pid != null) {
      names.set(pid, value);
    } else if (tag === "n" && pid != null) {
      const port = portOf(value);
      if (port == null) continue;
      const ports = byPid.get(pid) ?? new Set<number>();
      ports.add(port);
      byPid.set(pid, ports);
    }
  }
  return { byPid, names };
}

type WeatherCodeSource = {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    is_day?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
    is_day?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createHomeWidgetsService(deps: HomeWidgetsServiceDeps) {
  const platform = deps.platform ?? process.platform;
  const dir = path.join(deps.userDataDir, "home-widgets");
  const settingsPath = path.join(dir, "settings.json");
  const historyPath = path.join(dir, "clipboard-history.json");

  let clipboardEnabled = false;
  let clipboardPersist = false;
  let entries: HomeClipboardEntry[] = [];
  let skippedSecrets = 0;
  let lastText: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pollInterval = CLIPBOARD_POLL_MS;
  let writeTimer: NodeJS.Timeout | null = null;
  let loaded: Promise<void> | null = null;

  const state = (): HomeClipboardState => ({
    enabled: clipboardEnabled,
    persist: clipboardPersist,
    entries,
    skippedSecrets,
  });

  const announce = () => deps.broadcast(HOME_WIDGETS_IPC.clipboardChanged, state());

  const saveSettings = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ clipboard: { enabled: clipboardEnabled, persist: clipboardPersist } }));
  };

  const scheduleHistoryWrite = () => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const task = clipboardPersist
        ? fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(historyPath, JSON.stringify(entries)))
        : fs.rm(historyPath, { force: true });
      task.catch((error: unknown) => deps.logger?.warn("home.clipboard.persist_failed", { error: String(error) }));
    }, 1_500);
    writeTimer.unref?.();
  };

  const isConcealed = (): boolean => {
    for (const format of CONCEALED_FORMATS[platform] ?? []) {
      try {
        const buffer = deps.clipboard.readBuffer(format);
        if (buffer && buffer.length > 0) {
          // Windows' CanIncludeInClipboardHistory is a DWORD: 0 means "keep out".
          if (format === "CanIncludeInClipboardHistory") {
            if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0) return true;
            continue;
          }
          return true;
        }
      } catch {
        // A format the platform cannot name is simply absent.
      }
    }
    return false;
  };

  const poll = () => {
    const started = performance.now();
    let text: string;
    try {
      text = deps.clipboard.readText() ?? "";
    } catch {
      return;
    }
    const elapsed = performance.now() - started;
    const nextInterval = elapsed > CLIPBOARD_SLOW_READ_MS ? CLIPBOARD_SLOW_POLL_MS : CLIPBOARD_POLL_MS;
    if (nextInterval !== pollInterval) restartPoll(nextInterval);
    if (text === lastText) return;
    const first = lastText == null;
    lastText = text;
    // The first read is what was on the clipboard before ADE looked; it is
    // recorded only when the history is empty, so a relaunch does not re-add it.
    if (!text.trim() || (first && entries.length > 0)) return;
    if (isConcealed() || looksLikeSecret(text)) {
      skippedSecrets += 1;
      announce();
      return;
    }
    const existing = entries.findIndex((entry) => entry.text === text.slice(0, CLIPBOARD_MAX_CHARS));
    const entry: HomeClipboardEntry = existing >= 0
      ? { ...entries[existing]!, copiedAt: Date.now() }
      : { id: randomUUID(), text: text.slice(0, CLIPBOARD_MAX_CHARS), copiedAt: Date.now(), length: text.length };
    entries = [entry, ...entries.filter((_, index) => index !== existing)].slice(0, CLIPBOARD_MAX_ENTRIES);
    announce();
    if (clipboardPersist) scheduleHistoryWrite();
  };

  function restartPoll(interval: number) {
    if (pollTimer) clearInterval(pollTimer);
    pollInterval = interval;
    pollTimer = setInterval(poll, interval);
    pollTimer.unref?.();
  }

  const startPolling = () => {
    if (pollTimer) return;
    lastText = null;
    restartPoll(CLIPBOARD_POLL_MS);
    poll();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    lastText = null;
  };

  /** Reads the saved switches (and history, when kept) once; later calls share the read. */
  const load = (): Promise<void> => {
    loaded ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(settingsPath, "utf8")) as { clipboard?: { enabled?: unknown; persist?: unknown } };
        clipboardEnabled = raw.clipboard?.enabled === true;
        clipboardPersist = raw.clipboard?.persist === true;
      } catch {
        // No settings yet: everything off.
      }
      if (clipboardPersist) {
        try {
          const saved = JSON.parse(await fs.readFile(historyPath, "utf8")) as unknown;
          if (Array.isArray(saved)) {
            entries = saved
              .filter((entry): entry is HomeClipboardEntry =>
                entry != null && typeof entry.id === "string" && typeof entry.text === "string" && typeof entry.copiedAt === "number")
              .slice(0, CLIPBOARD_MAX_ENTRIES)
              .map((entry) => ({ ...entry, length: typeof entry.length === "number" ? entry.length : entry.text.length }));
          }
        } catch {
          // Missing or unreadable history starts empty.
        }
      }
      if (clipboardEnabled) startPolling();
    })();
    return loaded;
  };

  // ── machine ──────────────────────────────────────────────────────

  let lastCpu: { idle: number; total: number } | null = null;
  const cpuTotals = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      const times = cpu.times;
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  };

  const health = async (): Promise<HomeMachineHealth> => {
    const now = cpuTotals();
    let cpuPercent: number | null = null;
    if (lastCpu && now.total > lastCpu.total) {
      const busy = 1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total);
      cpuPercent = Math.max(0, Math.min(100, Math.round(busy * 100)));
    }
    lastCpu = now;
    const diskPath = platform === "win32" ? path.parse(os.homedir()).root : "/";
    let disk: HomeMachineHealth["disk"] = null;
    try {
      const stats = await fs.statfs(diskPath);
      disk = { path: diskPath, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch {
      disk = null;
    }
    const cpus = os.cpus();
    return {
      cpuPercent,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || null,
      memTotalBytes: os.totalmem(),
      memUsedBytes: os.totalmem() - os.freemem(),
      disk,
      uptimeSec: Math.round(os.uptime()),
      hostname: os.hostname(),
      platform,
    };
  };

  const processNames = new Map<number, string>();
  let listenersCache: { at: number; result: HomeListenersResult } | null = null;
  let listenersInFlight: Promise<HomeListenersResult> | null = null;

  const scanListeners = async (): Promise<HomeListenersResult> => {
    let byPid: Map<number, Set<number>>;
    if (platform === "win32") {
      byPid = parseNetstatListeners(await runText(windowsSystemTool("netstat.exe"), ["-ano"]));
      const unknown = [...byPid.keys()].some((pid) => !processNames.has(pid));
      if (unknown) {
        // Names only change when pids do; one tasklist covers every new pid.
        const names = parseTasklist(await runText(windowsSystemTool("tasklist.exe"), ["/FO", "CSV", "/NH"]));
        processNames.clear();
        for (const [pid, name] of names) processNames.set(pid, name);
      }
    } else {
      const parsed = parseLsof(await runText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]));
      byPid = parsed.byPid;
      for (const [pid, name] of parsed.names) processNames.set(pid, name);
    }
    const own = new Set([process.pid, process.ppid, ...deps.ownPids()]);
    const processes: HomeListeningProcess[] = [...byPid.entries()]
      .filter(([pid]) => pid > 4)
      .map(([pid, ports]) => {
        const name = processNames.get(pid) ?? null;
        const base = processBaseName(name);
        return {
          pid,
          name,
          ports: [...ports].sort((a, b) => a - b),
          dev: DEV_PROCESS_NAMES.has(base),
          protected: own.has(pid) || base === "ade" || base === "electron",
        };
      })
      .sort((a, b) => Number(b.dev) - Number(a.dev) || (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
    return { ok: true, processes, scannedAt: Date.now() };
  };

  const listeners = async (): Promise<HomeListenersResult> => {
    if (listenersCache && Date.now() - listenersCache.at < LISTENERS_TTL_MS) return listenersCache.result;
    listenersInFlight ??= scanListeners()
      .catch((error: unknown): HomeListenersResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        listenersCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        listenersInFlight = null;
      });
    return listenersInFlight;
  };

  const kill = async (pid: number): Promise<HomeKillResult> => {
    if (!Number.isInteger(pid) || pid <= 4) return { ok: false, error: "Not a process ADE can stop." };
    // Only a process the last scan listed: the widget cannot be used to stop arbitrary pids.
    const current = await listeners();
    const target = current.ok ? current.processes.find((entry) => entry.pid === pid) : null;
    if (!target) return { ok: false, error: "That process is no longer listening." };
    if (target.protected) return { ok: false, error: "That is one of ADE's own processes." };
    try {
      if (platform === "win32") {
        await runText(resolveTrustedWindowsTool("taskkill"), ["/PID", String(pid), "/T", "/F"]);
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    listenersCache = null;
    return { ok: true };
  };

  // ── weather ──────────────────────────────────────────────────────

  const weatherCache = new Map<string, HomeWeather>();

  const searchPlaces = async (query: string): Promise<HomeWeatherSearchResult> => {
    const name = query.trim().slice(0, 80);
    if (name.length < 2) return { ok: true, places: [] };
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=en&format=json`;
      const raw = (await fetchJson(url)) as { results?: Array<Record<string, unknown>> };
      const places: HomeWeatherPlace[] = (raw.results ?? []).flatMap((row) => {
        const latitude = finite(row.latitude);
        const longitude = finite(row.longitude);
        if (latitude == null || longitude == null || typeof row.name !== "string") return [];
        const detail = [row.admin1, row.country].filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
        return [{
          name: row.name,
          detail: detail || null,
          latitude,
          longitude,
          timezone: typeof row.timezone === "string" ? row.timezone : null,
        }];
      });
      return { ok: true, places };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const getWeather = async (args: { latitude: number; longitude: number }): Promise<HomeWeatherResult> => {
    const latitude = finite(args?.latitude);
    const longitude = finite(args?.longitude);
    if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return { ok: false, error: "Invalid place." };
    }
    // Coarse on purpose: two decimals is about a kilometre.
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return { ok: true, weather: cached };
    try {
      const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}`
        + "&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m"
        + "&hourly=temperature_2m,weather_code,is_day&forecast_hours=13"
        + "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5";
      const raw = (await fetchJson(url)) as WeatherCodeSource;
      const temperatureC = finite(raw.current?.temperature_2m);
      if (temperatureC == null) return { ok: false, error: "No current weather for that place." };
      const daily = raw.daily ?? {};
      const days = (daily.time ?? []).flatMap((date, index) => {
        const maxC = finite(daily.temperature_2m_max?.[index]);
        const minC = finite(daily.temperature_2m_min?.[index]);
        const code = finite(daily.weather_code?.[index]);
        return maxC == null || minC == null || code == null ? [] : [{ date, code, maxC, minC }];
      });
      const hourly = raw.hourly ?? {};
      const hours = (hourly.time ?? []).flatMap((time, index) => {
        const temp = finite(hourly.temperature_2m?.[index]);
        const code = finite(hourly.weather_code?.[index]);
        // Local wall time at the place, "2026-10-07T17:00": keep the hour as written.
        const hour = Number(/T(\d{2}):/.exec(time)?.[1]);
        return temp == null || code == null || !Number.isFinite(hour) ? [] : [{ hour, code, tempC: temp, isDay: hourly.is_day?.[index] !== 0 }];
      }).slice(1, 13);
      const weather: HomeWeather = {
        temperatureC,
        apparentC: finite(raw.current?.apparent_temperature),
        code: finite(raw.current?.weather_code) ?? 0,
        isDay: raw.current?.is_day !== 0,
        windKph: finite(raw.current?.wind_speed_10m),
        todayMaxC: days[0]?.maxC ?? null,
        todayMinC: days[0]?.minC ?? null,
        days,
        hours,
        fetchedAt: Date.now(),
      };
      weatherCache.set(key, weather);
      return { ok: true, weather };
    } catch (error) {
      if (cached) return { ok: true, weather: cached };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    load,
    clipboard: {
      getState: async () => {
        await load();
        return state();
      },
      configure: async (args: { enabled?: boolean; persist?: boolean }) => {
        await load();
        if (typeof args?.enabled === "boolean" && args.enabled !== clipboardEnabled) {
          clipboardEnabled = args.enabled;
          if (clipboardEnabled) startPolling();
          else stopPolling();
        }
        if (typeof args?.persist === "boolean" && args.persist !== clipboardPersist) {
          clipboardPersist = args.persist;
          scheduleHistoryWrite();
        }
        await saveSettings().catch((error: unknown) => deps.logger?.warn("home.clipboard.settings_failed", { error: String(error) }));
        announce();
        return state();
      },
      clear: async () => {
        await load();
        entries = [];
        skippedSecrets = 0;
        scheduleHistoryWrite();
        announce();
        return state();
      },
      remove: async (id: string) => {
        await load();
        entries = entries.filter((entry) => entry.id !== id);
        scheduleHistoryWrite();
        announce();
        return state();
      },
      copy: async (id: string) => {
        const entry = entries.find((candidate) => candidate.id === id);
        if (!entry) return false;
        deps.clipboard.writeText(entry.text);
        return true;
      },
    },
    machine: { health, listeners, kill },
    weather: { search: searchPlaces, get: getWeather },
    dispose: () => {
      stopPolling();
      if (writeTimer) clearTimeout(writeTimer);
    },
  };
}

export type HomeWidgetsService = ReturnType<typeof createHomeWidgetsService>;
