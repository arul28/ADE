import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  deriveSmartLinkPreview,
  type SmartLinkPreview,
} from "../../../shared/smartLinks";

type GithubIssueLookup = {
  getIssue(owner: string, repo: string, number: number): Promise<{ title?: string | null } | null>;
};

type LinearIssueLookup = {
  searchIssues(query: { query?: string | null; first?: number }): Promise<{
    issues: Array<{ identifier: string; title: string; url?: string | null }>;
  }>;
};

type ResolveSmartLinkPreviewArgs = {
  url: string;
  githubService?: GithubIssueLookup | null;
  linearIssueTracker?: LinearIssueLookup | null;
};

type CachedPreview = { expiresAt: number; value: SmartLinkPreview };

const MAX_CACHE_ENTRIES = 256;
const CACHE_TTL_MS = 30 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2_500;
const previewCache = new Map<string, CachedPreview>();
const publicIpv6Ranges = new net.BlockList();
publicIpv6Ranges.addSubnet("2000::", 3, "ipv6");
const nonPublicIpv6Ranges = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 can embed non-public IPv4 destinations
] as const) {
  nonPublicIpv6Ranges.addSubnet(network, prefix, "ipv6");
}

function rememberPreview(key: string, value: SmartLinkPreview, ttlMs: number): SmartLinkPreview {
  previewCache.delete(key);
  previewCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (previewCache.size > MAX_CACHE_ENTRIES) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    previewCache.delete(oldest);
  }
  return value;
}

function cachedPreview(key: string): SmartLinkPreview | null {
  const cached = previewCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    previewCache.delete(key);
    return null;
  }
  previewCache.delete(key);
  previewCache.set(key, cached);
  return cached.value;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && parts[2] === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100)))
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function isPrivateIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  // BlockList performs Node's canonical IPv6 parsing, including compressed and
  // hex-form IPv4-mapped addresses. Be conservative: only ordinary global
  // unicast space is eligible, and reject tunnelling/documentation ranges that
  // can encode non-public IPv4 destinations or are not globally routable.
  return !publicIpv6Ranges.check(address, "ipv6")
    || nonPublicIpv6Ranges.check(address, "ipv6");
}

async function resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (url.username || url.password) throw new Error("Link preview credentials are not allowed.");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported link preview protocol.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Link preview ports are restricted.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local link previews are disabled.");
  }
  const ipLiteral = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literalFamily = net.isIP(ipLiteral);
  if (literalFamily) {
    if (isPrivateIp(ipLiteral)) throw new Error("Private link previews are disabled.");
    return { address: ipLiteral, family: literalFamily as 4 | 6 };
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Private link previews are disabled.");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

type BoundedResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  data: Buffer;
};

async function withWallClockTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Link preview request timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readBoundedResponse(response: http.IncomingMessage, maxBytes: number): Promise<BoundedResponse> {
  return new Promise<BoundedResponse>((resolve, reject) => {
    response.once("error", reject);
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy(new Error("Link preview response is too large."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy(new Error("Link preview response is too large."));
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      data: Buffer.concat(chunks),
    }));
  });
}

async function requestBounded(url: URL, maxBytes: number, accept: string): Promise<BoundedResponse> {
  return await withWallClockTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
    const target = await resolvePublicAddress(url);
    signal.throwIfAborted();
    const requester = url.protocol === "https:" ? https : http;
    return await new Promise<BoundedResponse>((resolve, reject) => {
      const request = requester.request(url, {
        method: "GET",
        headers: {
          accept,
          "accept-encoding": "identity",
          "user-agent": "ADE-LinkPreview/1.0",
        },
        signal,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      }, (response) => void readBoundedResponse(response, maxBytes).then(resolve, reject));
      request.on("error", reject);
      request.end();
    });
  });
}

