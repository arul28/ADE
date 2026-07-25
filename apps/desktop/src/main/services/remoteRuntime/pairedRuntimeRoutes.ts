import type { DesktopPairedMachineEndpointState } from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeRouteKind,
} from "../../../shared/types/remoteRuntime";
import { isTailnetHostname } from "../../../shared/tailnet";
import { normalizeSyncEndpoint } from "./syncRuntimeTransport";

export type PairedRuntimeEndpointCandidate = {
  endpoint: string;
  kind: Exclude<RemoteRuntimeRouteKind, "ssh">;
  lastSucceededAt: number | null;
  lastDiscoveredAt?: number | null;
};

function normalizedEndpointOrNull(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  try {
    return normalizeSyncEndpoint(value);
  } catch {
    return null;
  }
}

export function classifyPairedRuntimeEndpoint(
  endpointValue: string,
  relayUrl?: string | null,
): Exclude<RemoteRuntimeRouteKind, "ssh"> {
  const endpoint = normalizeSyncEndpoint(endpointValue);
  const normalizedRelay = normalizedEndpointOrNull(relayUrl);
  if (normalizedRelay && endpoint === normalizedRelay) return "relay";
  const url = new URL(endpoint);
  if (isTailnetHostname(url.hostname)) return "tailnet";
  // Direct sync is currently plain ws; relay transport is system-trusted wss.
  // The explicit relayUrl check above keeps a future tailnet wss route visible
  // as tailnet instead of collapsing it into the relay bucket.
  return url.protocol === "wss:" ? "relay" : "lan";
}

export function syncEndpointForHost(hostValue: string, port: number): string {
  const host = hostValue.trim().replace(/\.$/, "");
  if (!host) throw new Error("A sync endpoint host is required.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("A sync endpoint port from 1 to 65535 is required.");
  }
  if (/^wss?:\/\//i.test(host) || /^https?:\/\//i.test(host)) {
    return normalizeSyncEndpoint(host);
  }
  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return normalizeSyncEndpoint(`ws://${urlHost}:${port}`);
}

export function buildPairedEndpointCandidates(args: {
  endpoints: string[];
  relayUrl?: string | null;
  endpointStates?: DesktopPairedMachineEndpointState[] | null;
  additionalEndpoints?: string[];
}): PairedRuntimeEndpointCandidate[] {
  const relayUrl = normalizedEndpointOrNull(args.relayUrl);
  const successByEndpoint = new Map<string, number>();
  const discoveryByEndpoint = new Map<string, number>();
  for (const state of args.endpointStates ?? []) {
    const endpoint = normalizedEndpointOrNull(state.endpoint);
    if (!endpoint) continue;
    if (
      state.lastSucceededAt != null
      && Number.isFinite(state.lastSucceededAt)
    ) {
      successByEndpoint.set(
        endpoint,
        Math.max(successByEndpoint.get(endpoint) ?? 0, state.lastSucceededAt),
      );
    }
    if (
      state.lastDiscoveredAt != null
      && Number.isFinite(state.lastDiscoveredAt)
    ) {
      discoveryByEndpoint.set(
        endpoint,
        Math.max(discoveryByEndpoint.get(endpoint) ?? 0, state.lastDiscoveredAt),
      );
    }
  }

  const values = [
    ...args.endpoints,
    ...(args.additionalEndpoints ?? []),
    ...(relayUrl ? [relayUrl] : []),
  ];
  const candidates: Array<PairedRuntimeEndpointCandidate & { order: number }> =
    [];
  const seen = new Set<string>();
  for (const value of values) {
    const endpoint = normalizedEndpointOrNull(value);
    if (!endpoint || seen.has(endpoint)) continue;
    seen.add(endpoint);
    candidates.push({
      endpoint,
      kind: classifyPairedRuntimeEndpoint(endpoint, relayUrl),
      lastSucceededAt: successByEndpoint.get(endpoint) ?? null,
      ...(discoveryByEndpoint.has(endpoint)
        ? { lastDiscoveredAt: discoveryByEndpoint.get(endpoint)! }
        : {}),
      order: candidates.length,
    });
  }

  const rank: Record<PairedRuntimeEndpointCandidate["kind"], number> = {
    lan: 0,
    tailnet: 1,
    relay: 2,
  };
  return candidates
    .sort(
      (left, right) =>
        rank[left.kind] - rank[right.kind] ||
        (right.lastDiscoveredAt ?? 0) - (left.lastDiscoveredAt ?? 0) ||
        (right.lastSucceededAt ?? 0) - (left.lastSucceededAt ?? 0) ||
        left.order - right.order,
    )
    .map(({ order: _order, ...candidate }) => candidate);
}

export function pairedRuntimeRouteHost(
  endpointValue: string,
): string {
  try {
    const url = new URL(normalizeSyncEndpoint(endpointValue));
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`.slice(0, 128);
  } catch {
    return "unknown";
  }
}

export function classifyPairedRuntimeFailure(
  error: unknown,
): RemoteRuntimeConnectionAttemptFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return "timeout";
  if (/auth|sign in|token|credential|proof|forbidden|unauthorized/i.test(message)) {
    return "authentication";
  }
  if (/identity|signature|host key|device id|certificate/i.test(message)) {
    return "identity";
  }
  if (/feature|capabilit|port-forward|not advertise/i.test(message)) {
    return "capability";
  }
  if (/protocol|initialize|version|incompatib|malformed|invalid payload/i.test(message)) {
    return "protocol";
  }
  if (/ECONN|EHOST|ENET|unreach|offline|closed|socket|websocket|failed to connect/i.test(message)) {
    return "unreachable";
  }
  return "unknown";
}
