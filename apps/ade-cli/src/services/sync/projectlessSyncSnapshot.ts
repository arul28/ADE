import fs from "node:fs";
import path from "node:path";
import {
  createSyncAccountDirectoryHealth,
  type SyncAccountDirectoryHealth,
  type SyncDeviceRecord,
  type SyncRoleSnapshot,
} from "../../../../desktop/src/shared/types";
import { localSyncDeviceDefaults } from "./deviceRegistryService";
import { buildPairingConnectInfo } from "./syncPairingConnectInfo";
import { buildRelayRouteHealth, deriveListenerHealth } from "./syncRouteHealth";
import type { SyncLoopbackValidationStatus } from "./syncLoopbackProbe";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";

/**
 * The sync snapshot for a brain that has NO project scope.
 *
 * A machine with nothing in `~/.ade/projects.json` still hosts phone sync: the
 * brain takes the machine-wide sync-host lease and binds the shared listener on
 * a real port (see the projectless branch of `startSyncHost` in cli.ts). Every
 * consumer of sync status, though, used to be fed a hardcoded all-down
 * placeholder, because the only snapshot source was the active project scope's
 * `syncService.getStatus()` and there was no active scope.
 *
 * That placeholder was not merely incomplete, it was wrong: it reported
 * `listenerBound: false` and `pairingConnectInfo: null` for a listener that was
 * genuinely bound. `ade doctor` misreported the machine as unreachable, and —
 * the expensive part — the account-directory publisher gates on exactly those
 * two fields, so a signed-in projectless machine could never publish itself and
 * never appeared in the user's ADE account.
 *
 * This builder reports the truth for both states. When the brain is serving
 * projectless it describes the real listener, the real machine identity, and
 * the real relay; when it is not, it keeps the honest all-down shape rather
 * than optimistically claiming a host that does not exist.
 */

export type ProjectlessSyncSnapshotArgs = {
  /** Machine-level `~/.ade/secrets`, where the brain persists its sync identity. */
  secretsDir: string;
  /**
   * The brain's shared sync listener, or null in a process that never built one
   * (sync disabled, or a consumer that only wants the degraded shape).
   */
  listener: {
    getPort(): number | null;
    getLoopbackValidationStatus(): SyncLoopbackValidationStatus;
  } | null;
  /**
   * Whether this process holds the machine-wide sync-host lease. Hosting is the
   * lease AND a bound listener: a brain that bound a port without winning the
   * lease is not the machine's sync host and must not advertise itself as one.
   */
  holdsSyncHostLease: boolean;
  relay: {
    /** Signed in to an ADE account with a usable session. */
    accountSignedIn: boolean;
    /** This machine's relay URL, already gated on the tunnel being usable. */
    wssUrl: string | null;
    status: SyncTunnelClientStatus | null;
  };
  accountDirectory: SyncAccountDirectoryHealth;
};

const NO_SCOPE_REASON = "No active sync project scope.";

/** Device identity the brain persists per machine; readable without a project DB. */
function readMachineSyncIdentity(secretsDir: string, fileName: string): string {
  try {
    return fs.readFileSync(path.join(secretsDir, fileName), "utf8").trim();
  } catch {
    return "";
  }
}

