import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import type {
  HomeClipboardEntry,
  HomeClipboardImage,
  HomeClipboardState,
  HomeKillResult,
  HomeListenersResult,
  HomeListeningProcess,
  HomeMachineDetail,
  HomeMachineDrive,
  HomeMachineHealth,
  HomeMachineProcessGroup,
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
 * - Clipboard history polls `clipboard.readText()` and `availableFormats()`
 *   once a second, only while the Clipboard widget is on the home page
 *   (`enabled`). Both are tens of microseconds; a slow read (a huge copy)
 *   backs the poll off. An image is read (≈5 ms for a 1440p screenshot) only
 *   when it changed: the PNG copy apps put beside it is compared first
 *   (≈0.03 ms), and an image with no PNG copy (Print Screen) is re-read at
 *   most every few seconds.
 * - Machine health is `os` counters plus one async `statfs`, answered when the
 *   widget asks (every few seconds while it is on screen).
 * - Listening ports come from `netstat -ano` and `tasklist` on Windows (native
 *   tools, ~50 ms and ~400 ms, async) and `lsof` elsewhere, cached for 5 s and
 *   single-flight, so two windows asking at once run one scan.
 * - Weather is two small HTTPS reads to Open-Meteo (free, no key), cached 15
 *   minutes per place.
 */

/** An image on the clipboard, read once, with what the history needs from it. */
export type HomeClipboardImageRead = {
  width: number;
  height: number;
  /** Raw pixels, for the content hash. */
  bitmap: () => Buffer;
  /** The whole image as PNG (the encode costs ~15 ms for 1440p; called once per new image). */
  png: () => Buffer;
  /** A copy whose long side is at most `maxPx`, as PNG or JPEG bytes. */
  thumbnail: (maxPx: number) => { mime: "image/png" | "image/jpeg"; data: Buffer };
};

export type HomeWidgetsClipboard = {
  readText: () => string;
  writeText: (text: string) => void;
  readBuffer: (format: string) => Buffer;
  availableFormats?: () => string[];
  /** Null when the clipboard has no image (or it is empty). */
  readImage?: () => HomeClipboardImageRead | null;
  writeImage?: (png: Buffer) => boolean;
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
/** Full images kept for copying back, in memory (and on disk when kept): oldest go first. */
const CLIPBOARD_IMAGE_BYTES_CAP = 50 * 1024 * 1024;
const CLIPBOARD_MAX_IMAGES = 30;
const CLIPBOARD_THUMB_PX = 320;
/** An image with no PNG copy beside it is re-read at most this often to notice a new one. */
const CLIPBOARD_IMAGE_REREAD_MS = 3_000;
const CLIPBOARD_IMAGE_SLOW_REREAD_MS = 10_000;
/** The PNG format apps put beside a bitmap: Windows' registered "PNG", macOS' UTI. */
const PNG_CLIPBOARD_FORMAT: Partial<Record<NodeJS.Platform, string>> = { win32: "PNG", darwin: "public.png" };
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

/**
 * `netstat -e` (Windows): the first row with two counters is bytes received
 * and sent since boot. The row's label is localized; its place is not.
 */
export function parseNetstatBytes(text: string): { rx: number; tx: number } | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\S.*?\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
    if (match) return { rx: Number(match[1]), tx: Number(match[2]) };
  }
  return null;
}

/** `netstat -ib` (macOS): one `<Link#n>` row per interface; bytes in and out are 5th and 2nd from the end. */
export function parseNetstatInterfaceBytes(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || !/^<Link#\d+>$/.test(parts[2] ?? "") || /^lo\d*$/.test(parts[0] ?? "")) continue;
    const inBytes = Number(parts.at(-5));
    const outBytes = Number(parts.at(-2));
    if (!Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    rx += inBytes;
    tx += outBytes;
    found = true;
  }
  return found ? { rx, tx } : null;
}

/** `/proc/net/dev` (Linux): receive bytes are the first counter, transmit bytes the ninth. */
export function parseProcNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === "lo") continue;
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0]!;
    tx += fields[8]!;
    found = true;
  }
  return found ? { rx, tx } : null;
}

function groupProcesses(rows: Array<{ name: string; memBytes: number; cpu: number | null }>): HomeMachineProcessGroup[] {
  const groups = new Map<string, HomeMachineProcessGroup>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const group = groups.get(key) ?? { name: row.name, count: 0, memBytes: 0, cpuPercent: row.cpu == null ? null : 0 };
    group.count += 1;
    group.memBytes += row.memBytes;
    if (group.cpuPercent != null && row.cpu != null) group.cpuPercent += row.cpu;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, cpuPercent: group.cpuPercent == null ? null : Math.round(group.cpuPercent * 10) / 10 }))
    .sort((a, b) => b.memBytes - a.memBytes);
}

