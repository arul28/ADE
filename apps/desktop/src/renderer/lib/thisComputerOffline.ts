import { useEffect, useState } from "react";
import {
  isAccountDirectoryNoReply,
  type SyncRouteHealth,
} from "../../shared/types/sync";

export type RelayRouteHealth = SyncRouteHealth["relay"];

/** The relay fields the outage rules read. */
type RelayOutageInput = Pick<
  RelayRouteHealth,
  "enabled" | "relayControlConnected" | "relayControlSuppressed" | "relayControlFailingSinceMs"
>;

/**
 * How long the relay control has to stay down before we say anything. Relay
 * drops and redials constantly (sleep/wake, Wi-Fi hops, worker deploys); a
 * banner on every blip would be noise. Two minutes of UNINTERRUPTED outage is
 * past every normal reconnect.
 */
const RELAY_OUTAGE_GRACE_MS = 120_000;

export type RelayOutageState = "suppressed" | "down";

/**
 * Decide whether the relay leg is in a state worth telling the user about.
 *
 * `relayControlSuppressed` is immediate: it means this process deliberately
 * stopped redialing because another ADE process on this machine claimed the
 * same machineKey. Nothing recovers that on its own, so a grace period would
 * only delay the fix.
 *
 * Everything else is measured from `relayControlFailingSinceMs` — the start of
 * the CURRENT uninterrupted outage. `lastFailureAt` deliberately isn't used: it
 * restamps on every retry, so it can never measure how long relay has been down.
 */
export function deriveRelayOutageState(
  relay: RelayOutageInput | null | undefined,
  nowMs: number,
): RelayOutageState | null {
  if (!relay) return null;
  if (relay.enabled !== true) return null;
  if (relay.relayControlConnected === true) return null;
  if (relay.relayControlSuppressed === true) return "suppressed";
  const failingSince = relay.relayControlFailingSinceMs;
  if (failingSince == null) return null;
  return nowMs - failingSince > RELAY_OUTAGE_GRACE_MS ? "down" : null;
}

/**
 * Milliseconds until an ongoing outage becomes reportable, or null when no
 * deadline is pending. Shares the predicate above so the timer and the banner
 * can never disagree about what counts as an outage.
 */
export function relayGraceRemainingMs(
  relay: RelayOutageInput | null | undefined,
  nowMs: number,
): number | null {
  if (deriveRelayOutageState(relay, nowMs) != null) return null;
  const failingSince = relay?.relayControlFailingSinceMs;
  if (relay?.enabled !== true || relay.relayControlConnected === true || failingSince == null) {
    return null;
  }
  const remaining = RELAY_OUTAGE_GRACE_MS - (nowMs - failingSince);
  return remaining > 0 ? remaining : null;
}

/**
 * This computer has no internet: two legs fail at once. The relay has been down
 * past its grace, and the account directory publish gets no reply at all (a
 * timeout or a transport error, never an HTTP answer). One leg alone is that
 * service's problem and keeps its own banner; both together are this
 * computer's connection, and every per-service complaint (relay, GitHub, each
 * machine "may be asleep") is a symptom of it.
 *
 * Both legs are Cloudflare Workers, so a network that blocks `workers.dev`
 * (a VPN, proxy or work firewall) looks the same. The copy that shows this
 * state names that case too (`THIS_COMPUTER_OFFLINE_HINT`).
 *
 * A relay the owner turned off, or one suppressed by another ADE process,
 * proves nothing about the network, so neither counts.
 */
export function deriveThisComputerOffline(
  relay: RelayRouteHealth | null | undefined,
  accountDirectoryNoReply: boolean,
  nowMs: number,
): boolean {
  return accountDirectoryNoReply && deriveRelayOutageState(relay, nowMs) === "down";
}

/** The other cause of the offline state, said wherever the state is shown. */
export const THIS_COMPUTER_OFFLINE_HINT =
  "If this computer is online, a VPN, proxy or firewall may be blocking ADE.";

/**
 * Re-renders the caller once when the relay outage crosses its grace. That
 * moment is wall-clock time, not an event, so one timer is armed for exactly
 * the remaining grace; while relay is healthy, suppressed or already past the
 * threshold, no timer exists at all.
 */
export function useRelayGraceRerender(relay: RelayRouteHealth | null | undefined): void {
  const enabled = relay?.enabled ?? null;
  const connected = relay?.relayControlConnected ?? null;
  const suppressed = relay?.relayControlSuppressed ?? null;
  const failingSince = relay?.relayControlFailingSinceMs ?? null;
  const [graceTick, setGraceTick] = useState(0);
  useEffect(() => {
    // Rebuilt from the primitives: the snapshot object is new on every push,
    // and keying on it would re-arm the timer for nothing.
    const remaining = relayGraceRemainingMs(
      {
        enabled: enabled === true,
        relayControlConnected: connected === true,
        relayControlSuppressed: suppressed === true,
        relayControlFailingSinceMs: failingSince,
      },
      Date.now(),
    );
    if (remaining == null) return;
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), remaining + 250);
    return () => clearTimeout(timer);
  }, [enabled, connected, suppressed, failingSince, graceTick]);
}

/** `deriveThisComputerOffline` for a component that holds this computer's route health. */
export function useThisComputerOffline(
  routeHealth: Pick<SyncRouteHealth, "relay" | "accountDirectory"> | null | undefined,
): boolean {
  const relay = routeHealth?.relay ?? null;
  useRelayGraceRerender(relay);
  return deriveThisComputerOffline(
    relay,
    isAccountDirectoryNoReply(routeHealth?.accountDirectory),
    Date.now(),
  );
}
