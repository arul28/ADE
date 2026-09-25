/**
 * First-party favicons for the Sources list.
 *
 * The icon is fetched from the site the agent already visited, directly by the
 * machine running the brain — never through a third-party favicon service,
 * which would learn every domain a chat touched. The result is a small
 * `data:` URL the renderer can draw under its CSP (`img-src … data:`), or null,
 * in which case every client keeps drawing the domain initial.
 *
 * Resolution, per host: GET `https://<host>/`, read `<link rel="icon" |
 * "shortcut icon" | "apple-touch-icon">` (preferring ~32px, then SVG), else
 * `/favicon.ico`. Every hop is HTTPS on port 443, its DNS answer must be public
 * unicast (checked before connecting and pinned for the connection, so a
 * rebinding answer cannot swap in), at most 3 redirects with the same checks
 * per hop, a 3 s wall clock per request, 64 KB per icon, and the body must be a
 * real image by its bytes and served as `image/*`. SVG is accepted only when it
 * carries no script, event handler, `javascript:` URL, or foreign object; it is
 * drawn through `<img>`, which never runs SVG script anyway.
 *
 * Results are cached on disk under `<ADE home>/cache/favicons/<sha1(host)>.json`
 * (7 days for an icon, 1 day for "none"), mirrored in a bounded memory map,
 * concurrent requests for one host share a promise, and the directory is
 * pruned oldest-first past a size cap. Network failures (offline, timeout) are
 * remembered in memory only, briefly, so a flaky connection does not blank a
 * site's icon for a day.
 */
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import type http from "node:http";
import net from "node:net";
import path from "node:path";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { isPublicFaviconAddress, pinnedLookup } from "../net/publicHostGuard";

export const SOURCE_FAVICON_LIMITS = {
  timeoutMs: 3_000,
  maxIconBytes: 64 * 1024,
  /** Only `<head>` matters; a longer page is read this far and parsed as is. */
  maxHtmlBytes: 256 * 1024,
  maxRedirects: 3,
  positiveTtlMs: 7 * 24 * 60 * 60_000,
  negativeTtlMs: 24 * 60 * 60_000,
  transientTtlMs: 10 * 60_000,
  maxCacheBytes: 8 * 1024 * 1024,
  maxMemoryEntries: 1_000,
  maxHostsPerCall: 48,
  maxConcurrentFetches: 6,
  /** Declared icons tried before `/favicon.ico`. */
  maxCandidates: 3,
} as const;

export type SourceFaviconLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export type SourceFaviconFetchRequest = {
  url: URL;
  /** The vetted address the connection must use (DNS answer pinned). */
  address: string;
  family: 4 | 6;
  accept: string;
  /** Stop reading here; the body is at most this long. */
  maxBytes: number;
  signal: AbortSignal;
};

export type SourceFaviconFetchResponse = {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** The resource was longer than `maxBytes` and `body` is its first `maxBytes`. */
  truncated?: boolean;
};

export type SourceFaviconFetch = (request: SourceFaviconFetchRequest) => Promise<SourceFaviconFetchResponse>;

export type SourceFaviconServiceOptions = {
  /** Directory for the disk cache; null keeps the cache in memory only. */
  cacheDir: string | null;
  lookup?: SourceFaviconLookup;
  fetch?: SourceFaviconFetch;
  now?: () => number;
  timeoutMs?: number;
  maxCacheBytes?: number;
};

export type ResolveSourceFaviconsArgs = {
  domains?: unknown;
  domain?: unknown;
  url?: unknown;
};

export type ResolveSourceFaviconsResult = {
  /** Keyed by each input exactly as given (trimmed): a data URL, or null. */
  icons: Record<string, string | null>;
};

export type SourceFaviconService = {
  resolve(args: ResolveSourceFaviconsArgs | null | undefined): Promise<ResolveSourceFaviconsResult>;
  resolveHost(host: string): Promise<string | null>;
};

/** The destination is not a public HTTPS host: never retried, cached as "none". */
class FaviconBlockedError extends Error {}
/** The destination answered but gave nothing usable (too large, not an image). */
class FaviconRejectedError extends Error {}

