import type {
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeLocalPairingInfo,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";

/**
 * The hosted client is already attached to one paired machine. It has no
 * desktop-local target registry, SSH discovery, or pairing host, but shared
 * shell components still require concrete collection-shaped read results.
 */
export function createRemoteRuntimeNamespace(infra: AdapterInfra): AdeNamespace<"remoteRuntime"> {
  const emptySnapshot: RemoteRuntimeConnectionSnapshot = {
    connections: [],
    connectedCount: 0,
    updatedAt: Date.now(),
  };
  const emptyDiscovery: RemoteRuntimeDiscoveryResult = {
    machines: [],
    diagnostics: [],
  };

  const unsupported = async (): Promise<never> => {
    throw new Error("Desktop machine management is unavailable in ADE Web.");
  };

  return {
    listTargets: async () => [],
    getConnectionSnapshot: async () => emptySnapshot,
    onConnectionSnapshotChanged: () => () => {},
    listDiscoveredMachines: async () => emptyDiscovery,
    getLocalPairingInfo: async (): Promise<RemoteRuntimeLocalPairingInfo> => ({
      url: "",
      pin: null,
      machineName: infra.client.getStatus().hostName ?? "Connected machine",
      relayAvailable: false,
    }),
    runDoctor: async () => ({ checks: [] }),
    parsePairingInput: unsupported,
    pairWithMachine: unsupported,
    saveTarget: unsupported,
    setAutoConnect: unsupported,
    removeTarget: unsupported,
    getSshHostKeyTrust: unsupported,
    trustSshHostKey: unsupported,
    connect: unsupported,
    listProjects: async () => [],
  } satisfies AdeNamespace<"remoteRuntime">;
}
