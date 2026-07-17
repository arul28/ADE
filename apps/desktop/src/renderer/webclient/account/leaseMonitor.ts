import type { AdeSyncClient } from "../sync/client";
import {
  browserEndpointRequiresRelayAccess,
  deriveBrowserSyncEndpoints,
} from "../sync/endpoints";
import type { WebClientEnvironmentRecord } from "../sync/envStore";
import type { WebRelayAccess } from "../sync/relayPolicy";
import {
  browserAccountIsSignedIn,
  type BrowserAccountClient,
  type BrowserAccountSnapshot,
} from "./client";

export type AccountLeaseMonitorResult = {
  state: "current" | "transient" | "revoked";
  snapshot: BrowserAccountSnapshot;
};

function activeOwner(snapshot: BrowserAccountSnapshot): string | null {
  if (!browserAccountIsSignedIn(snapshot.state)) return null;
  return snapshot.userId?.trim() || null;
}

export function accountLeaseOwnerForActiveConnection(args: {
  environment: WebClientEnvironmentRecord;
  endpoint: string | null;
  relayAccess: WebRelayAccess;
}): string | null {
  const environmentOwnerUserId = args.environment.accountOwnerUserId?.trim() ?? "";
  if (environmentOwnerUserId) return environmentOwnerUserId;
  if (args.relayAccess.kind !== "signed_in" || !args.endpoint) return null;
  const requiresRelayLease = deriveBrowserSyncEndpoints({
    environment: args.environment,
  }).some((candidate) => (
    candidate.url === args.endpoint
    && browserEndpointRequiresRelayAccess(candidate)
  ));
  return requiresRelayLease ? args.relayAccess.userId.trim() || null : null;
}

export async function reconcileActiveAccountLease(args: {
  accountClient: Pick<BrowserAccountClient, "getAccessToken" | "getSnapshot">;
  syncClient: Pick<AdeSyncClient, "disconnect" | "pruneAccountOwnedEnvironments">;
  expectedOwnerUserId: string;
}): Promise<AccountLeaseMonitorResult> {
  let refreshFailed = false;
  try {
    await args.accountClient.getAccessToken();
  } catch {
    refreshFailed = true;
  }

  const snapshot = args.accountClient.getSnapshot();
  const currentOwnerUserId = activeOwner(snapshot);
  const expectedOwnerUserId = args.expectedOwnerUserId.trim();
  const hasUsableAccountState = browserAccountIsSignedIn(snapshot.state);
  const confirmedInvalid = snapshot.state === "auth_expired"
    || snapshot.state === "signed_out"
    || snapshot.state === "unconfigured"
    || (hasUsableAccountState && (
      !currentOwnerUserId
      || currentOwnerUserId !== expectedOwnerUserId
    ));

  if (!confirmedInvalid) {
    return {
      state: refreshFailed ? "transient" : "current",
      snapshot,
    };
  }

  args.syncClient.disconnect();
  await args.syncClient.pruneAccountOwnedEnvironments(currentOwnerUserId);
  return { state: "revoked", snapshot };
}