type Outcome = { kind: "icon"; dataUrl: string } | { kind: "none" } | { kind: "transient" };

type CacheFile = { v: 1; host: string; fetchedAt: number; dataUrl: string | null };

const ICON_ACCEPT = "image/avif,image/webp,image/png,image/svg+xml,image/x-icon,image/*;q=0.8";
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const USER_AGENT = "Mozilla/5.0 (compatible; ADE-Favicon/1.0)";

// ── Host and URL policy ───────────────────────────────────────────────────

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return true;
  if (hostname === "localhost" || /\.(?:localhost|local|internal|intranet|lan|home\.arpa)$/.test(hostname)) return true;
  const literal = stripBrackets(hostname);
  if (net.isIP(literal)) return !isPublicFaviconAddress(literal);
  // A single-label name ("router", "nas") resolves through local search
  // domains to something on the LAN.
  if (!hostname.includes(".")) return true;
  return !/^[a-z0-9.-]+$/.test(hostname);
}

/**
 * The host whose favicon to fetch, from a bare domain or an http(s) URL. Null
 * for anything that is not a public DNS name or public IP literal.
 */
export function normalizeFaviconHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return isBlockedHostname(hostname) ? null : hostname;
}

/**
 * Checks one hop before any connection: HTTPS, port 443, no credentials, a
 * public name, and every DNS answer public. Returns the address to pin.
 */
