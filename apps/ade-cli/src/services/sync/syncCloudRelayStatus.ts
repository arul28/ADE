import type { SyncCloudRelayStatus } from "../../../../desktop/src/shared/types";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
import {
  RELAY_SIGN_IN_REQUIRED_MESSAGE,
  type SyncTunnelClientStatus,
} from "./syncTunnelClientService";

/**
 * The relay status the desktop and the CLI read, built the same way whether a
 * project scope owns sync or the brain answers for the bare machine.
 *
 * Both surfaces had their own copy of this projection and they had already
 * drifted apart in whitespace only — one edit away from drifting in meaning,
 * which would show two different relay stories for one machine.
 *
 * `accountSignedIn` is the gate: without it the live fields collapse to their
 * off values and the error becomes the sign-in prompt, so a signed-out machine
 * never reports a connection it cannot have.
 */
export function buildSyncCloudRelayStatus(args: {
  cloudRelayStore: Pick<SyncCloudRelayStore, "getConfig" | "getRelayUrl" | "getRelayWssUrl">;
  tunnelStatus: SyncTunnelClientStatus | null;
  accountSignedIn: boolean;
}): SyncCloudRelayStatus {
  const { cloudRelayStore, tunnelStatus, accountSignedIn } = args;
  // Built as a variable, not returned inline: the relay self-probe fields below
  // are not in `SyncCloudRelayStatus` yet and both original copies passed them
  // through. Dropping them here would quietly blank the desktop's probe row.
  const status = {
    relayWssUrl: cloudRelayStore.getRelayWssUrl(),
    machineKey: cloudRelayStore.getConfig().machineKey,
    relayUrl: cloudRelayStore.getRelayUrl(),
    connected: accountSignedIn && (tunnelStatus?.connected ?? false),
    activeTunnels: accountSignedIn ? tunnelStatus?.activeTunnels ?? 0 : 0,
    relayBridgeValidated: accountSignedIn && (tunnelStatus?.relayBridgeValidated ?? false),
    lastFailureAt: tunnelStatus?.lastFailureAt ?? null,
    lastControlOpenAt: tunnelStatus?.lastControlOpenAt ?? null,
    lastBridgeValidationAt: tunnelStatus?.lastBridgeValidationAt ?? null,
    relayEndToEndVerifiedAt: tunnelStatus?.relayEndToEndVerifiedAt ?? null,
    relayEndToEndFailure: tunnelStatus?.relayEndToEndFailure ?? null,
    relayEndToEndRoundTripMs: tunnelStatus?.relayEndToEndRoundTripMs ?? null,
    lastControlError: tunnelStatus?.lastControlError ?? null,
    lastError: accountSignedIn
      ? tunnelStatus?.lastError ?? null
      : RELAY_SIGN_IN_REQUIRED_MESSAGE,
  };
  return status;
}
