import path from "node:path";
import { randomInt } from "node:crypto";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";
import type { ProjectlessSyncControls } from "../../multiProjectRpcServer";
import { buildSyncCloudRelayStatus, type SyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSyncPairingStore } from "./syncPairingStore";
import { createSyncPinStore } from "./syncPinStore";
import { createSyncSecurityStore } from "./syncSecurityStore";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";

/**
 * The machine-level pairing/PIN/security stores a brain uses when NO project
 * scope owns sync.
 *
 * These were previously built privately inside
 * `createBrainProjectActionsSyncHandler`, which made them unreachable from the
 * RPC surface: `ade sync pin generate` and the desktop's `ade.sync.setPin` both
 * resolved a project-scoped sync service and failed with "Sync service is not
 * available" on a machine that had never opened a project.
 *
 * The stores are created once per secrets directory because pairing identity is
 * shared state — the PIN, the paired-device list, and the security posture are
 * one machine's, not one caller's. Handing every surface the same instances
 * keeps in-memory state (failed-attempt counters, the plaintext PIN this
 * process just generated) consistent with what the ingress path enforces.
 */
export type BrainMachineSyncStores = {
  pinStore: ReturnType<typeof createSyncPinStore>;
  pairingStore: ReturnType<typeof createSyncPairingStore>;
  securityStore: ReturnType<typeof createSyncSecurityStore>;
};

const storesBySecretsDir = new Map<string, BrainMachineSyncStores>();

/** Six digits, zero-padded — the same shape the project-scoped host generates. */
export function generateMachinePairingPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function resolveBrainMachineSyncStores(secretsDir: string): BrainMachineSyncStores {
  const resolvedDir = path.resolve(secretsDir);
  // Canonical key, not a bare case fold: on Windows the same directory can
  // arrive as `C:\Users\...` or `\\?\C:\Users\...`, and two keys for one
  // directory would hand out two sets of stores — the split the shared
  // instances exist to prevent. Only the map key is normalized; file
  // operations use the resolved path as the caller spelled it.
  const key = pathKey(resolvedDir);
  const existing = storesBySecretsDir.get(key);
  if (existing) return existing;
  const pinStore = createSyncPinStore({ filePath: path.join(resolvedDir, "sync-pin.json") });
  const stores: BrainMachineSyncStores = {
    pinStore,
    pairingStore: createSyncPairingStore({
      filePath: path.join(resolvedDir, "sync-paired-devices.json"),
      pinStore,
    }),
    // Same machine-level posture file the project sync host reads, so
    // `requireDpop` binds on the projectless ingress path too.
    securityStore: createSyncSecurityStore({
      filePath: path.join(resolvedDir, "sync-security.json"),
    }),
  };
  storesBySecretsDir.set(key, stores);
  return stores;
}

/** Test seam: drop the process-wide cache between temp-directory fixtures. */
export function resetBrainMachineSyncStoresForTests(): void {
  storesBySecretsDir.clear();
}

export type ProjectlessSyncControlsArgs = {
  stores: BrainMachineSyncStores;
  cloudRelayStore: SyncCloudRelayStore;
  /** Null until the projectless relay tunnel has been built. */
  getTunnelStatus: () => SyncTunnelClientStatus | null;
  /**
   * Does the signed-in account still own this machine? Ownership, not
   * usability: an expired or unreadable session keeps the relay advertised so
   * already-paired devices keep connecting.
   */
  accountRetainsMachineOwnership: () => boolean;
};

/**
 * The `sync.*` controls a brain answers with no project scope.
 *
 * Lets `ade sync pin generate` and the desktop's pairing UI set a PIN on a
 * machine that has never opened a project. Both used to resolve a
 * project-scoped sync service and fail, which left a fresh install with no way
 * to pair at all.
 */
export function createProjectlessSyncControls(
  args: ProjectlessSyncControlsArgs,
): ProjectlessSyncControls {
  const { stores, cloudRelayStore } = args;
  return {
    getPin: () => stores.pinStore.getPin(),
    setPin: (pin) => stores.pinStore.setPin(pin),
    generatePin: () => {
      const pin = generateMachinePairingPin();
      stores.pinStore.setPin(pin);
      return pin;
    },
    clearPin: () => stores.pinStore.clearPin(),
    getRequireDpop: () => stores.securityStore.getRequireDpop(),
    setRequireDpop: (requireDpop) => {
      stores.securityStore.setRequireDpop(requireDpop);
      return stores.securityStore.getRequireDpop();
    },
    forgetDevice: (deviceId) => stores.pairingStore.revoke(deviceId),
    getCloudRelayStatus: () => {
      const tunnelStatus = args.getTunnelStatus();
      return buildSyncCloudRelayStatus({
        cloudRelayStore,
        tunnelStatus,
        accountSignedIn: args.accountRetainsMachineOwnership()
          && (tunnelStatus?.accountLeaseValid ?? true),
      });
    },
  };
}
