import type {
  AdeAccountMachine,
  AdeAccountMachineEndpoint,
  AdeAccountMachinesResult,
} from "./types/account";
import type { SyncHelloOkPayload } from "./types/sync";
import { isTailnetHostname } from "./tailnet";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_MACHINES = 500;
const MAX_ENDPOINTS_PER_MACHINE = 16;
const MAX_ID_CHARS = 512;
const MAX_LABEL_CHARS = 256;
export const MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ACCOUNT_DIRECTORY_ERROR_BYTES = 512;

export const DEFAULT_ADE_TUNNEL_RELAY_URL =
  "https://ade-tunnel-relay.arulsharma1028.workers.dev";
export const DEFAULT_ADE_CLERK_ISSUER = "https://clerk.ade-app.dev";
export const DEFAULT_ADE_CLERK_JWKS_URL =
  `${DEFAULT_ADE_CLERK_ISSUER}/.well-known/jwks.json`;
export const DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID = "Az7TbviBocyXjZk1";
export const DEFAULT_ADE_ACCOUNT_DIRECTORY_URL =
  "https://ade-account-directory-production.arulsharma1028.workers.dev";
export const DEVELOPMENT_ADE_CLERK_ISSUER =
  "https://coherent-foxhound-62.clerk.accounts.dev";
export const DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID = "d6pUGxQXTqIMYl5w";
export const DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL =
  "https://ade-account-directory.arulsharma1028.workers.dev";
const DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_HOST = new URL(
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
).hostname.replace(/\.$/, "").toLowerCase();

const DEVELOPMENT_CLERK_IGNORED_WARNING =
  "[account] Ignoring development Clerk configuration in a packaged build; using ADE production. Set ADE_ALLOW_DEVELOPMENT_CLERK=1 to override.";
let warnedDevClerkIgnored = false;

export function isPackagedRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.ADE_RUNTIME_PACKAGED === "1";
}

export function developmentClerkOverrideAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.ADE_ALLOW_DEVELOPMENT_CLERK === "1";
}

export function shouldIgnoreDevelopmentClerkConfiguration(
  env: NodeJS.ProcessEnv,
): boolean {
  return isPackagedRuntime(env) && !developmentClerkOverrideAllowed(env);
}

export function warnDevelopmentClerkIgnored(): void {
  if (warnedDevClerkIgnored) return;
  warnedDevClerkIgnored = true;
  console.warn(DEVELOPMENT_CLERK_IGNORED_WARNING);
}

export function isClerkDevelopmentIssuer(
  issuer: string | null | undefined,
): boolean {
  const trimmed = issuer?.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  url.hostname = url.hostname.replace(/\.$/, "");
  const normalizedIssuer = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return url.hostname.toLowerCase().endsWith(".clerk.accounts.dev")
    || normalizedIssuer === DEVELOPMENT_ADE_CLERK_ISSUER;
}

export function isDevelopmentAccountDirectoryUrl(
  url: string | null | undefined,
): boolean {
  const trustedUrl = parseTrustedAccountDirectoryBaseUrl(url);
  if (!trustedUrl) return false;
  const parsed = new URL(trustedUrl);
  const normalizedHost = parsed.hostname.replace(/\.$/, "").toLowerCase();
  return normalizedHost === DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_HOST;
}

