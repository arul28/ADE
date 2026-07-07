import { parsePairingQrUrl } from "../../../shared/pairingQr";
import type {
  SyncAddressCandidate,
  SyncPairingQrPayload,
} from "../../../shared/types/sync";
import type { WebClientEnvironmentRecord } from "./envStore";

export type BrowserDialCandidate = {
  url: string;
  kind: "lastGood" | "relay" | "loopback" | "candidate" | "explicitWss";
  dialable: boolean;
  reason?: string;
  source?: SyncAddressCandidate;
};

export type EndpointDerivationInput = {
  payload?: SyncPairingQrPayload | string | null;
  environment?: WebClientEnvironmentRecord | null;
  location?: Pick<Location, "protocol" | "hostname">;
};

function parsePayload(payload: SyncPairingQrPayload | string | null | undefined): SyncPairingQrPayload | null {
  if (!payload) return null;
  return typeof payload === "string" ? parsePairingQrUrl(payload) : payload;
}

function currentLocation(input?: Pick<Location, "protocol" | "hostname">): Pick<Location, "protocol" | "hostname"> {
  if (input) return input;
  if (typeof location !== "undefined") return location;
  return { protocol: "https:", hostname: "" } as Pick<Location, "protocol" | "hostname">;
}

function canDialPlainWs(page: Pick<Location, "protocol" | "hostname">): boolean {
  const hostname = page.hostname.toLowerCase();
  return page.protocol === "http:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function urlForCandidate(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${bracketed}:${port}`;
}

function relayUrls(payload: SyncPairingQrPayload | null, environment: WebClientEnvironmentRecord | null): string[] {
  const urls: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && /^wss:\/\//i.test(value) && !urls.includes(value)) urls.push(value);
  };
  add(environment?.relayUrl);
  add(environment?.machineKeyUrl);
  add(payload?.relayUrl);
  for (const candidate of [...(environment?.addressCandidates ?? []), ...(payload?.addressCandidates ?? [])]) {
    if (candidate.kind === "relay") add(candidate.host);
  }
  return urls;
}

function addUnique(candidates: BrowserDialCandidate[], candidate: BrowserDialCandidate): void {
  if (candidates.some((entry) => entry.url === candidate.url && entry.dialable === candidate.dialable)) return;
  candidates.push(candidate);
}

function classifyUrl(url: string, page: Pick<Location, "protocol" | "hostname">, kind: BrowserDialCandidate["kind"]): BrowserDialCandidate {
  if (/^wss:\/\//i.test(url)) return { url, kind, dialable: true };
  if (/^ws:\/\//i.test(url)) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return { url, kind, dialable: false, reason: "invalid_url" };
    }
    if (canDialPlainWs(page)) return { url, kind, dialable: true };
    return {
      url,
      kind,
      dialable: false,
      reason: isLoopbackHost(host) ? "loopback_blocked_from_https" : "plain_ws_blocked_from_https",
    };
  }
  return { url, kind, dialable: false, reason: "unsupported_scheme" };
}

export function deriveBrowserSyncEndpoints(input: EndpointDerivationInput): BrowserDialCandidate[] {
  const payload = parsePayload(input.payload);
  const environment = input.environment ?? null;
  const page = currentLocation(input.location);
  const candidates: BrowserDialCandidate[] = [];
  const port = Math.floor(environment?.port ?? payload?.port ?? 0);

  if (environment?.lastGoodEndpoint) {
    addUnique(candidates, classifyUrl(environment.lastGoodEndpoint, page, "lastGood"));
  }

  for (const relayUrl of relayUrls(payload, environment)) {
    addUnique(candidates, { url: relayUrl, kind: "relay", dialable: true });
  }

  if (port > 0 && port <= 65_535) {
    for (const host of ["127.0.0.1", "localhost"]) {
      const url = urlForCandidate(host, port);
      addUnique(candidates, canDialPlainWs(page)
        ? { url, kind: "loopback", dialable: true, source: { host, kind: "loopback" } }
        : { url, kind: "loopback", dialable: false, reason: "loopback_blocked_from_https", source: { host, kind: "loopback" } });
    }

    const addressCandidates = [...(environment?.addressCandidates ?? []), ...(payload?.addressCandidates ?? [])];
    for (const address of addressCandidates) {
      if (address.kind === "relay" || isLoopbackHost(address.host)) continue;
      const url = urlForCandidate(address.host, port);
      const dialable = page.protocol === "http:";
      addUnique(candidates, {
        url,
        kind: "candidate",
        dialable,
        reason: dialable ? undefined : "plain_ws_blocked_from_https",
        source: address,
      });
    }
  }

  for (const endpoint of environment?.explicitWssEndpoints ?? []) {
    if (/^wss:\/\//i.test(endpoint)) {
      addUnique(candidates, { url: endpoint, kind: "explicitWss", dialable: true });
    }
  }

  return candidates;
}
