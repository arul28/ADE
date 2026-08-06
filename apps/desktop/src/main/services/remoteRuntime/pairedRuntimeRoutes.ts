import type { DesktopPairedMachineEndpointState } from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeRouteKind,
} from "../../../shared/types/remoteRuntime";
import type { SyncHelloErrorPayload } from "../../../shared/types/sync";
import { isTailnetHostname } from "../../../shared/tailnet";
import {
  PairedRuntimeHelloRejectedError,
  PairedRuntimeRelayAuthRequiredError,
} from "./pairedRuntimeErrors";
import { normalizeSyncEndpoint } from "./syncRuntimeTransport";

export type PairedRuntimeEndpointCandidate = {
  endpoint: string;
  kind: Exclude<RemoteRuntimeRouteKind, "ssh">;
  lastSucceededAt: number | null;
  recentlyFailing: boolean;
  lastDiscoveredAt?: number | null;
};

export const MAX_ROUTE_ATTEMPTS = 8;
export const PAIRED_ENDPOINT_FAILURE_THRESHOLD = 2;
export const PAIRED_ENDPOINT_RECENT_FAILURE_WINDOW_MS = 120_000;

export type PairedRouteAttemptRecorder = {
  attempts: RemoteRuntimeConnectionAttempt[];
  omittedAttemptCount: number;
  record: (attempt: RemoteRuntimeConnectionAttempt) => void;
};

export function createRouteAttemptRecorder(
  maxAttempts = MAX_ROUTE_ATTEMPTS,
): PairedRouteAttemptRecorder {
  const recorder: PairedRouteAttemptRecorder = {
    attempts: [],
    omittedAttemptCount: 0,
    record: (attempt) => {
      if (recorder.attempts.length < maxAttempts) {
        recorder.attempts.push(attempt);
        return;
      }
      if (attempt.outcome !== "skipped") {
        const skippedIndex = recorder.attempts.findIndex(
          (recorded) => recorded.outcome === "skipped",
        );
        if (skippedIndex >= 0) {
          recorder.attempts.splice(skippedIndex, 1);
          recorder.attempts.push(attempt);
          recorder.omittedAttemptCount += 1;
          return;
        }
      }
      recorder.omittedAttemptCount += 1;
    },
  };
  return recorder;
}

export function orderPairedCandidates(
  candidates: readonly PairedRuntimeEndpointCandidate[],
): PairedRuntimeEndpointCandidate[] {
  return [
    ...candidates.filter(
      (candidate) => !candidate.recentlyFailing && candidate.kind !== "relay",
    ),
    ...candidates.filter(
      (candidate) => !candidate.recentlyFailing && candidate.kind === "relay",
    ),
    ...candidates.filter((candidate) => candidate.recentlyFailing),
  ];
}

