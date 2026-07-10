import type {
  DesktopPairedMachineCredentials,
} from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import {
  coerceProjects,
  validateRemoteRuntimeInitializeResult,
} from "./remoteBootstrap";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import { RuntimeRpcClient } from "./runtimeRpcClient";
import type { DesktopPairedMachineStore } from "./syncPairedMachineStore";
import {
  createSyncPortForwardClient,
  type SyncPortForwardClient,
} from "./syncPortForwardClient";
import {
  openSyncRuntimeTransport,
  type SyncRuntimeTransport,
} from "./syncRuntimeTransport";
import { buildPairedEndpointCandidates } from "./pairedRuntimeRoutes";
import {
  PairedRuntimeCompatibilityError,
  PairedRuntimeTransportUnavailableError,
} from "./pairedRuntimeErrors";

export type PairedRuntimeBootstrapResult = {
  client: RuntimeRpcClient;
  transport: SyncRuntimeTransport;
  portForwardClient: SyncPortForwardClient;
  result: RemoteRuntimeConnectResult;
};

type PairedRuntimeBootstrapOptions = {
  openTransport?: typeof openSyncRuntimeTransport;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function credentialsForTarget(
  target: RemoteRuntimeTarget,
  store: DesktopPairedMachineStore,
): DesktopPairedMachineCredentials | null {
  const reference = target.pairedMachine;
  if (!reference) return null;
  return store.get(reference.hostIdentity)
    ?? (reference.machineKey ? store.get(reference.machineKey) : null);
}

function pairedArch(
  target: RemoteRuntimeTarget,
  credentials: DesktopPairedMachineCredentials,
): string {
  if (target.lastSeenArch?.trim()) return target.lastSeenArch.trim();
  switch (credentials.hostIdentity.platform) {
    case "macOS":
      return "darwin";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function isPairedTransportFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return /sync (?:websocket|connection|endpoint)|runtime rpc channel|rpc channel (?:is )?(?:closed|unavailable)|failed to connect|timed out (?:connecting|waiting for (?:sync|method))|connection closed|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(
    message,
  );
}

function compatibilityError(error: unknown): PairedRuntimeCompatibilityError {
  return new PairedRuntimeCompatibilityError(
    `The paired ADE runtime could not initialize compatibly: ${errorMessage(error)} `
      + "Connect to this machine with SSH to update its ADE runtime, then try the paired connection again.",
    error,
  );
}

export async function bootstrapPairedRuntime(args: {
  target: RemoteRuntimeTarget;
  registry: RemoteTargetRegistry;
  pairedStore: DesktopPairedMachineStore;
  appVersion: string;
  options?: PairedRuntimeBootstrapOptions;
}): Promise<PairedRuntimeBootstrapResult> {
  const credentials = credentialsForTarget(args.target, args.pairedStore);
  if (!credentials) {
    throw new PairedRuntimeTransportUnavailableError(
      "The paired-machine credentials for this remote target were not found.",
    );
  }
  const candidates = buildPairedEndpointCandidates({
    endpoints: credentials.endpoints,
    relayUrl: credentials.relayUrl,
    endpointStates: credentials.endpointStates,
  });
  if (candidates.length === 0) {
    throw new PairedRuntimeTransportUnavailableError(
      "The paired machine has no usable sync endpoints.",
    );
  }

  const openTransport = args.options?.openTransport ?? openSyncRuntimeTransport;
  const routeErrors: string[] = [];
  for (const candidate of candidates) {
    let transport: SyncRuntimeTransport;
    try {
      transport = await openTransport({
        credentials,
        endpoint: candidate.endpoint,
        appVersion: args.appVersion,
      });
    } catch (error) {
      routeErrors.push(`${candidate.endpoint}: ${errorMessage(error)}`);
      continue;
    }

    if (transport.connection.hello.features?.portForward !== true) {
      transport.close();
      routeErrors.push(
        `${candidate.endpoint}: the paired machine does not advertise port-forward support`,
      );
      continue;
    }

    const client = new RuntimeRpcClient(transport);
    let initializeResult: unknown;
    const latencyStartedAt = Date.now();
    try {
      initializeResult = await client.initialize(
        "ade-desktop-remote",
        args.appVersion,
      );
    } catch (error) {
      client.close();
      if (isPairedTransportFailure(error)) {
        routeErrors.push(`${candidate.endpoint}: ${errorMessage(error)}`);
        continue;
      }
      throw compatibilityError(error);
    }
    const latencyMs = Math.max(0, Date.now() - latencyStartedAt);

    let initializeInfo: ReturnType<typeof validateRemoteRuntimeInitializeResult>;
    try {
      initializeInfo = validateRemoteRuntimeInitializeResult({
        result: initializeResult,
        expectedVersion: args.appVersion,
      });
    } catch (error) {
      client.close();
      throw compatibilityError(error);
    }

    let projects;
    try {
      projects = coerceProjects(await client.call("projects.list", {}));
    } catch (error) {
      client.close();
      if (isPairedTransportFailure(error)) {
        routeErrors.push(`${candidate.endpoint}: ${errorMessage(error)}`);
        continue;
      }
      throw compatibilityError(error);
    }

    try {
      const connectedAt = Date.now();
      const updated = args.registry.update(args.target.id, {
        lastSeenArch: pairedArch(args.target, credentials),
        runtimeBinaryVersion: initializeInfo.version,
        lastConnectedAt: connectedAt,
      });
      args.pairedStore.markEndpointSucceeded(
        credentials.hostIdentity.deviceId,
        candidate.endpoint,
        connectedAt,
      );
      const portForwardClient = createSyncPortForwardClient(transport.connection);
      return {
        client,
        transport,
        portForwardClient,
        result: {
          target: updated,
          arch: updated.lastSeenArch ?? "unknown",
          version: initializeInfo.version,
          route: {
            kind: candidate.kind,
            endpoint: candidate.endpoint,
            latencyMs,
          },
          capabilities: initializeInfo.capabilities,
          compatibilityWarnings: initializeInfo.compatibilityWarnings,
          projects,
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  throw new PairedRuntimeTransportUnavailableError(
    "Could not reach the paired ADE runtime over LAN, tailnet, or relay. "
      + routeErrors.join("; "),
  );
}
