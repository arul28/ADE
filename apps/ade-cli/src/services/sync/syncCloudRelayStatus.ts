import type { SyncCloudRelayStatus } from "../../../../desktop/src/shared/types";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
import {
  RELAY_SIGN_IN_REQUIRED_MESSAGE,
  type SyncTunnelClientStatus,
} from "./syncTunnelClientService";

/**
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
  return {
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
}