export function pairedEndpointIsRecentlyFailing(
  state: DesktopPairedMachineEndpointState | null | undefined,
  nowMs = Date.now(),
): boolean {
  return state?.lastFailedAt != null
    && Number.isFinite(state.lastFailedAt)
    && (state.consecutiveFailures ?? 0) >= PAIRED_ENDPOINT_FAILURE_THRESHOLD
    && nowMs - state.lastFailedAt <= PAIRED_ENDPOINT_RECENT_FAILURE_WINDOW_MS;
}

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
  nowMs?: number;
}): PairedRuntimeEndpointCandidate[] {
  const relayUrl = normalizedEndpointOrNull(args.relayUrl);
  const successByEndpoint = new Map<string, number>();
  const discoveryByEndpoint = new Map<string, number>();
  const stateByEndpoint = new Map<string, DesktopPairedMachineEndpointState>();
  for (const state of args.endpointStates ?? []) {
    const endpoint = normalizedEndpointOrNull(state.endpoint);
    if (!endpoint) continue;
    const previous = stateByEndpoint.get(endpoint);
    if (
      !previous
      || (state.lastFailedAt ?? 0) >= (previous.lastFailedAt ?? 0)
    ) {
      stateByEndpoint.set(endpoint, state);
    }
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
      recentlyFailing: pairedEndpointIsRecentlyFailing(
        stateByEndpoint.get(endpoint),
        args.nowMs,
      ),
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
        Number(left.recentlyFailing) - Number(right.recentlyFailing) ||
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

/**
 * `hello_error.code` → attempt failure. This is the whole point of the code:
 * a host rejection is classified from what the host said it was, never from the
 * prose it wrote for the user. Regex classification below applies only to
 * transport-level failures, which carry no structured code.
 */
const HELLO_CODE_FAILURES: Record<
  SyncHelloErrorPayload["code"],
  RemoteRuntimeConnectionAttemptFailure
> = {
  repair_required: "pairing",
  // Desktop→desktop dials with `auth.kind: "paired"`, so the host's generic
  // `auth_failed` here is always a pairing-record rejection — including from
  // hosts too old to send `repair_required`. Account problems arrive as
  // `relay_account_required`, which has its own row.
  auth_failed: "pairing",
  relay_account_required: "authentication",
  // The host is fine and the pairing is fine — it just cannot verify ADE
  // accounts yet. "Pair it again" would send the user in circles; the update
  // headline is the one that resolves it.
  host_update_required: "protocol",
  // The account session moved under the handshake. Retry after signing in —
  // never a reason to drop a saved pairing.
  account_session_changed: "authentication",
  connection_attempt_superseded: "superseded",
  invalid_hello: "protocol",
  protocol_version_mismatch: "protocol",
};

export function classifyPairedRuntimeFailure(
  error: unknown,
): RemoteRuntimeConnectionAttemptFailure {
  if (error instanceof PairedRuntimeRelayAuthRequiredError) return "authentication";
  if (error instanceof PairedRuntimeHelloRejectedError) {
    const mapped = error.helloCode
      ? HELLO_CODE_FAILURES[error.helloCode]
      : undefined;
    // An unknown code is still a host rejection, not a dead route. Older or
    // newer hosts land here; "pairing" points at the only action that helps.
    return mapped ?? "pairing";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return "timeout";
  if (/ECONN|EHOST|ENET|\bunreach|\boffline\b|\bsocket (?:error|failed)|failed to connect/i.test(message)) {
    return "unreachable";
  }
  if (/\bauth(?:entication|orization)?\b|\bauthori[sz]ed\b|\bsign in\b|\btoken\b|\bcredential|\bproof\b|\bforbidden\b|\bunauthorized\b/i.test(message)) {
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
  if (/closed|socket|websocket/i.test(message)) return "unreachable";
  return "unknown";
}

/**
 * Precedence, not a tally. A single "your pairing is stale" rejection tells the
 * user exactly what to do, and it stays true no matter how many other routes
 * were simply dead — so it outranks a pile of unreachable addresses.
 */
const FAILURE_PRECEDENCE: readonly RemoteRuntimeConnectionAttemptFailure[] = [
  "pairing",
  "authentication",
  "identity",
  "capability",
  "protocol",
  "superseded",
  "timeout",
  "unreachable",
  "unknown",
];

export function dominantPairedRuntimeFailure(
  attempts: readonly RemoteRuntimeConnectionAttempt[],
): RemoteRuntimeConnectionAttemptFailure {
  const seen = new Set(
    attempts.flatMap((attempt) => (attempt.failure ? [attempt.failure] : [])),
  );
  return FAILURE_PRECEDENCE.find((failure) => seen.has(failure)) ?? "unknown";
}

/**
 * The headline a person reads. One sentence, one next step, no hostnames,
 * ports, or route lists — every one of those lives in the attempts array behind
 * the UI's route details.
 */
export function pairedRuntimeFailureMessage(
  failure: RemoteRuntimeConnectionAttemptFailure,
  machineNameValue: string | null | undefined,
): string {
  const machine = machineNameValue?.trim() || "that computer";
  switch (failure) {
    case "pairing":
      return `${machine} says this device's pairing is out of date — pair it again.`;
    case "authentication":
      return "Sign in to ADE to connect through the relay.";
    case "identity":
      return `A different computer answered at ${machine}'s saved address — try again.`;
    case "capability":
    case "protocol":
      return `${machine} is running an older ADE — update it there, then try again.`;
    case "superseded":
      return `Another connection to ${machine} took over — try again.`;
    default:
      return `Can't reach ${machine} — it may be asleep or ADE may be stopped there.`;
  }
}
