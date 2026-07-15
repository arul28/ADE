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

export const DEFAULT_ADE_TUNNEL_RELAY_URL =
  "https://ade-tunnel-relay.arulsharma1028.workers.dev";

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

export async function fetchAccountMachines(args: {
  baseUrl: string | null | undefined;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  const timeoutMs = Math.max(250, Math.floor(args.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      return {
        state: "auth_expired",
        machines: [],
        message: "Your ADE account session expired. Sign in again.",
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
    return {
      state: "unavailable",
      machines: [],
      message: controller.signal.aborted
        ? "Machine directory timed out."
        : "Couldn't reach the machine directory.",
    };
  } finally {
    clearTimeout(timer);
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
