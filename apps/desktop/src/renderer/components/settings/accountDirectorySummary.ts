import type { SyncRoleSnapshot } from "../../../shared/types";

export function accountDirectorySummary(
  status: SyncRoleSnapshot,
  accountSignedIn: boolean,
): { label: string; healthy: boolean } {
  if (!accountSignedIn) {
    return {
      label: status.pairingPinConfigured
        ? "Not signed in — nearby devices can still connect with the pairing code"
        : "Not signed in — set a pairing code so nearby devices can connect",
      healthy: false,
    };
  }
  const health = status.routeHealth?.accountDirectory;
  if (!health) {
    return {
      label: "Connected to your ADE account · checking machine publication",
      healthy: false,
    };
  }
  if (health.state === "published") {
    if (health.reachableEndpointCount === 0) {
      return {
        label: "Published to your ADE account, but no reachable routes are available",
        healthy: false,
      };
    }
    return {
      label: `Connected to your ADE account · ${health.reachableEndpointCount} route${health.reachableEndpointCount === 1 ? "" : "s"} published`,
      healthy: true,
    };
  }
  const reason = health.skipReason ?? health.state.replaceAll("_", " ");
  return {
    label: `Signed in, but this Mac is not published · ${reason}`,
    healthy: false,
  };
}