async function fetchWithRedirects(url: URL, maxBytes: number, accept: string, redirectLimit = 3): Promise<BoundedResponse & { finalUrl: URL }> {
  let current = url;
  for (let redirect = 0; redirect <= redirectLimit; redirect += 1) {
    const response = await requestBounded(current, maxBytes, accept);
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      if (redirect === redirectLimit) throw new Error("Too many link preview redirects.");
      current = new URL(response.headers.location, current);
      continue;
    }
    return { ...response, finalUrl: current };
  }
  throw new Error("Unable to resolve link preview.");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanTitle(value: string | null | undefined): string | null {
  const title = decodeHtmlEntities(value ?? "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 180) : null;
}

function htmlAttribute(tag: string, attribute: string): string | null {
  const match = tag.match(new RegExp(`${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractHtmlMetadata(html: string, pageUrl: URL): { title: string | null; iconUrl: URL | null } {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  let title: string | null = null;
  for (const tag of metaTags) {
    const property = (htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name") ?? "").toLowerCase();
    if (property !== "og:title" && property !== "twitter:title") continue;
    title = cleanTitle(htmlAttribute(tag, "content"));
    if (title) break;
  }
  if (!title) title = cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);

  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  let iconUrl: URL | null = null;
  for (const tag of linkTags) {
    const rel = (htmlAttribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = htmlAttribute(tag, "href");
    if (!href) continue;
    try {
      const candidate = new URL(href, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") {
        iconUrl = candidate;
        break;
      }
    } catch {
      // Ignore malformed icon candidates and try the next declaration.
    }
  }
  return { title, iconUrl: iconUrl ?? new URL("/favicon.ico", pageUrl) };
}

async function fetchIconDataUrl(url: URL): Promise<string | null> {
  try {
    const response = await fetchWithRedirects(url, MAX_ICON_BYTES, "image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon");
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    const mimeType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);
    if (!allowed.has(mimeType) || !response.data.length) return null;
    return `data:${mimeType};base64,${response.data.toString("base64")}`;
  } catch {
    return null;
  }
}

async function resolveGenericPreview(base: SmartLinkPreview): Promise<SmartLinkPreview> {
  try {
    const response = await fetchWithRedirects(new URL(base.url), MAX_HTML_BYTES, "text/html,application/xhtml+xml");
    if (response.statusCode < 200 || response.statusCode >= 300) return base;
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return base;
    const metadata = extractHtmlMetadata(response.data.toString("utf8"), response.finalUrl);
    const iconDataUrl = metadata.iconUrl ? await fetchIconDataUrl(metadata.iconUrl) : null;
    return { ...base, title: metadata.title, iconDataUrl };
  } catch {
    return base;
  }
}

async function resolveProviderTitle(base: SmartLinkPreview, args: ResolveSmartLinkPreviewArgs): Promise<SmartLinkPreview> {
  if ((base.kind === "github_pr" || base.kind === "github_issue") && args.githubService) {
    const match = new URL(base.url).pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/i);
    if (match) {
      const issue = await args.githubService.getIssue(match[1]!, match[2]!, Number(match[3])).catch(() => null);
      const title = cleanTitle(issue?.title);
      if (title) return { ...base, title };
    }
  }
  if (base.kind === "linear_issue" && args.linearIssueTracker) {
    const result = await args.linearIssueTracker.searchIssues({ query: base.label, first: 10 }).catch(() => null);
    const issue = result?.issues.find((candidate) => candidate.identifier.toUpperCase() === base.label.toUpperCase());
    const title = cleanTitle(issue?.title);
    if (title) return { ...base, title };
  }
  return base;
}

export async function resolveSmartLinkPreview(args: ResolveSmartLinkPreviewArgs): Promise<SmartLinkPreview | null> {
  const base = deriveSmartLinkPreview(args.url);
  if (!base) return null;
  if (base.provider !== "generic") {
    // Provider titles may come from project/account-scoped credentials. Never
    // place authenticated metadata in the process-global public URL cache.
    return resolveProviderTitle(base, args);
  }
  const cached = cachedPreview(base.url);
  if (cached) return cached;
  const resolved = await resolveGenericPreview(base);
  const enriched = Boolean(resolved.title || resolved.iconDataUrl);
  return rememberPreview(base.url, resolved, enriched ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS);
}

export function clearSmartLinkPreviewCacheForTesting(): void {
  previewCache.clear();
}

export const smartLinkPreviewTesting = {
  isPublicIpAddress: (address: string): boolean => !isPrivateIp(address),
  readBoundedResponse,
  withWallClockTimeout,
};