export function shouldIgnoreDevelopmentAccountDirectoryUrl(
  url: string | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return shouldIgnoreDevelopmentClerkConfiguration(env)
    && isDevelopmentAccountDirectoryUrl(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxChars ? trimmed : null;
}

function optionalBoundedString(value: unknown, maxChars: number): string | null {
  return value == null ? null : boundedString(value, maxChars);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Trust boundary for account bearer requests. Credential-bearing HTTP calls
 * may target only an explicit HTTPS base URL (or loopback HTTP in local dev),
 * never a relative URL, URL with embedded credentials, query, or fragment.
 */
export function parseTrustedAccountDirectoryBaseUrl(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/**
 * Resolve an optional machine-owner override while keeping ADE's hosted
 * directory as the zero-config default. Blank values mean "not overridden";
 * a non-blank invalid value still fails closed instead of silently redirecting
 * the account bearer elsewhere.
 */
export function resolveTrustedAccountDirectoryBaseUrl(
  raw: string | null | undefined,
): string | null {
  return parseTrustedAccountDirectoryBaseUrl(
    raw?.trim() || DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  );
}

/**
 * Development tokens are accepted only by ADE's isolated development Worker;
 * every other issuer uses the production directory. The project may select an
 * issuer, but it can never select an arbitrary bearer destination through this
 * mapping.
 */
export function officialAccountDirectoryUrlForIssuer(
  rawIssuer: string | null | undefined,
): string {
  return parseTrustedAccountDirectoryBaseUrl(rawIssuer) === DEVELOPMENT_ADE_CLERK_ISSUER
    ? DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL
    : DEFAULT_ADE_ACCOUNT_DIRECTORY_URL;
}

function parseEndpoint(value: unknown): AdeAccountMachineEndpoint | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "lan" && kind !== "tailnet" && kind !== "relay") return null;
  const url = optionalBoundedString(value.url, 2_048);
  const host = optionalBoundedString(value.host, MAX_LABEL_CHARS);
  const port = value.port == null
    ? undefined
    : typeof value.port === "number"
      && Number.isInteger(value.port)
      && value.port >= 1
      && value.port <= 65_535
      ? value.port
      : null;
  if ((!url && !host) || port === null) return null;
  return {
    kind,
    ...(url ? { url } : {}),
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

export function parseAccountMachine(value: unknown): AdeAccountMachine | null {
  if (!isRecord(value)) return null;
  const machineKey = boundedString(value.machineKey, MAX_ID_CHARS);
  if (!machineKey) return null;
  const endpoints = Array.isArray(value.reachableEndpoints)
    ? value.reachableEndpoints
        .slice(0, MAX_ENDPOINTS_PER_MACHINE)
        .map(parseEndpoint)
        .filter((entry): entry is AdeAccountMachineEndpoint => entry != null)
    : [];
  const lastSeenAt = typeof value.lastSeenAt === "number"
    && Number.isFinite(value.lastSeenAt)
    && value.lastSeenAt >= 0
    && value.lastSeenAt <= 8_640_000_000_000_000
    ? value.lastSeenAt
    : null;
  return {
    machineKey,
    deviceId: optionalBoundedString(value.deviceId, MAX_ID_CHARS),
    name: optionalBoundedString(value.name, MAX_LABEL_CHARS),
    platform: optionalBoundedString(value.platform, MAX_LABEL_CHARS),
    deviceType: optionalBoundedString(value.deviceType, MAX_LABEL_CHARS),
    reachableEndpoints: endpoints,
    lastSeenAt,
    online: value.online === true,
  };
}

export function parseAccountMachinesPayload(payload: unknown): AdeAccountMachine[] {
  if (!isRecord(payload) || !Array.isArray(payload.machines)) return [];
  const machines: AdeAccountMachine[] = [];
  const seen = new Set<string>();
  for (const raw of payload.machines.slice(0, MAX_MACHINES)) {
    const machine = parseAccountMachine(raw);
    if (!machine || seen.has(machine.machineKey)) continue;
    seen.add(machine.machineKey);
    machines.push(machine);
  }
  return machines;
}

/** Return the normalized host identity advertised by an account endpoint. */
export function accountMachineEndpointHost(
  endpoint: AdeAccountMachineEndpoint,
): string | null {
  const host = endpoint.host?.trim();
  if (host) return host.replace(/^\[|\]$/g, "").replace(/\.$/, "") || null;
  const raw = endpoint.url?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "") || null;
  } catch {
    return /^[^/\s]+$/.test(raw)
      ? raw.replace(/^\[|\]$/g, "").replace(/\.$/, "") || null
      : null;
  }
}

function parseTrustedAccountRelayBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "wss:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function trustedAccountRelayBaseUrls(
  configured: readonly string[] = [],
): string[] {
  const values = [DEFAULT_ADE_TUNNEL_RELAY_URL, ...configured];
  return [...new Set(values.flatMap((raw) => {
    const parsed = parseTrustedAccountRelayBaseUrl(raw);
    return parsed ? [parsed] : [];
  }))];
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES) {
    throw new Error("Machine directory response exceeded the size limit.");
  }
  if (!response.body) throw new Error("Machine directory response was empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ACCOUNT_DIRECTORY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Machine directory response exceeded the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

function shortHttpReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length <= MAX_LABEL_CHARS ? normalized : null;
}

