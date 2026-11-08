import type { DesktopPairedMachineEndpointState } from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeRouteKind,
} from "../../../shared/types/remoteRuntime";
import type { SyncHelloErrorPayload } from "../../../shared/types/sync";
import { isTailnetHostname } from "../../../shared/tailnet";
import {
  isPairedRuntimeSupersededError,
  PairedRuntimeHelloRejectedError,
  PairedRuntimeRelayAuthRequiredError,
} from "./pairedRuntimeErrors";
import { normalizeSyncEndpoint } from "./syncRuntimeTransport";

export type PairedRuntimeEndpointCandidate = {
  endpoint: string;
  kind: Exclude<RemoteRuntimeRouteKind, "ssh">;
  lastSucceededAt: number | null;
  /** Its failure streak is unanswered, so it is tried after every route that is not. */
  failing: boolean;
  lastDiscoveredAt?: number | null;
};

export const MAX_ROUTE_ATTEMPTS = 8;
export const PAIRED_ENDPOINT_FAILURE_THRESHOLD = 2;

/**
 * How long a local-network route gets to open while another route is still
 * waiting behind it. A socket on the same network opens in milliseconds; the
 * default 10 s is for a route that is the last hope. A paired box in a data
 * centre advertises private addresses nobody else can reach, and each of
 * them used to hold the relay back by the full 10 s.
 */
export const LAN_CONNECT_TIMEOUT_WITH_FALLBACK_MS = 3_000;
/**
 * The same for a tailnet route. Tailscale answers in well under a second once
 * its path is up, and a few seconds when it first has to go through a DERP
 * relay; while the far brain restarts, `tailscale serve` still accepts the
 * socket and the handshake hangs, which used to hold every later route back
 * by the full 10 s.
 */
export const TAILNET_CONNECT_TIMEOUT_WITH_FALLBACK_MS = 5_000;

/** The shorter connect deadline for a direct route with another route behind it, or null. */
export function pairedRouteConnectTimeoutMs(
  kind: PairedRuntimeEndpointCandidate["kind"],
  hasFallback: boolean,
): number | null {
  if (!hasFallback) return null;
  if (kind === "lan") return LAN_CONNECT_TIMEOUT_WITH_FALLBACK_MS;
  if (kind === "tailnet") return TAILNET_CONNECT_TIMEOUT_WITH_FALLBACK_MS;
  return null;
}

/** Failures where the address gave no answer at all. Demotion is for these only. */
const ROUTE_SILENT_FAILURES = new Set<RemoteRuntimeConnectionAttemptFailure>([
  "timeout",
  "unreachable",
  "unknown",
]);

/**
 * Teach the saved dial order about a failed route, so a dead address stops
 * going first: after PAIRED_ENDPOINT_FAILURE_THRESHOLD silent failures in a row
 * it is tried last.
 */
export function recordPairedRouteFailure(
  store: { markEndpointFailed(deviceId: string, endpoint: string): void; forgetEndpoint(deviceId: string, endpoint: string): void },
  deviceId: string,
  endpoint: string,
  failure: RemoteRuntimeConnectionAttemptFailure,
): void {
  if (failure === "identity") {
    // A different machine answered here. Demotion clears on any answer, and a
    // neighbour can answer too, so the address is forgotten, not demoted.
    store.forgetEndpoint(deviceId, endpoint);
    return;
  }
  // Only a route that never answered is evidence against the address. Every
  // other failure came from a host that did answer (a rejected pairing or
  // account, a superseded or too-old peer), and demoting that route teaches
  // the dial order nothing about whether the address is alive.
  if (!ROUTE_SILENT_FAILURES.has(failure)) return;
  store.markEndpointFailed(deviceId, endpoint);
}

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

const TIMEOUT_MESSAGE = /timed? out|timeout/i;
const NETWORK_ERRNOS = [
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN",
  "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EPROTO", "EADDRNOTAVAIL",
] as const;
const NETWORK_ERRNO_IN_MESSAGE = new RegExp(`\\b(${NETWORK_ERRNOS.join("|")})\\b`);

/** The first value `pick` finds on an error or the errors that caused it. */
function findInErrorCauses<T>(error: unknown, pick: (candidate: object) => T | undefined): T | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const found = pick(current);
    if (found !== undefined) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The relay's close when a newer link from the host took over (tunnel-relay `CLOSE_CONTROL_REPLACED`). */
const RELAY_CLOSE_CONTROL_REPLACED = 4505;

/**
 * Whether a relay attempt failed because the host opened a new relay link
 * while it ran. A machine back from sleep does that a second or two after it
 * wakes, and the relay then closes every client that went to its old link.
 * The host is on the relay by then, so one more relay attempt at once
 * connects, where the next route (often a cloud box's private address) would
 * hold the connect for 10 s (2026-11-07, Agent 37 box after a sleep).
 */
export function isRelayHostReplacedError(error: unknown): boolean {
  return findInErrorCauses(error, (candidate) =>
    (candidate as { closeCode?: unknown }).closeCode === RELAY_CLOSE_CONTROL_REPLACED || undefined) === true;
}

export function orderPairedCandidates(
  candidates: readonly PairedRuntimeEndpointCandidate[],
): PairedRuntimeEndpointCandidate[] {
  return [
    ...candidates.filter(
      (candidate) => !candidate.failing && candidate.kind !== "relay",
    ),
    ...candidates.filter(
      (candidate) => !candidate.failing && candidate.kind === "relay",
    ),
    ...candidates.filter((candidate) => candidate.failing),
  ];
}