export function buildProjectlessSyncSnapshot(
  args: ProjectlessSyncSnapshotArgs,
): SyncRoleSnapshot {
  const now = new Date().toISOString();
  const listenerPort = args.listener?.getPort() ?? null;
  // Binding the shared listener IS hosting phone sync, but only the lease
  // holder may say so — see the same gate in relayTunnelAuthorityGate.
  const hosting = args.holdsSyncHostLease && listenerPort != null;

  const defaults = localSyncDeviceDefaults();
  const localDevice: SyncDeviceRecord = {
    deviceId: readMachineSyncIdentity(args.secretsDir, "sync-device-id"),
    siteId: readMachineSyncIdentity(args.secretsDir, "sync-site-id"),
    name: defaults.name,
    platform: defaults.platform,
    deviceType: defaults.deviceType,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastHost: defaults.lastHost,
    lastPort: listenerPort,
    tailscaleIp: defaults.tailscaleIp,
    ipAddresses: defaults.ipAddresses,
    metadata: defaults.metadata,
  };

  const { loopbackAdeValidated, listenerReason, listener: listenerRouteHealth } =
    deriveListenerHealth({
      listenerPort,
      bound: hosting,
      notBoundReason: NO_SCOPE_REASON,
      rawValidation: args.listener?.getLoopbackValidationStatus() ?? {
        port: null,
        loopbackAdeValidated: false,
        lastFailureAt: null,
        reason: NO_SCOPE_REASON,
        lastSuccessAt: null,
      },
    });

  // Same contract as the scoped path: relay is configured whenever this runtime
  // can host phone pairing and enabled once the account is signed in. There is
  // no user toggle.
  const relayRouteHealth = buildRelayRouteHealth({
    relayConfigured: hosting,
    relayAccountSignedIn: args.relay.accountSignedIn
      && (args.relay.status?.accountLeaseValid ?? true),
    loopbackAdeValidated,
    listenerReason,
    listenerPort,
    tunnelStatus: args.relay.status,
    // No listener-probe history to borrow from: this builder is constructed
    // fresh on every call and keeps no state across listener restarts.
    lastFailureAtFallback: null,
  });

  const blockingStateText = hosting
    ? "Register or open a project to sync its chats, lanes, and terminals."
    : "Register or open a project to start machine sync.";
  const statusText = hosting
    ? "This machine hosts phone sync without an open project."
    : NO_SCOPE_REASON;

  return {
    mode: "standalone",
    role: "brain",
    runtimeMode: "standalone",
    runtimeRole: "host",
    localDevice,
    currentBrain: localDevice,
    currentRuntime: localDevice,
    clusterState: null,
    bootstrapToken: null,
    // Publishing a machine to the account directory deliberately does NOT
    // require a pairing code: account membership is the auth path, and the PIN
    // is only a fallback for nearby devices that are not signed in.
    pairingPin: null,
    pairingPinConfigured: false,
    // The runtime name is a per-project-scope setting; a projectless brain has
    // no scope to read one from.
    runtimeName: null,
    pairingConnectInfo: hosting
      ? buildPairingConnectInfo({
          localDevice,
          relayWssUrl: args.relay.wssUrl,
        })
      : null,
    connectedPeers: [],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "svc:ade-sync",
      servicePort: DEFAULT_SYNC_HOST_PORT,
      target: null,
      updatedAt: null,
      // Tailscale Serve is published by a project scope's sync host service,
      // which a projectless brain does not run.
      error: "Tailnet discovery is waiting for an active sync project scope.",
      stderr: null,
    },
    routeHealth: {
      listener: listenerRouteHealth,
      tailscale: {
        enabled: false,
        tailscalePublished: false,
        tailscaleReachable: false,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: null,
      },
      relay: relayRouteHealth,
      accountDirectory: args.accountDirectory,
    },
    client: {
      state: "disconnected",
      host: null,
      port: null,
      connectedAt: null,
      lastSeenAt: null,
      latencyMs: null,
      syncLag: null,
      lastRemoteDbVersion: 0,
      brainDeviceId: null,
      hostDeviceId: null,
      hostName: null,
      error: null,
      message: statusText,
      savedDraft: null,
    },
    transferReadiness: {
      ready: false,
      blockers: [],
      survivableState: [],
    },
    survivableStateText: statusText,
    blockingStateText,
  };
}

/** The all-down shape, for callers with no listener and no lease to report. */
export function buildDegradedProjectlessSyncSnapshot(args: {
  secretsDir: string;
  accountDirectory?: SyncAccountDirectoryHealth;
}): SyncRoleSnapshot {
  return buildProjectlessSyncSnapshot({
    secretsDir: args.secretsDir,
    listener: null,
    holdsSyncHostLease: false,
    relay: { accountSignedIn: false, wssUrl: null, status: null },
    accountDirectory: args.accountDirectory
      ?? createSyncAccountDirectoryHealth(
        "sync_disabled",
        "Account-directory publishing is not enabled in this brain.",
      ),
  });
}