/**
 * Consume only a tiny error response. Directory failures are surfaced to users
 * and health diagnostics, so never use Response.text() on an untrusted body.
 */
export async function readAccountDirectoryHttpReason(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACCOUNT_DIRECTORY_ERROR_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const bytes: number[] = [];
  let oversized = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes.length + value.byteLength > MAX_ACCOUNT_DIRECTORY_ERROR_BYTES) {
        oversized = true;
        await reader.cancel();
        break;
      }
      bytes.push(...value);
    }
  } finally {
    reader.releaseLock();
  }
  if (oversized || bytes.length === 0) return null;

  const text = new TextDecoder("utf-8").decode(Uint8Array.from(bytes)).trim();
  if (!text) return null;
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      return shortHttpReason(payload.error) ?? shortHttpReason(payload.message);
    }
  } catch {
    // Plain-text 403 responses are also useful if they stay within the bound.
  }
  return shortHttpReason(text);
}

export async function fetchAccountMachines(args: {
  baseUrl: string | null | undefined;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AdeAccountMachinesResult> {
  const baseUrl = parseTrustedAccountDirectoryBaseUrl(args.baseUrl);
  if (!baseUrl) {
    return {
      state: "not_configured",
      machines: [],
      message: "Machine directory isn't configured — set a trusted https directory URL on this machine.",
    };
  }
  const token = args.accessToken.trim();
  if (!token) return { state: "signed_out", machines: [], message: null };

  const controller = new AbortController();
  const onAbort = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) onAbort();
  else args.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.max(250, Math.floor(args.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await (args.fetchImpl ?? fetch)(`${baseUrl}/account/machines`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      const reason = await readAccountDirectoryHttpReason(response).catch(() => null);
      return {
        state: "auth_expired",
        machines: [],
        message: reason
          ? `The machine directory rejected your ADE account session. Sign in again. Reason: ${reason}`
          : "Your ADE account session expired. Sign in again.",
      };
    }
    if (!response.ok) {
      return {
        state: "unavailable",
        machines: [],
        message: `Machine directory returned ${response.status}.`,
      };
    }
    const payload = await readBoundedJson(response);
    return { state: "ok", machines: parseAccountMachinesPayload(payload), message: null };
  } catch {
    if (args.signal?.aborted) {
      return {
        state: "cancelled",
        machines: [],
        message: "Machine directory request was cancelled.",
      };
    }
    return {
      state: "unavailable",
      machines: [],
      message: timedOut
        ? "Machine directory timed out."
        : "Couldn't reach the machine directory.",
    };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Exact, credential-safe sync endpoints advertised by the verified directory.
 * The account token may only be sent over an allowlisted WSS relay, and the URL
 * must not carry credentials, a query, or a fragment.
 */
export function accountMachineSecureSyncEndpoints(
  machine: AdeAccountMachine,
  relayBaseUrls: readonly string[] = [],
): string[] {
  const allowedRoutes = new Set(trustedAccountRelayBaseUrls(relayBaseUrls).map((baseUrl) =>
    new URL(`${baseUrl}/connect/${encodeURIComponent(machine.machineKey)}`).toString()
  ));
  const endpoints: string[] = [];
  for (const endpoint of machine.reachableEndpoints) {
    if (endpoint.kind !== "relay") continue;
    const raw = endpoint.url?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "wss:") continue;
    if (url.username || url.password || url.search || url.hash) continue;
    const normalized = url.toString();
    if (!allowedRoutes.has(normalized)) continue;
    if (!endpoints.includes(normalized)) endpoints.push(normalized);
  }
  return endpoints;
}

export type AccountPairingCredentials = {
  deviceId: string;
  secret: string;
};

/**
 * Resolve the credential accepted from an account hello without ever mixing a
 * partial host response with a previously stored record. A present but invalid
 * accountPairing is rejected; fallback is allowed only when the host omitted it
 * for an already-adopted device.
 */
export function resolveAccountHelloPairing(args: {
  accountPairing: SyncHelloOkPayload["accountPairing"];
  existingPairing: AccountPairingCredentials | null;
  expectedDeviceId: string;
}): AccountPairingCredentials | null {
  const pairing = args.accountPairing === undefined
    ? args.existingPairing
    : args.accountPairing;
  if (!pairing) return null;
  const deviceId = boundedString(pairing.deviceId, MAX_ID_CHARS);
  const secret = boundedString(pairing.secret, 4_096);
  return deviceId === args.expectedDeviceId.trim() && secret
    ? { deviceId, secret }
    : null;
}

export type AccountMachineConnectionState = "available" | "unreachable" | "offline";

export function accountMachineConnectionState(
  machine: AdeAccountMachine,
  relayBaseUrls: readonly string[] = [],
): AccountMachineConnectionState {
  if (!machine.online) return "offline";
  return accountMachineSecureSyncEndpoints(machine, relayBaseUrls).length > 0
    ? "available"
    : "unreachable";
}

function isLanHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname === "::1") return false;
  if (hostname.endsWith(".local") || (!hostname.includes(".") && !hostname.includes(":"))) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.some((part) => part > 255)) return false;
    return octets[0] === 10
      || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  return /^(?:fc|fd)[0-9a-f]{2}:/.test(hostname)
    || /^fe[89ab][0-9a-f]:/.test(hostname);
}

