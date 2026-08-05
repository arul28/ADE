import type { SyncRouteHealth } from "../../../../desktop/src/shared/types";
import type { SyncLoopbackValidationStatus } from "./syncLoopbackProbe";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";

/**
 * How a machine describes its own inbound routes.
 *
 * Two callers derive this from the same raw inputs: `syncService.getStatus`,
 * for a brain with an active project scope, and `buildProjectlessSyncSnapshot`,
 * for one hosting phone sync with no scope at all. The strings are what the
 * user actually reads in Settings and in `ade doctor`, and the account-machine
 * publisher gates on the booleans — so the two paths disagreeing is not a
 * cosmetic drift, it is one of them lying about whether the machine is
 * reachable.
 *
 * The genuine differences between the two are parameters, not branches inside
 * these functions: what "not bound" means (a listener that failed to start vs
 * a machine with no scope), and which timestamp stands in when the tunnel
 * itself reports no failure time.
 */

export type ListenerRouteHealth = SyncRouteHealth["listener"];

/**
 * The relay shape with the end-to-end probe fields kept. They belong to
 * `AccountMachineRegistrationSnapshot`'s widened relay shape, which
 * `SyncRouteHealth` itself does not declare, and a bare object literal
 * assignment would drop them.
 */
export type RelayRouteHealth = SyncRouteHealth["relay"] & {
  relayEndToEndVerifiedAt: string | null;
  relayEndToEndFailure: string | null;
  relayEndToEndRoundTripMs: number | null;
};

export type ListenerHealth = {
  loopbackAdeValidated: boolean;
  /** Also feeds the Tailscale and Relay reasons, which quote it verbatim. */
  listenerReason: string | null;
  listener: ListenerRouteHealth;
};

export type DeriveListenerHealthArgs = {
  listenerPort: number | null;
  rawValidation: SyncLoopbackValidationStatus;
  /**
   * Whether this process is actually serving on that port. A bound port is not
   * enough for the projectless brain, which must also hold the machine-wide
   * sync-host lease.
   */
  bound: boolean;
  /** What to tell the user when `bound` is false; the two callers mean different things by it. */
  notBoundReason: string;
  /**
   * Last-probe timestamps the caller has accumulated across listener restarts,
   * used when the current validation result carries none.
   */
  validationHistory?: Pick<SyncLoopbackValidationStatus, "lastFailureAt" | "lastSuccessAt">;
};

export type BuildRelayRouteHealthArgs = {
  /** This runtime can host phone pairing at all. There is no user toggle. */
  relayConfigured: boolean;
  relayAccountSignedIn: boolean;
  loopbackAdeValidated: boolean;
  listenerReason: string | null;
  listenerPort: number | null;
  tunnelStatus: SyncTunnelClientStatus | null;
  /**
   * Stands in for `lastFailureAt` while relay is enabled but skipped and the
   * tunnel has no failure time of its own — normally the loopback probe's last
   * failure. Pass null to report no time rather than borrow one.
   */
  lastFailureAtFallback: string | null;
};

function resolveListenerReason(args: {
  bound: boolean;
  notBoundReason: string;
  loopbackAdeValidated: boolean;
  rawValidation: SyncLoopbackValidationStatus;
  listenerPort: number | null;
}): string | null {
  if (!args.bound) return args.notBoundReason;
  if (args.loopbackAdeValidated) return null;
  return args.rawValidation.reason ?? `127.0.0.1:${args.listenerPort} did not answer as ADE.`;
}

export function deriveListenerHealth(args: DeriveListenerHealthArgs): ListenerHealth {
  // A validation result only counts while it still describes the port that is
  // currently bound; a stale one would report a rebound listener as healthy.
  const loopbackAdeValidated = args.bound
    && args.rawValidation.port === args.listenerPort
    && args.rawValidation.loopbackAdeValidated;
  const listenerReason = resolveListenerReason({
    bound: args.bound,
    notBoundReason: args.notBoundReason,
    loopbackAdeValidated,
    rawValidation: args.rawValidation,
    listenerPort: args.listenerPort,
  });
  return {
    loopbackAdeValidated,
    listenerReason,
    listener: {
      listenerBound: args.bound,
      loopbackAdeValidated,
      port: args.bound ? args.listenerPort : null,
      lastFailureAt: args.rawValidation.lastFailureAt ?? args.validationHistory?.lastFailureAt ?? null,
      reason: listenerReason,
      lastSuccessAt: args.rawValidation.lastSuccessAt ?? args.validationHistory?.lastSuccessAt ?? null,
    },
  };
}

function resolveRelaySkipReason(args: BuildRelayRouteHealthArgs & {
  relayEnabled: boolean;
  relayControlConnected: boolean;
  relayBridgeValidated: boolean;
}): string | null {
  if (args.relayConfigured && !args.relayAccountSignedIn) return "Sign in to ADE to use ADE Relay.";
  if (!args.relayEnabled) return null;
  if (!args.loopbackAdeValidated) {
    return `Relay route is unusable because ${args.listenerReason ?? "the loopback ADE check failed"}`;
  }
  const status = args.tunnelStatus;
  if (!status) return "Relay tunnel status is unavailable in this ADE process.";
  if (!args.relayControlConnected) {
    // A 4505 eviction is a machine-local ownership conflict, not a network
    // fault, and its reason is the only one that tells the user what to
    // actually do — so it outranks the raw close text.
    return status.controlSuppressedReason
      ?? status.lastControlError
      ?? status.lastError
      ?? "Relay control is not connected.";
  }
  if (!args.relayBridgeValidated) {
    return status.lastError
      ?? `Relay bridge to 127.0.0.1:${args.listenerPort} has not been validated against the current sync port.`;
  }
  return status.bridgeOpenFailure ?? null;
}

export function buildRelayRouteHealth(args: BuildRelayRouteHealthArgs): RelayRouteHealth {
  const relayEnabled = args.relayConfigured && args.relayAccountSignedIn;
  const relayControlConnected = args.tunnelStatus?.connected === true;
  const relayBridgeValidated = args.tunnelStatus?.relayBridgeValidated === true;
  const skipReason = resolveRelaySkipReason({
    ...args,
    relayEnabled,
    relayControlConnected,
    relayBridgeValidated,
  });
  return {
    enabled: relayEnabled,
    relayControlConnected,
    relayBridgeValidated,
    lastFailureAt: args.tunnelStatus?.lastFailureAt
      ?? (relayEnabled && skipReason ? args.lastFailureAtFallback : null),
    skipReason,
    lastControlError: args.tunnelStatus?.lastControlError ?? null,
    lastControlOpenAt: args.tunnelStatus?.lastControlOpenAt ?? null,
    lastBridgeValidationAt: args.tunnelStatus?.lastBridgeValidationAt ?? null,
    relayEndToEndVerifiedAt: args.tunnelStatus?.relayEndToEndVerifiedAt ?? null,
    relayEndToEndFailure: args.tunnelStatus?.relayEndToEndFailure ?? null,
    relayEndToEndRoundTripMs: args.tunnelStatus?.relayEndToEndRoundTripMs ?? null,
    relayControlSuppressed: args.tunnelStatus?.controlSuppressed === true,
    relayControlSuppressedReason: args.tunnelStatus?.controlSuppressedReason ?? null,
    relayControlFailingSinceMs: args.tunnelStatus?.controlFailingSinceMs ?? null,
  };
}
