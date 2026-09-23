/**
 * Helpers shared by the Worker's two write-only sinks, `POST /diagnostics/upload`
 * (`diagnostics.ts`) and `POST /usage-research/daily` (`usageResearch.ts`): who
 * the caller is for a quota, how much of a body to read, which UTC day a budget
 * belongs to, and how a limit var is read.
 */

export const DAY_MS = 86_400_000;

/**
 * Cloudflare sets `cf-connecting-ip` and a client cannot influence it. Off
 * Cloudflare — a local dev run, a proxy in front — there is no trustworthy
 * address at all, so everyone shares one bucket rather than falling back to
 * `x-forwarded-for`: a quota keyed on a header the caller writes is not a quota.
 */
export function clientIdentity(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown-client";
}

const HEXTET = /^[0-9a-f]{1,4}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.trim().toLowerCase().split("%")[0]!;
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part ? part.split(":") : []);
  const head = split(halves[0]!);
  const tail = halves.length === 2 ? split(halves[1]!) : [];
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) is the last two groups.
  const last = halves.length === 2 ? tail : head;
  const dotted = last.length ? IPV4.exec(last[last.length - 1]!) : null;
  const trailing: number[] = [];
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    last.pop();
    trailing.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
  }
  const written = head.length + tail.length + trailing.length;
  const missing = 8 - written;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!parts.every((part) => HEXTET.test(part))) return null;
  return [...parts.map((part) => parseInt(part, 16)), ...trailing];
}

/**
 * The address a per-caller quota counts, with an IPv6 address cut to its /64.
 *
 * One IPv6 customer is routinely handed a whole /64, so keying on the full
 * address would give a single machine 2^64 fresh quotas. An IPv4 address, and
 * anything that is not an address (`unknown-client`), is returned unchanged.
 */
export function quotaAddress(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Seconds until a daily budget resets.
 *
 * Unix time has no leap seconds, so `nowMs % DAY_MS` is exactly the time since
 * UTC midnight and this is the honest number rather than a flat 86400. A client
 * refused at 23:59 should retry in a minute, not tomorrow night.
 */
export function secondsUntilNextUtcDay(nowMs: number): number {
  return Math.max(1, Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000));
}

/** A non-negative integer var, or null when unset, empty, negative, or unparseable. */
export function nonNegativeIntegerVar(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

/**
 * A configured fleet-wide daily ceiling.
 *
 * An unset, empty, or unparseable value falls back to `fallback` — a typo in a
 * var must not silently uncap the bill or silently close the route. `0` is
 * honored, on purpose: it is the kill switch that stops every write without a
 * redeploy of code.
 */
export function dailyLimitVar(raw: string | undefined, fallback: number): number {
  return nonNegativeIntegerVar(raw) ?? fallback;
}

/**
 * Reads at most `maxBytes + 1` bytes.
 *
 * `content-length` is checked first because it makes the common rejection free,
 * but it is never trusted on its own: a chunked upload carries no length at
 * all, so the stream is counted as it arrives and abandoned the moment it
 * crosses the cap. Buffering whatever the client claimed to send would be the
 * bug the cap exists to prevent.
 *
 * A stream that errors mid-read (the client went away) rejects; each route
 * decides what that means for its answer and its log line.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: "too_large" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  const body = request.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}