/**
 * Routes that may be used only after account authentication has produced a
 * normal DPoP-bound paired secret. Plain WS is allowed here for LAN/tailnet
 * parity because the Clerk bearer never traverses these routes.
 */
export function accountMachinePairedSyncEndpoints(
  machine: AdeAccountMachine,
  relayBaseUrls: readonly string[] = [],
): string[] {
  const trustedRelayEndpoints = new Set(
    accountMachineSecureSyncEndpoints(machine, relayBaseUrls),
  );
  const endpoints: string[] = [];
  const add = (url: URL, kind: AdeAccountMachineEndpoint["kind"]): void => {
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return;
    if (url.username || url.password || url.search || url.hash) return;
    const normalized = url.toString();
    if (kind === "relay") {
      if (!trustedRelayEndpoints.has(normalized)) return;
    } else if (kind === "tailnet") {
      if (!isTailnetHostname(url.hostname)) return;
    } else if (!isLanHostname(url.hostname)) {
      return;
    }
    if (!endpoints.includes(normalized)) endpoints.push(normalized);
  };
  for (const endpoint of machine.reachableEndpoints) {
    if (endpoint.url?.trim()) {
      try {
        add(new URL(endpoint.url), endpoint.kind);
      } catch {
        // Ignore malformed directory data.
      }
      continue;
    }
    if (endpoint.kind === "relay" || !endpoint.host?.trim() || !endpoint.port) continue;
    const host = endpoint.host.trim();
    const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    try {
      add(new URL(`ws://${bracketed}:${endpoint.port}`), endpoint.kind);
    } catch {
      // Ignore malformed directory data.
    }
  }
  return endpoints;
}

export function selectAccountMachine(
  machines: AdeAccountMachine[],
  query: string,
): AdeAccountMachine {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("Machine selection is required.");
  const byStableId = machines.filter((machine) =>
    machine.machineKey.toLowerCase() === needle
    || machine.deviceId?.toLowerCase() === needle
  );
  const stableMatch = byStableId[0];
  if (stableMatch && byStableId.length === 1) return stableMatch;
  if (byStableId.length > 1) {
    const choices = byStableId.map(
      (machine) => `${machine.name ?? "Unnamed machine"} (${machine.machineKey})`,
    );
    throw new Error(`Machine identifier '${query}' is ambiguous. Choose one of: ${choices.join(", ")}.`);
  }

  const byName = machines.filter((machine) => machine.name?.trim().toLowerCase() === needle);
  const nameMatch = byName[0];
  if (nameMatch && byName.length === 1) return nameMatch;
  if (byName.length > 1) {
    const choices = byName.map((machine) => `${machine.name ?? "Unnamed machine"} (${machine.machineKey})`);
    throw new Error(`Machine name '${query}' is ambiguous. Choose one of: ${choices.join(", ")}.`);
  }
  throw new Error(`Account machine not found: ${query}`);
}
