import dns from "node:dns/promises";
import net from "node:net";
import { executableTool as tool } from "./executableTool";
import { z } from "zod";

const MAX_REDIRECTS = 5;

type AddressResolver = (hostname: string) => Promise<string[]>;

export const webFetchTool = tool({
  description:
    "Fetch content from a URL and return it as text. Useful for reading documentation, API responses, etc.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch"),
    max_chars: z
      .number()
      .optional()
      .default(10000)
      .describe("Maximum characters to return"),
  }),
  execute: async ({ url, max_chars }) => {
    let currentUrl = url;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetchWithSafeRedirects(currentUrl, controller.signal, (nextUrl) => {
        currentUrl = nextUrl;
      });

      if (!response.ok) {
        return {
          content: "",
          url: currentUrl,
          contentType: null,
          truncated: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let text = await response.text();

      // Strip HTML tags for HTML content
      if (contentType.includes("text/html")) {
        text = stripHtml(text);
      }

      const truncated = text.length > max_chars;
      if (truncated) {
        text = text.slice(0, max_chars);
      }

      return { content: text, url: currentUrl, contentType, truncated };
    } catch (err) {
      return {
        content: "",
        url: currentUrl,
        contentType: null,
        truncated: false,
        error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },
});

async function fetchWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal,
  onUrl: (url: string) => void,
): Promise<Response> {
  let current = await assertSafeWebFetchUrl(startUrl);
  onUrl(current.toString());
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "ADE-Agent/1.0" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
    }
    current = await assertSafeWebFetchUrl(new URL(location, current).toString());
    onUrl(current.toString());
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

export async function assertSafeWebFetchUrl(
  rawUrl: string,
  resolveAddresses: AddressResolver = defaultResolveAddresses,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  const hostname = parsed.hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) throw new Error("URL hostname is required");
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("Localhost URLs are not allowed");
  }
  const addresses = net.isIP(hostname) ? [hostname] : await resolveAddresses(hostname);
  if (!addresses.length) {
    throw new Error(`Hostname did not resolve: ${hostname}`);
  }
  const blocked = addresses.find(isBlockedNetworkAddress);
  if (blocked) {
    throw new Error(`URL resolves to a non-public address (${blocked})`);
  }
  return parsed;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isBlockedNetworkAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isBlockedIpv4(address);
  if (ipVersion === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 255 && b === 255)
  );
}

function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;
  const mapped = ipv4FromMappedIpv6(bytes);
  if (mapped) return isBlockedIpv4(mapped);
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  return (
    allZero ||
    loopback ||
    (bytes[0] & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff
  );
}

function parseIpv6Bytes(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const clean = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const ipv4Match = clean.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let normalized = clean;
  let ipv4Hextets: string[] = [];
  if (ipv4Match) {
    const parts = ipv4Match[1]!.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    ipv4Hextets = [
      ((parts[0]! << 8) | parts[1]!).toString(16),
      ((parts[2]! << 8) | parts[3]!).toString(16),
    ];
    normalized = clean.slice(0, clean.length - ipv4Match[1]!.length) + ipv4Hextets.join(":");
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const fill = halves.length === 2 ? new Array(8 - left.length - right.length).fill("0") : [];
  const hextets = [...left, ...fill, ...right];
  if (hextets.length !== 8) return null;
  const out: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    const value = Number.parseInt(hextet, 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  return out;
}

function ipv4FromMappedIpv6(bytes: number[]): string | null {
  const isMapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (!isMapped) return null;
  return bytes.slice(12, 16).join(".");
}

function stripHtml(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
