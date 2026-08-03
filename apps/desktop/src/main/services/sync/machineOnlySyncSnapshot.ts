import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  createSyncAccountDirectoryHealth,
  type SyncDeviceRecord,
  type SyncPeerPlatform,
  type SyncRoleSnapshot,
} from "../../../shared/types";

/**
 * The This-Machine card in Connections describes the computer ADE runs on:
 * its name, platform, and whether it is currently reachable. None of that is
 * knowledge the background service owns — the desktop can answer all of it
 * from the machine layout — yet the only source wired up was a machine-scoped
 * `sync.getStatus` on the local runtime. When the background service is not
 * reachable that call rejects, and the whole card collapses to "Couldn't load
 * connection details" with no machine identity at all.
 *
 * The brain already solves exactly this for its own no-sync-host case
 * (`getMachineOnlySyncStatus` in multiProjectRpcServer): it answers with a
 * machine-only snapshot whose route health is honestly all-down and whose
 * blocking text explains what is missing. This is that same degradation, moved
 * one layer out so it also covers "the runtime could not be reached at all".
 *
 * macOS parity note: launchd keeps the machine brain alive, so a Mac almost
 * never observes an unreachable local runtime and the card looks fine. The
 * Windows startup supervisor genuinely does leave the brain down (a failed
 * bind, a channel collision on the runtime pipe), so Windows is where the
 * missing fallback became a visibly broken panel.
 */

/** Device identity the brain persists per machine; readable without the brain. */
function readMachineSyncIdentity(fileName: string): string {
  try {
    return fs.readFileSync(
      path.join(resolveMachineAdeLayout().secretsDir, fileName),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function mapPlatform(platform: NodeJS.Platform): SyncPeerPlatform {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "unknown";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "The ADE background service is not reachable.";
}

/**
 * A snapshot describing THIS machine with every route reported down.
 *
 * `localDevice.deviceId` is read from the same file the brain uses, so a
 * caller comparing this snapshot's device id against a routed snapshot's (how
 * the renderer detects remote binding) still gets the right answer. When the
 * id has never been written the field is empty, which no routed snapshot can
 * match — the renderer treats that as "not remote-bound", which is correct for
 * a machine whose brain has never run.
 */
export function buildMachineOnlySyncSnapshot(error: unknown): SyncRoleSnapshot {
  const now = new Date().toISOString();
  const reason = errorText(error);
  const hostname = os.hostname();
  const localDevice: SyncDeviceRecord = {
    deviceId: readMachineSyncIdentity("sync-device-id"),
    siteId: readMachineSyncIdentity("sync-site-id"),
    name: hostname,
    platform: mapPlatform(process.platform),
    deviceType: "desktop",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastHost: hostname,
    lastPort: null,
    tailscaleIp: null,
    ipAddresses: [],
    metadata: { hostname },
  };
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
    pairingPin: null,
    pairingPinConfigured: false,
    runtimeName: null,
    pairingConnectInfo: null,
    connectedPeers: [],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "svc:ade-sync",
      servicePort: 0,
      target: null,
      updatedAt: null,
      error: reason,
      stderr: null,
    },
    routeHealth: {
      listener: {
        listenerBound: false,
        loopbackAdeValidated: false,
        port: null,
        lastFailureAt: now,
        reason,
        lastSuccessAt: null,
      },
      tailscale: {
        enabled: false,
        tailscalePublished: false,
        tailscaleReachable: false,
        lastFailureAt: now,
        reason,
        lastSuccessAt: null,
      },
      relay: {
        enabled: false,
        relayControlConnected: false,
        relayBridgeValidated: false,
        lastFailureAt: now,
        skipReason: reason,
        lastControlError: null,
        lastControlOpenAt: null,
        lastBridgeValidationAt: null,
      },
      accountDirectory: createSyncAccountDirectoryHealth("no_active_sync_scope", reason),
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
      message: reason,
      savedDraft: null,
    },
    transferReadiness: {
      ready: false,
      blockers: [],
      survivableState: [],
    },
    survivableStateText: reason,
    blockingStateText: reason,
  };
}