type PairedEndpointFailureEvidence = {
  lastSucceededAt?: number | null;
  lastFailedAt?: number | null;
  consecutiveFailures?: number;
  lastDiscoveredAt?: number | null;
};

/**
 * A route is failing while its failure streak is unanswered: at least
 * PAIRED_ENDPOINT_FAILURE_THRESHOLD dials failed in a row and the address has
 * not answered since. There is no clock window, because the streak is stored
 * with the machine and a dead address would otherwise get the first dial again
 * on every launch. The demotion clears when the address answers, or when mDNS
 * sees it after its last failure. A failing route is demoted, never dropped.
 */
export function pairedEndpointIsFailing(
  evidence: PairedEndpointFailureEvidence,
): boolean {
  const lastFailedAt = evidence.lastFailedAt;
  if (lastFailedAt == null || !Number.isFinite(lastFailedAt)) return false;
  if ((evidence.consecutiveFailures ?? 0) < PAIRED_ENDPOINT_FAILURE_THRESHOLD) {
    return false;
  }
  if ((evidence.lastSucceededAt ?? 0) >= lastFailedAt) return false;
  return (evidence.lastDiscoveredAt ?? 0) <= lastFailedAt;
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
    const failureState = stateByEndpoint.get(endpoint);
    candidates.push({
      endpoint,
      kind: classifyPairedRuntimeEndpoint(endpoint, relayUrl),
      lastSucceededAt: successByEndpoint.get(endpoint) ?? null,
      failing: pairedEndpointIsFailing({
        lastFailedAt: failureState?.lastFailedAt,
        consecutiveFailures: failureState?.consecutiveFailures,
        lastSucceededAt: successByEndpoint.get(endpoint) ?? null,
        lastDiscoveredAt: discoveryByEndpoint.get(endpoint) ?? null,
      }),
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
        Number(left.failing) - Number(right.failing) ||
        // Among failing routes, the one that answered most recently goes first.
        // A failing route's last answer predates its last failure, so this
        // puts a route that answered after another's failure in front of it.
        (left.failing
          ? (right.lastSucceededAt ?? 0) - (left.lastSucceededAt ?? 0)
          : 0) ||
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
  // hosts too old to send `repair_required`. Account problems use their own
  // authentication codes; `relay_account_required` remains the relay-only form.
  auth_failed: "pairing",
  account_not_signed_in: "authentication",
  account_verification_failed: "authentication",
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
  // The host closed the channel because another connection took it over. The
  // close arrives as a plain transport error, so the message regex below would
  // file it as "unreachable" and demote a route that just answered.
  if (isPairedRuntimeSupersededError(error)) return "superseded";
  if (error instanceof PairedRuntimeHelloRejectedError) {
    const mapped = error.helloCode
      ? HELLO_CODE_FAILURES[error.helloCode]
      : undefined;
    // An unknown code is still a host rejection, not a dead route. Older or
    // newer hosts land here; "pairing" points at the only action that helps.
    return mapped ?? "pairing";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (TIMEOUT_MESSAGE.test(message)) return "timeout";
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
 * The specific cause of a failed route as a token safe for telemetry. The
 * error's own message can name the machine and the address it dialed, so only
 * a known errno, a status or a close number is lifted out of it. Undefined when
 * none of them is present.
 */
export function pairedRuntimeFailureCode(error: unknown): string | undefined {
  const structured = findInErrorCauses(error, (candidate) => {
    const { helloCode, closeCode, code } = candidate as { helloCode?: unknown; closeCode?: unknown; code?: unknown };
    // Sent by the other machine, so only the codes this build knows are repeated.
    if (typeof helloCode === "string" && Object.hasOwn(HELLO_CODE_FAILURES, helloCode)) return `hello_${helloCode}`;
    if (typeof closeCode === "number") return `ws_close_${closeCode}`;
    if (typeof code === "string" && NETWORK_ERRNOS.includes(code as (typeof NETWORK_ERRNOS)[number])) return code;
    return undefined;
  });
  if (structured) return structured;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const errno = message.match(NETWORK_ERRNO_IN_MESSAGE);
  if (errno) return errno[1];
  const status = message.match(/Unexpected server response: (\d{3})/);
  if (status) return `http_${status[1]}`;
  return TIMEOUT_MESSAGE.test(message) ? "timeout" : undefined;
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

export type PairedRuntimeAccountHelloCode = Extract<
  SyncHelloErrorPayload["code"],
  "account_not_signed_in" | "account_verification_failed"
>;

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
  accountHelloCode?: PairedRuntimeAccountHelloCode | null,
): string {
  const machine = machineNameValue?.trim() || "that computer";
  switch (failure) {
    case "pairing":
      return `${machine} says this device's pairing is out of date — pair it again.`;
    case "authentication":
      if (accountHelloCode === "account_not_signed_in") {
        return `${machine} is not signed in to an ADE account. Sign in there, then try again.`;
      }
      if (accountHelloCode === "account_verification_failed") {
        return `${machine} could not verify its ADE account session. Open ADE there and check that it is signed in to the same ADE account, then try again.`;
      }
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
