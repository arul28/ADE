import type { AdeSyncClient } from "../sync/client";
import { deriveBrowserSyncEndpoints } from "../sync/endpoints";
import type { WebClientEnvironmentRecord } from "../sync/envStore";
import type { WebRelayAccess } from "../sync/relayPolicy";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "./client";

export type AccountLeaseMonitorResult = {
  state: "current" | "transient" | "revoked";
  snapshot: BrowserAccountSnapshot;
};

function activeOwner(snapshot: BrowserAccountSnapshot): string | null {
  if (snapshot.state !== "signed_in" && snapshot.state !== "directory_unavailable") {
    return null;
  }
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
  const isKnownRelayEndpoint = deriveBrowserSyncEndpoints({
    environment: args.environment,
  }).some((candidate) => candidate.kind === "relay" && candidate.url === args.endpoint);
  return isKnownRelayEndpoint ? args.relayAccess.userId.trim() || null : null;
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
  const hasUsableAccountState = snapshot.state === "signed_in"
    || snapshot.state === "directory_unavailable";
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
