import type { DevServersResult } from "../../../../shared/types/builtInBrowser";
import { browserHostLabel } from "../../../lib/browserUrl";

/**
 * The launchpad's dev-server list.
 *
 * Two feeds land here. The one-shot `builtInBrowser.getDevServers()` read is
 * typed (`DevServersResult`) and, unlike every other browser call, takes no pin
 * — it reads THIS process's own PTY output — so there is no older main process
 * on the other end of it and no shape to guess. The live `dev-server-detected`
 * event is the loose one: its payload is whatever the detector sent, which over
 * the years has been a bare port, a host string and the full record. That is
 * what {@link normalizeDevServer} exists for; {@link normalizeDevServers} just
 * walks the typed list through it and de-duplicates.
 */

export type BrowserDevServer = {
  url: string;
  port: number | null;
  /** The command or framework behind the port, when the detector knows it. */
  source: string | null;
};

function devServerPort(url: string, explicit: unknown): number | null {
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit > 0) return explicit;
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function normalizeDevServer(value: unknown): BrowserDevServer | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { url: `http://localhost:${value}`, port: value, source: null };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const url = /^https?:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return { url, port: devServerPort(url, null), source: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.url === "string" && record.url.trim() ? record.url.trim() : null;
  const rawPort = typeof record.port === "number" ? record.port : null;
  const url = rawUrl
    ? (/^https?:/i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    : rawPort != null
      ? `http://localhost:${rawPort}`
      : null;
  if (!url) return null;
  // `source` is a string on the detector's older payloads and a `{sessionId,
  // laneId}` record on the current one, so a non-string simply means "nothing
  // named this port" rather than a shape error.
  const source = ["command", "source", "framework", "label", "name"]
    .map((key) => (typeof record[key] === "string" ? (record[key] as string).trim() : ""))
    .find((text) => text.length > 0) ?? null;
  return { url, port: devServerPort(url, rawPort), source: source || null };
}

export function normalizeDevServers(
  result: DevServersResult | null | undefined,
): BrowserDevServer[] {
  const list = result?.servers ?? [];
  const seen = new Set<string>();
  const servers: BrowserDevServer[] = [];
  for (const entry of list) {
    const server = normalizeDevServer(entry);
    if (!server || seen.has(server.url)) continue;
    seen.add(server.url);
    servers.push(server);
  }
  return servers;
}

/** Merge a freshly detected server into the list without duplicating it. */
export function mergeDevServer(
  servers: BrowserDevServer[],
  next: BrowserDevServer | null,
): BrowserDevServer[] {
  if (!next) return servers;
  const index = servers.findIndex((server) => server.url === next.url);
  if (index < 0) return [...servers, next];
  const current = servers[index];
  if (current.source === next.source) return servers;
  const merged = [...servers];
  merged[index] = { ...current, source: next.source ?? current.source };
  return merged;
}

/**
 * How one local server reads as a launchpad row.
 *
 * `localhost:5173` is the server's identity, so it is the title; the command
 * that opened it is the detail underneath. The old single chip label glued the
 * two together (`npm run dev · :5173`) because a chip has one line — a row has
 * two, and stacking them is what lets a column of six ports be scanned by port.
 */
export function devServerRowLabels(server: BrowserDevServer): {
  title: string;
  subtitle: string | null;
} {
  const title = server.port != null
    ? `localhost:${server.port}`
    : browserHostLabel(server.url) ?? server.url;
  return { title, subtitle: server.source };
}

/** `:5173`, the one thing small enough to print inside a 48×30 thumbnail. */
export function devServerThumbLabel(server: BrowserDevServer): string {
  return server.port != null ? `:${server.port}` : browserHostLabel(server.url) ?? "";
}