/** `tasklist /FO CSV /NH`, grouped by name: memory is the last column ("123,456 K", separators vary by locale). */
export function parseTasklistMemory(text: string): HomeMachineProcessGroup[] {
  const rows: Array<{ name: string; memBytes: number; cpu: null }> = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = [...line.trim().matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
    if (cells.length < 5 || !/^\d+$/.test(cells[1]!)) continue;
    const pid = Number(cells[1]);
    const kb = Number(cells[cells.length - 1]!.replace(/[^\d]/g, ""));
    // The idle and kernel pseudo-processes are not something to act on.
    if (pid <= 4 || !Number.isFinite(kb) || kb <= 0) continue;
    rows.push({ name: cells[0]!.replace(/\.exe$/i, ""), memBytes: kb * 1024, cpu: null });
  }
  return groupProcesses(rows);
}

/** `ps -Ao rss=,pcpu=,comm=` (macOS, Linux), grouped by name; CPU becomes a share of all cores. */
export function parsePsList(text: string, cpuCount: number): HomeMachineProcessGroup[] {
  const rows: Array<{ name: string; memBytes: number; cpu: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const name = path.posix.basename(match[3]!.trim());
    rows.push({ name, memBytes: Number(match[1]) * 1024, cpu: Number(match[2]) / Math.max(1, cpuCount) });
  }
  return groupProcesses(rows);
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

  const imagesDir = path.join(dir, "clipboard-images");
  const pngFormat = PNG_CLIPBOARD_FORMAT[platform] ?? null;

  let clipboardEnabled = false;
  let clipboardPersist = false;
  let entries: HomeClipboardEntry[] = [];
  let skippedSecrets = 0;
  /** What the last poll saw: "t:<text>", "i:<image key>" or "" for nothing. Null before the first poll. */
  let lastSeen: string | null = null;
  let lastFormats = "";
  /** When an image with no PNG copy was last read, and how long that read took. */
  let lastImageReadAt = 0;
  let lastImageReadMs = 0;
  /** Full PNGs of image entries, by hash. A kept history reads the rest from disk on copy. */
  const fullImages = new Map<string, Buffer>();
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

  const imageFile = (hash: string) => path.join(imagesDir, `${hash}.png`);

  /** Writes the history and the image files it names, and removes image files it no longer names. */
  const writeHistory = async () => {
    await fs.mkdir(imagesDir, { recursive: true });
    const wanted = new Set(entries.flatMap((entry) => (entry.image ? [`${entry.image.hash}.png`] : [])));
    for (const entry of entries) {
      if (!entry.image) continue;
      const full = fullImages.get(entry.image.hash);
      if (!full) continue;
      const file = imageFile(entry.image.hash);
      const exists = await fs.stat(file).then(() => true, () => false);
      if (!exists) await fs.writeFile(file, full);
    }
    for (const name of await fs.readdir(imagesDir).catch(() => [] as string[])) {
      if (!wanted.has(name)) await fs.rm(path.join(imagesDir, name), { force: true });
    }
    await fs.writeFile(historyPath, JSON.stringify(entries));
  };

  const scheduleHistoryWrite = () => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const task = clipboardPersist
        ? writeHistory()
        : Promise.all([fs.rm(historyPath, { force: true }), fs.rm(imagesDir, { recursive: true, force: true })]);
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

  /**
   * Puts `entry` first and drops what is over the caps: 50 entries, and at
   * most 30 pictures and 50 MB of full images (the oldest pictures go first).
   */
  const pushEntry = (entry: HomeClipboardEntry, replacing: number) => {
    let images = 0;
    let imageBytes = 0;
    entries = [entry, ...entries.filter((_, index) => index !== replacing)]
      .slice(0, CLIPBOARD_MAX_ENTRIES)
      .filter((candidate) => {
        if (!candidate.image) return true;
        images += 1;
        imageBytes += candidate.image.bytes;
        return candidate === entry || (images <= CLIPBOARD_MAX_IMAGES && imageBytes <= CLIPBOARD_IMAGE_BYTES_CAP);
      });
    const kept = new Set(entries.flatMap((candidate) => (candidate.image ? [candidate.image.hash] : [])));
    for (const hash of [...fullImages.keys()]) if (!kept.has(hash)) fullImages.delete(hash);
    announce();
    if (clipboardPersist) scheduleHistoryWrite();
  };

  /** A cheap identity for the PNG copy on the clipboard: its length and a hash of its two ends. */
  const pngProbe = (): { key: string; png: Buffer } | null => {
    if (!pngFormat) return null;
    let png: Buffer;
    try {
      png = deps.clipboard.readBuffer(pngFormat);
    } catch {
      return null;
    }
    if (!png || png.length < 8) return null;
    const edge = 64 * 1024;
    const hash = createHash("sha1").update(png.subarray(0, edge));
    if (png.length > edge) hash.update(png.subarray(Math.max(edge, png.length - edge)));
    return { key: `png:${png.length}:${hash.digest("hex")}`, png };
  };

  const pixelHash = (read: HomeClipboardImageRead) =>
    createHash("sha1").update(`${read.width}x${read.height}:`).update(read.bitmap()).digest("hex");

  const recordImage = (read: HomeClipboardImageRead, hash: string, pngCopy: Buffer | null) => {
    const existing = entries.findIndex((entry) => entry.image?.hash === hash);
    if (existing >= 0) {
      pushEntry({ ...entries[existing]!, copiedAt: Date.now() }, existing);
      return;
    }
    const full = pngCopy ?? read.png();
    // One picture bigger than the whole budget is not kept.
    if (full.length === 0 || full.length > CLIPBOARD_IMAGE_BYTES_CAP) return;
    const thumb = read.thumbnail(CLIPBOARD_THUMB_PX);
    const image: HomeClipboardImage = {
      thumb: `data:${thumb.mime};base64,${thumb.data.toString("base64")}`,
      width: read.width,
      height: read.height,
      bytes: full.length,
      hash,
    };
    fullImages.set(hash, full);
    pushEntry({ id: randomUUID(), text: "", image, copiedAt: Date.now(), length: 0 }, -1);
  };

  const recordText = (text: string) => {
    if (isConcealed() || looksLikeSecret(text)) {
      skippedSecrets += 1;
      announce();
      return;
    }
    const kept = text.slice(0, CLIPBOARD_MAX_CHARS);
    const existing = entries.findIndex((entry) => !entry.image && entry.text === kept);
    const entry: HomeClipboardEntry = existing >= 0
      ? { ...entries[existing]!, copiedAt: Date.now() }
      : { id: randomUUID(), text: kept, copiedAt: Date.now(), length: text.length };
    pushEntry(entry, existing);
  };

  const poll = () => {
    const started = performance.now();
    let text: string;
    let formats: string[];
    try {
      text = deps.clipboard.readText() ?? "";
      formats = deps.clipboard.availableFormats?.() ?? [];
    } catch {
      return;
    }
    const elapsed = performance.now() - started;
    const nextInterval = elapsed > CLIPBOARD_SLOW_READ_MS ? CLIPBOARD_SLOW_POLL_MS : CLIPBOARD_POLL_MS;
    if (nextInterval !== pollInterval) restartPoll(nextInterval);
    const formatKey = formats.join("|");
    const formatsChanged = formatKey !== lastFormats;
    lastFormats = formatKey;
    const first = lastSeen == null;
    // The first read is what was on the clipboard before ADE looked; it is
    // recorded only when the history is empty, so a relaunch does not re-add it.
    const skipFirst = first && entries.length > 0;

    // Text wins: a spreadsheet or document copy also carries a picture of itself.
    const imageOnly = !text.trim() && deps.clipboard.readImage != null && formats.some((format) => format.startsWith("image/"));
    if (!imageOnly) {
      const seen = text.trim() ? `t:${text}` : "";
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (seen && !skipFirst) recordText(text);
      return;
    }

    // An image. With a PNG copy beside it, compare that (cheap) and read the picture only when it changed.
    const probe = pngProbe();
    if (probe) {
      const seen = `i:${probe.key}`;
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (skipFirst) return;
    } else {
      // No PNG copy (Print Screen, Paint): re-read the picture now and then, at once when the formats changed.
      const wait = lastImageReadMs > 20 ? CLIPBOARD_IMAGE_SLOW_REREAD_MS : CLIPBOARD_IMAGE_REREAD_MS;
      if (!first && !formatsChanged && lastSeen?.startsWith("i:") && Date.now() - lastImageReadAt < wait) return;
    }
    const readStarted = performance.now();
    let read: HomeClipboardImageRead | null = null;
    try {
      read = deps.clipboard.readImage?.() ?? null;
    } catch {
      read = null;
    }
    lastImageReadAt = Date.now();
    if (!read) {
      if (!probe) lastSeen = "";
      return;
    }
    const hash = pixelHash(read);
    lastImageReadMs = performance.now() - readStarted;
    if (!probe) {
      const seen = `i:bmp:${hash}`;
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (skipFirst) return;
    }
    if (isConcealed()) {
      skippedSecrets += 1;
      announce();
      return;
    }
    recordImage(read, hash, probe?.png ?? null);
  };

  function restartPoll(interval: number) {
    if (pollTimer) clearInterval(pollTimer);
    pollInterval = interval;
    pollTimer = setInterval(poll, interval);
    pollTimer.unref?.();
  }

  const startPolling = () => {
    if (pollTimer) return;
    lastSeen = null;
    restartPoll(CLIPBOARD_POLL_MS);
    poll();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    lastSeen = null;
  };

  const validImage = (value: unknown): value is HomeClipboardImage => {
    const image = value as HomeClipboardImage | null;
    return image != null && typeof image.thumb === "string" && image.thumb.startsWith("data:image/")
      && typeof image.hash === "string" && /^[0-9a-f]{40}$/.test(image.hash)
      && typeof image.width === "number" && typeof image.height === "number" && typeof image.bytes === "number";
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
                entry != null && typeof entry.id === "string" && typeof entry.text === "string" && typeof entry.copiedAt === "number"
                && (entry.image === undefined || validImage(entry.image)))
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

  let lastCpu: { idle: number; total: number; cores: Array<{ idle: number; total: number }> } | null = null;
  const cpuTimes = (cpus: os.CpuInfo[]) => {
    let idle = 0;
    let total = 0;
    const cores = cpus.map((cpu) => {
      const times = cpu.times;
      const coreTotal = times.user + times.nice + times.sys + times.idle + times.irq;
      idle += times.idle;
      total += coreTotal;
      return { idle: times.idle, total: coreTotal };
    });
    return { idle, total, cores };
  };
  const busyPercent = (now: { idle: number; total: number }, before: { idle: number; total: number } | undefined) => {
    if (!before || now.total <= before.total) return null;
    const busy = 1 - (now.idle - before.idle) / (now.total - before.total);
    return Math.max(0, Math.min(100, Math.round(busy * 100)));
  };

  // Detail state: the last minute of readings, kept while the widget asks.
  type Sample = { at: number; cpu: number; rx: number | null; tx: number | null };
  let samples: Sample[] = [];
  let lastNet: { at: number; rx: number; tx: number } | null = null;
  let lastDetail: { at: number; detail: HomeMachineDetail } | null = null;
  let drivesCache: { at: number; drives: HomeMachineDrive[] } | null = null;
  /** Drive letters whose statfs did not answer (a sleeping network share): never asked again. */
  const stalledDrives = new Set<string>();
  let processCache: { at: number; groups: HomeMachineProcessGroup[] } | null = null;
  let processInFlight: Promise<void> | null = null;

  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
    Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.())]);

  const statDrive = async (drivePath: string): Promise<HomeMachineDrive | null> => {
    const result = await withTimeout(fs.statfs(drivePath).catch(() => null), 1_500);
    if (result === "timeout") {
      stalledDrives.add(drivePath);
      return null;
    }
    if (!result || result.blocks <= 0) return null;
    return { path: drivePath, totalBytes: result.blocks * result.bsize, freeBytes: result.bavail * result.bsize };
  };

  /** Fixed drives (Windows letters C–Z) or mounted volumes (macOS), re-listed every 30 s. */
  const readDrives = async (): Promise<HomeMachineDrive[]> => {
    if (drivesCache && Date.now() - drivesCache.at < 30_000) return drivesCache.drives;
    let candidates: string[];
    if (platform === "win32") {
      candidates = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => !stalledDrives.has(drive));
    } else if (platform === "darwin") {
      const volumes = await fs.readdir("/Volumes", { withFileTypes: true }).catch(() => []);
      // "Macintosh HD" is a symlink to /; real mounts are directories.
      candidates = ["/", ...volumes.filter((entry) => entry.isDirectory()).map((entry) => path.posix.join("/Volumes", entry.name))];
    } else {
      candidates = ["/"];
    }
    const drives = (await Promise.all(candidates.map(statDrive))).filter((drive): drive is HomeMachineDrive => drive != null);
    drivesCache = { at: Date.now(), drives };
    return drives;
  };

  /** Bytes received and sent since boot, from native tools; null where it cannot be read. */
  const readNetTotals = async (): Promise<{ rx: number; tx: number } | null> => {
    try {
      if (platform === "win32") return parseNetstatBytes(await runText(windowsSystemTool("netstat.exe"), ["-e"], 4_000));
      if (platform === "darwin") return parseNetstatInterfaceBytes(await runText("/usr/sbin/netstat", ["-ib"], 4_000));
      return parseProcNetDev(await fs.readFile("/proc/net/dev", "utf8"));
    } catch {
      return null;
    }
  };

  const refreshProcesses = () => {
    if (processInFlight || (processCache && Date.now() - processCache.at < 10_000)) return;
    processInFlight = (async () => {
      try {
        const groups = platform === "win32"
          ? parseTasklistMemory(await runText(windowsSystemTool("tasklist.exe"), ["/FO", "CSV", "/NH"]))
          : parsePsList(await runText("ps", ["-Ao", "rss=,pcpu=,comm="]), os.cpus().length);
        processCache = { at: Date.now(), groups: groups.slice(0, 12) };
      } catch (error) {
        deps.logger?.warn("home.machine.processes_failed", { error: String(error) });
        processCache = { at: Date.now(), groups: processCache?.groups ?? [] };
      }
    })().finally(() => {
      processInFlight = null;
    });
  };

  const readDetail = async (cpuPercent: number | null, cores: number[]): Promise<HomeMachineDetail> => {
    const at = Date.now();
    // Two windows asking at once share one reading.
    if (lastDetail && at - lastDetail.at < 1_500) return lastDetail.detail;
    refreshProcesses();
    const [drives, totals] = await Promise.all([readDrives(), readNetTotals()]);
    let rx: number | null = null;
    let tx: number | null = null;
    if (totals && lastNet && at > lastNet.at && totals.rx >= lastNet.rx && totals.tx >= lastNet.tx && at - lastNet.at < 15_000) {
      const seconds = (at - lastNet.at) / 1_000;
      rx = Math.round((totals.rx - lastNet.rx) / seconds);
      tx = Math.round((totals.tx - lastNet.tx) / seconds);
    }
    if (totals) lastNet = { at, ...totals };
    // A gap (the widget was off screen) starts the minute over rather than drawing a straight line across it.
    if (samples.length > 0 && at - samples[samples.length - 1]!.at > 12_000) samples = [];
    if (cpuPercent != null) samples.push({ at, cpu: cpuPercent, rx, tx });
    samples = samples.filter((sample) => at - sample.at <= 62_000);
    const netSamples = samples.filter((sample) => sample.rx != null && sample.tx != null);
    const detail: HomeMachineDetail = {
      cores,
      cpuHistory: samples.map((sample) => sample.cpu),
      netHistory: netSamples.length > 0 ? { rx: netSamples.map((sample) => sample.rx!), tx: netSamples.map((sample) => sample.tx!) } : null,
      net: rx != null && tx != null ? { rxBps: rx, txBps: tx } : null,
      drives,
      processes: processCache?.groups ?? null,
      memAvailableBytes: os.freemem(),
    };
    lastDetail = { at, detail };
    return detail;
  };

  const health = async (args?: { detail?: boolean }): Promise<HomeMachineHealth> => {
    const cpus = os.cpus();
    const now = cpuTimes(cpus);
    const cpuPercent = busyPercent(now, lastCpu ?? undefined);
    const cores = now.cores.map((core, index) => busyPercent(core, lastCpu?.cores[index]) ?? 0);
    lastCpu = now;
    const diskPath = platform === "win32" ? path.parse(os.homedir()).root : "/";
    let disk: HomeMachineHealth["disk"] = null;
    try {
      const stats = await fs.statfs(diskPath);
      disk = { path: diskPath, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch {
      disk = null;
    }
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
      ...(args?.detail ? { detail: await readDetail(cpuPercent, cores) } : {}),
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
        fullImages.clear();
        skippedSecrets = 0;
        scheduleHistoryWrite();
        announce();
        return state();
      },
      remove: async (id: string) => {
        await load();
        const removed = entries.find((entry) => entry.id === id);
        entries = entries.filter((entry) => entry.id !== id);
        if (removed?.image) fullImages.delete(removed.image.hash);
        scheduleHistoryWrite();
        announce();
        return state();
      },
      copy: async (id: string) => {
        const entry = entries.find((candidate) => candidate.id === id);
        if (!entry) return false;
        if (!entry.image) {
          deps.clipboard.writeText(entry.text);
          return true;
        }
        const full = fullImages.get(entry.image.hash)
          ?? await fs.readFile(imageFile(entry.image.hash)).catch(() => null);
        return Boolean(full && deps.clipboard.writeImage?.(full));
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
