import {
  CLIENT_MINIMUM_LINKS,
  CLIENT_MINIMUM_PATH,
  type ClientMinimumResponse,
} from "../../../account-directory/src/clientMinimumContract";
import { CLIENT_MINIMUM_FRESH_MS } from "./clientUpdateGate";

/**
 * Reads `GET /client/minimum` for one process: the desktop main process, the
 * brain, and ADE Web each hold one reader.
 *
 * The answer decides only while it is fresh (`CLIENT_MINIMUM_FRESH_MS`). A
 * failed read keeps the last answer until it goes stale; no answer at all, or
 * a stale one, means "no minimum", so a computer that cannot reach the account
 * server is never blocked. The reader starts no timer: its owner decides when
 * to read.
 */
export type ClientMinimumReader = {
  /** The answer when it is fresh; null when there is none or it is stale. */
  current(): ClientMinimumResponse | null;
  /** When the last answer arrived (epoch ms); null before the first one. */
  answeredAtMs(): number | null;
  /** When the last read started, answered or not (epoch ms). */
  attemptedAtMs(): number | null;
  /** Reads again (one read at a time). Never rejects; resolves `current()`. */
  refresh(): Promise<ClientMinimumResponse | null>;
};

export function createClientMinimumReader(args: {
  /** Resolves the parsed JSON body; throws when the server did not answer 2xx. */
  fetchBody: () => Promise<unknown>;
  nowMs?: () => number;
  onReadFailed?: (error: unknown) => void;
}): ClientMinimumReader {
  const nowMs = args.nowMs ?? (() => Date.now());
  let last: { value: ClientMinimumResponse; atMs: number } | null = null;
  let attemptedAt: number | null = null;
  let inFlight: Promise<ClientMinimumResponse | null> | null = null;

  const current = (): ClientMinimumResponse | null =>
    last && nowMs() - last.atMs < CLIENT_MINIMUM_FRESH_MS ? last.value : null;

  return {
    current,
    answeredAtMs: () => last?.atMs ?? null,
    attemptedAtMs: () => attemptedAt,
    refresh() {
      if (inFlight) return inFlight;
      attemptedAt = nowMs();
      inFlight = (async () => {
        try {
          const value = parseClientMinimumBody(await args.fetchBody());
          // An answer ADE cannot read is a failed read: the last answer stays.
          if (!value) throw new Error("client_minimum_unreadable");
          last = { value, atMs: nowMs() };
        } catch (error) {
          args.onReadFailed?.(error);
        }
        return current();
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function versionOrNull(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value.trim()) ? value.trim() : null;
}

function buildOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function httpsLink(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** The body, field by field; null when it is not an answer at all. A malformed field reads as no minimum. */
export function parseClientMinimumBody(body: unknown): ClientMinimumResponse | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = record(body);
  const desktop = record(root.desktop);
  const ios = record(root.ios);
  const links = record(root.links);
  const appStore = versionOrNull(record(ios.appStore).version);
  const testFlight = buildOrNull(record(ios.testFlight).build);
  const betaApp = buildOrNull(record(ios.betaApp).build);
  return {
    desktop: { stable: versionOrNull(desktop.stable), beta: versionOrNull(desktop.beta) },
    ios: {
      appStore: appStore ? { version: appStore } : null,
      testFlight: testFlight ? { build: testFlight } : null,
      betaApp: betaApp ? { build: betaApp } : null,
    },
    links: {
      download: httpsLink(links.download, CLIENT_MINIMUM_LINKS.download),
      appStore: httpsLink(links.appStore, CLIENT_MINIMUM_LINKS.appStore),
      testFlight: httpsLink(links.testFlight, CLIENT_MINIMUM_LINKS.testFlight),
      betaAppTestFlight: httpsLink(links.betaAppTestFlight, CLIENT_MINIMUM_LINKS.betaAppTestFlight),
    },
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : null,
  };
}

/** One bounded, credential-free GET of `${baseUrl}/client/minimum`. Throws on anything but a 2xx JSON answer. */
export async function fetchClientMinimumBody(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<unknown> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("client_minimum_no_directory");
  const response = await (options.fetchImpl ?? fetch)(`${base}${CLIENT_MINIMUM_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`client_minimum_http_${response.status}`);
  }
  return await response.json();
}