async function vetHop(url: URL, lookup: SourceFaviconLookup): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "https:") throw new FaviconBlockedError("Favicons are fetched over HTTPS only.");
  if (url.username || url.password) throw new FaviconBlockedError("Favicon URLs cannot carry credentials.");
  if (url.port && url.port !== "443") throw new FaviconBlockedError("Favicon URLs must use port 443.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(hostname)) throw new FaviconBlockedError("Favicon host is not public.");
  const literal = stripBrackets(hostname);
  const literalFamily = net.isIP(literal);
  if (literalFamily) return { address: literal, family: literalFamily as 4 | 6 };
  const answers = await lookup(hostname);
  if (!answers.length) throw new Error("Favicon host did not resolve.");
  if (answers.some((answer) => !isPublicFaviconAddress(answer.address))) {
    throw new FaviconBlockedError("Favicon host resolves to a non-public address.");
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

// ── Default transport ─────────────────────────────────────────────────────

const defaultLookup: SourceFaviconLookup = async (hostname) =>
  await dns.lookup(hostname, { all: true, verbatim: true });

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

const defaultFetch: SourceFaviconFetch = (request) =>
  new Promise<SourceFaviconFetchResponse>((resolve, reject) => {
    const req = https.request(request.url, {
      method: "GET",
      headers: { accept: request.accept, "accept-encoding": "identity", "user-agent": USER_AGENT },
      signal: request.signal,
      // Connect to the vetted address; TLS still verifies the certificate for
      // the hostname, so the pin cannot be used to impersonate another site.
      lookup: pinnedLookup(request.address, request.family),
    }, (response) => {
      const headers = flattenHeaders(response.headers);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (truncated: boolean) => {
        settled = true;
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
      };
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > request.maxBytes) {
          // Keep the first `maxBytes` and hang up: a page's <head> or an ICO's
          // directory is all the caller can use past this point.
          chunks.push(chunk.subarray(0, chunk.length - (size - request.maxBytes)));
          done(true);
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (!settled) done(false);
      });
      response.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.once("error", reject);
    req.end();
  });

// ── HTML icon discovery ───────────────────────────────────────────────────

function htmlAttribute(tag: string, attribute: string): string | null {
  const match = tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value == null ? null : value.replace(/&amp;/gi, "&").trim();
}

type IconCandidate = { href: string; score: number; order: number };

function largestDeclaredSize(sizes: string | null): number | "any" | null {
  if (!sizes) return null;
  if (/\bany\b/i.test(sizes)) return "any";
  let best: number | null = null;
  for (const match of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
    const size = Math.max(Number(match[1]), Number(match[2]));
    // Closest to 32 wins among several declared sizes on one tag.
    if (best === null || Math.abs(size - 32) < Math.abs(best - 32)) best = size;
  }
  return best;
}

/** Lower is better: ~32px raster, then SVG, then undeclared, then small, then large, then touch icons. */
function scoreIcon(rel: string[], type: string, href: string, sizes: string | null): number {
  const svg = type === "image/svg+xml" || /\.svg(?:$|[?#])/i.test(href) || /^data:image\/svg\+xml/i.test(href);
  const size = largestDeclaredSize(sizes);
  const numeric = typeof size === "number" ? size : 0;
  if (rel.some((token) => token.startsWith("apple-touch-icon"))) return 50 + numeric / 1_000;
  if (typeof size === "number" && size >= 32 && size <= 64) return 0 + numeric / 1_000;
  if (svg || size === "any") return 10;
  if (size === null) return 20;
  if (numeric < 32) return 30 + (32 - numeric) / 1_000;
  return 40 + numeric / 1_000;
}

/** Declared icons in preference order, as absolute https or inline `data:image` hrefs. */
export function extractFaviconCandidates(html: string, pageUrl: URL): string[] {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const candidates: IconCandidate[] = [];
  let order = 0;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (htmlAttribute(tag, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const isIcon = rel.includes("icon") || rel.some((token) => token.startsWith("apple-touch-icon"));
    if (!isIcon) continue;
    const rawHref = htmlAttribute(tag, "href");
    if (!rawHref) continue;
    let href: string;
    if (/^data:image\//i.test(rawHref)) {
      href = rawHref;
    } else {
      try {
        const resolved = new URL(rawHref, pageUrl);
        if (resolved.protocol !== "https:") continue;
        resolved.hash = "";
        href = resolved.toString();
      } catch {
        continue;
      }
    }
    const type = (htmlAttribute(tag, "type") ?? "").toLowerCase();
    candidates.push({ href, score: scoreIcon(rel, type, href, htmlAttribute(tag, "sizes")), order: order++ });
  }
  candidates.sort((left, right) => left.score - right.score || left.order - right.order);
  const unique: string[] = [];
  for (const candidate of candidates) {
    if (!unique.includes(candidate.href)) unique.push(candidate.href);
  }
  return unique;
}

// ── Image validation ──────────────────────────────────────────────────────

/** The image type by its bytes; null when the body is not an image we draw. */
export function sniffFaviconMime(body: Buffer): string | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && /^GIF8[79]a$/.test(body.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (body.length >= 6 && body[0] === 0 && body[1] === 0 && (body[2] === 1 || body[2] === 2) && body[3] === 0) {
    return "image/x-icon";
  }
  const head = body.subarray(0, 1_024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * Whether an SVG is inert. `<img>` never executes SVG script or loads its
 * external resources, so this is belt and braces for any other consumer.
 */
export function isInertSvg(svg: string): boolean {
  return !/<script\b|<foreignObject\b|<iframe\b|<embed\b|<object\b|\son[a-z]+\s*=|javascript:|<!ENTITY/i.test(svg);
}

/**
 * One image out of a multi-size ICO: the entry closest to 32px (at least 16px)
 * whose bytes are all present. Sites ship 100-200 KB ICOs holding a 256px
 * frame; the directory sits at the front, so the small frames usually arrive
 * within the first 64 KB even when the file is cut there. PNG frames come back
 * as PNG, bitmap frames re-wrapped as a one-entry ICO.
 */
/** Lower is better: the smallest frame of at least 32px, else the largest smaller one. */
function icoFrameRank(size: number): number {
  return size >= 32 ? size - 32 : 1_000 + (32 - size);
}

export function pickIcoEntry(body: Buffer): { mime: string; data: Buffer } | null {
  if (body.length < 6 || body.readUInt16LE(0) !== 0 || body.readUInt16LE(2) !== 1) return null;
  const count = body.readUInt16LE(4);
  let best: { size: number; entry: Buffer; data: Buffer } | null = null;
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (at + 16 > body.length) break;
    const size = Math.max(body[at] || 256, body[at + 1] || 256);
    const length = body.readUInt32LE(at + 8);
    const offset = body.readUInt32LE(at + 12);
    if (size < 16 || length === 0 || offset < 6 || offset + length > body.length) continue;
    if (!best || icoFrameRank(size) < icoFrameRank(best.size)) best = { size, entry: body.subarray(at, at + 16), data: body.subarray(offset, offset + length) };
  }
  if (!best) return null;
  if (sniffFaviconMime(best.data) === "image/png") return { mime: "image/png", data: best.data };
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.from(best.entry);
  entry.writeUInt32LE(22, 12);
  return { mime: "image/x-icon", data: Buffer.concat([header, entry, best.data]) };
}

function iconDataUrl(fetched: Buffer, contentType: string | null, truncated = false): string {
  if (!fetched.length) throw new FaviconRejectedError("Favicon is empty.");
  if (contentType !== null && !contentType.startsWith("image/")) {
    throw new FaviconRejectedError("Favicon is not served as an image.");
  }
  let body = fetched;
  let mime = sniffFaviconMime(body);
  if (mime === "image/x-icon" && (truncated || body.readUInt16LE(4) > 1)) {
    const frame = pickIcoEntry(body);
    if (frame) {
      body = frame.data;
      mime = frame.mime;
    }
  }
  if (truncated && body === fetched) throw new FaviconRejectedError("Favicon is too large.");
  if (body.length > SOURCE_FAVICON_LIMITS.maxIconBytes) throw new FaviconRejectedError("Favicon is too large.");
  if (!mime) throw new FaviconRejectedError("Favicon bytes are not an image.");
  if (mime === "image/svg+xml" && !isInertSvg(body.toString("utf8"))) {
    throw new FaviconRejectedError("Favicon SVG is not inert.");
  }
  return `data:${mime};base64,${body.toString("base64")}`;
}

function inlineIconDataUrl(href: string): string {
  const match = href.match(/^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*?)(;base64)?,(.*)$/is);
  if (!match) throw new FaviconRejectedError("Inline favicon is malformed.");
  const payload = match[4] ?? "";
  if (payload.length > SOURCE_FAVICON_LIMITS.maxIconBytes * 2) throw new FaviconRejectedError("Favicon is too large.");
  let body: Buffer;
  try {
    body = match[3] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    throw new FaviconRejectedError("Inline favicon is malformed.");
  }
  return iconDataUrl(body, match[1]!.toLowerCase());
}

// ── Service ───────────────────────────────────────────────────────────────

function hostCacheFile(cacheDir: string, host: string): string {
  return path.join(cacheDir, `${createHash("sha1").update(host).digest("hex")}.json`);
}

function contentTypeOf(response: SourceFaviconFetchResponse): string {
  return (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

export function createSourceFaviconService(options: SourceFaviconServiceOptions): SourceFaviconService {
  const lookup = options.lookup ?? defaultLookup;
  const transport = options.fetch ?? defaultFetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SOURCE_FAVICON_LIMITS.timeoutMs;
  const maxCacheBytes = options.maxCacheBytes ?? SOURCE_FAVICON_LIMITS.maxCacheBytes;
  const cacheDir = options.cacheDir;

  const memory = new Map<string, { expiresAt: number; dataUrl: string | null }>();
  const inflight = new Map<string, Promise<string | null>>();
  let knownCacheBytes: number | null = null;
  let cacheWrites: Promise<void> = Promise.resolve();

  // A small semaphore: a 48-source list must not open 48 sockets at once.
  let active = 0;
  const waiting: Array<() => void> = [];
  const withFetchSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active < SOURCE_FAVICON_LIMITS.maxConcurrentFetches) active += 1;
    // A released slot is handed straight to the next waiter, so `active` never overshoots.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };

  const remember = (host: string, dataUrl: string | null, ttlMs: number): void => {
    memory.delete(host);
    memory.set(host, { expiresAt: now() + ttlMs, dataUrl });
    while (memory.size > SOURCE_FAVICON_LIMITS.maxMemoryEntries) {
      const oldest = memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  };

  const readDisk = async (host: string): Promise<{ dataUrl: string | null; expiresAt: number } | null> => {
    if (!cacheDir) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(hostCacheFile(cacheDir, host), "utf8")) as Partial<CacheFile>;
      if (parsed.v !== 1 || parsed.host !== host || typeof parsed.fetchedAt !== "number") return null;
      const dataUrl = typeof parsed.dataUrl === "string" && parsed.dataUrl.startsWith("data:image/") ? parsed.dataUrl : null;
      const ttl = dataUrl ? SOURCE_FAVICON_LIMITS.positiveTtlMs : SOURCE_FAVICON_LIMITS.negativeTtlMs;
      const expiresAt = parsed.fetchedAt + ttl;
      return expiresAt > now() ? { dataUrl, expiresAt } : null;
    } catch {
      return null;
    }
  };

  const scanCache = async (): Promise<Array<{ file: string; size: number; mtimeMs: number }>> => {
    if (!cacheDir) return [];
    const names = await fs.readdir(cacheDir).catch(() => [] as string[]);
    const entries: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(cacheDir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile()) entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return entries;
  };

  const pruneCache = async (): Promise<void> => {
    const entries = await scanCache();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > maxCacheBytes) {
      entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
      const target = Math.floor(maxCacheBytes * 0.8);
      for (const entry of entries) {
        if (total <= target) break;
        await fs.rm(entry.file, { force: true }).catch(() => undefined);
        total -= entry.size;
      }
    }
    knownCacheBytes = total;
  };

  const writeDisk = (host: string, dataUrl: string | null): Promise<void> => {
    if (!cacheDir) return Promise.resolve();
    // Serialized so the size accounting and pruning never race each other.
    cacheWrites = cacheWrites.then(async () => {
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        const body = JSON.stringify({ v: 1, host, fetchedAt: now(), dataUrl } satisfies CacheFile);
        const file = hostCacheFile(cacheDir, host);
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temp, body, "utf8");
        await fs.rename(temp, file).catch(async (error) => {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          throw error;
        });
        if (knownCacheBytes === null) await pruneCache();
        else knownCacheBytes += Buffer.byteLength(body);
        if ((knownCacheBytes ?? 0) > maxCacheBytes) await pruneCache();
      } catch {
        // The cache is an optimization; a read-only or full disk only costs a refetch.
      }
    });
    return cacheWrites;
  };

  /** One request with redirects, every hop vetted, under one wall clock. */
  const fetchVetted = async (
    url: URL,
    accept: string,
    maxBytes: number,
  ): Promise<{ response: SourceFaviconFetchResponse; finalUrl: URL }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Favicon request timed out.");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const run = async () => {
      let current = url;
      for (let hop = 0; ; hop += 1) {
        const target = await vetHop(current, lookup);
        controller.signal.throwIfAborted();
        const response = await transport({
          url: current,
          address: target.address,
          family: target.family,
          accept,
          maxBytes,
          signal: controller.signal,
        });
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400 && location) {
          if (hop >= SOURCE_FAVICON_LIMITS.maxRedirects) throw new FaviconRejectedError("Too many favicon redirects.");
          current = new URL(location, current);
          continue;
        }
        return { response, finalUrl: current };
      }
    };
    try {
      return await Promise.race([run(), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const fetchIcon = async (href: string): Promise<string> => {
    if (href.startsWith("data:")) return inlineIconDataUrl(href);
    const { response } = await fetchVetted(new URL(href), ICON_ACCEPT, SOURCE_FAVICON_LIMITS.maxIconBytes);
    if (response.status < 200 || response.status >= 300) throw new FaviconRejectedError("Favicon request failed.");
    return iconDataUrl(response.body, contentTypeOf(response), response.truncated === true);
  };

  const discover = async (host: string): Promise<Outcome> => {
    const origins = [host];
    if (!host.startsWith("www.") && !net.isIP(stripBrackets(host))) origins.push(`www.${host}`);
    let transient = false;
    for (const origin of origins) {
      let page: { html: string; finalUrl: URL };
      try {
        const { response, finalUrl } = await fetchVetted(
          new URL(`https://${origin}/`),
          HTML_ACCEPT,
          SOURCE_FAVICON_LIMITS.maxHtmlBytes,
        );
        const type = contentTypeOf(response);
        const html = response.status >= 200 && response.status < 300 && (!type || type.includes("html"))
          ? response.body.toString("utf8")
          : "";
        page = { html, finalUrl };
      } catch (error) {
        if (error instanceof FaviconBlockedError) return { kind: "none" };
        // Offline, a dead apex record, or a timeout: the `www.` host may answer.
        transient = !(error instanceof FaviconRejectedError);
        continue;
      }
      const hrefs = extractFaviconCandidates(page.html, page.finalUrl).slice(0, SOURCE_FAVICON_LIMITS.maxCandidates);
      for (const fallback of [new URL("/favicon.ico", page.finalUrl), new URL(`https://${origin}/favicon.ico`)]) {
        if (fallback.protocol === "https:" && !hrefs.includes(fallback.toString())) hrefs.push(fallback.toString());
      }
      let iconTransient = false;
      for (const href of hrefs) {
        try {
          return { kind: "icon", dataUrl: await fetchIcon(href) };
        } catch (error) {
          if (!(error instanceof FaviconBlockedError) && !(error instanceof FaviconRejectedError)) iconTransient = true;
        }
      }
      // The site answered: its icons are what they are, the `www.` twin is not asked.
      return iconTransient ? { kind: "transient" } : { kind: "none" };
    }
    return transient ? { kind: "transient" } : { kind: "none" };
  };

  const resolveHost = async (host: string): Promise<string | null> => {
    const cached = memory.get(host);
    if (cached && cached.expiresAt > now()) return cached.dataUrl;
    const pending = inflight.get(host);
    if (pending) return await pending;
    const promise = (async () => {
      const disk = await readDisk(host);
      if (disk) {
        remember(host, disk.dataUrl, disk.expiresAt - now());
        return disk.dataUrl;
      }
      const outcome = await withFetchSlot(() => discover(host)).catch((): Outcome => ({ kind: "transient" }));
      if (outcome.kind === "transient") {
        remember(host, null, SOURCE_FAVICON_LIMITS.transientTtlMs);
        return null;
      }
      const dataUrl = outcome.kind === "icon" ? outcome.dataUrl : null;
      remember(host, dataUrl, dataUrl ? SOURCE_FAVICON_LIMITS.positiveTtlMs : SOURCE_FAVICON_LIMITS.negativeTtlMs);
      await writeDisk(host, dataUrl);
      return dataUrl;
    })().finally(() => inflight.delete(host));
    inflight.set(host, promise);
    return await promise;
  };

  const resolve = async (args: ResolveSourceFaviconsArgs | null | undefined): Promise<ResolveSourceFaviconsResult> => {
    const inputs: string[] = [];
    const push = (value: unknown) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      // Match normalizeFaviconHost's bound before retaining the original input
      // as a response key. The resolver is remotely callable and must not echo
      // a request-sized string into its JSON response.
      if (trimmed.length > 2_048) return;
      if (trimmed && !inputs.includes(trimmed) && inputs.length < SOURCE_FAVICON_LIMITS.maxHostsPerCall) inputs.push(trimmed);
    };
    if (Array.isArray(args?.domains)) for (const value of args.domains) push(value);
    push(args?.domain);
    push(args?.url);
    const icons: Record<string, string | null> = {};
    await Promise.all(inputs.map(async (input) => {
      const host = normalizeFaviconHost(input);
      icons[input] = host ? await resolveHost(host).catch(() => null) : null;
    }));
    return { icons };
  };

  return { resolve, resolveHost };
}

let defaultService: SourceFaviconService | null = null;

/** The process-wide resolver, caching under `<ADE home>/cache/favicons`. */
export function getSourceFaviconService(): SourceFaviconService {
  defaultService ??= createSourceFaviconService({
    cacheDir: path.join(resolveMachineAdeDir(), "cache", "favicons"),
  });
  return defaultService;
}
