import { randomUUID } from "node:crypto";
import { hostStallFromHello } from "../../../shared/connectionDiagnosis";
import type {
  DesktopPairedMachineCredentials,
} from "../../../shared/types/pairedRuntime";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import { DESKTOP_CLIENT_NAMES } from "../../../shared/runtimeClientNames";
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
import {
  buildPairedEndpointCandidates,
  classifyPairedRuntimeFailure,
  createRouteAttemptRecorder,
  dominantPairedRuntimeFailure,
  orderPairedCandidates,
  pairedRuntimeFailureMessage,
  pairedRuntimeRouteHost,
  type PairedRuntimeAccountHelloCode,
  type PairedRuntimeEndpointCandidate,
} from "./pairedRuntimeRoutes";
import {
  PairedRuntimeCompatibilityError,
  PairedRuntimeHelloRejectedError,
  PairedRuntimeRelayAuthRequiredError,
  PairedRuntimeTransportUnavailableError,
} from "./pairedRuntimeErrors";

export type PairedRuntimeBootstrapResult = {
  client: RuntimeRpcClient;
  transport: SyncRuntimeTransport;
  portForwardClient: SyncPortForwardClient;
  /** Ephemeral owner whose proof authorized the active Relay route. */
  relayAccountOwnerUserId: string | null;
  result: RemoteRuntimeConnectResult;
};

type PairedRuntimeBootstrapOptions = {
  openTransport?: typeof openSyncRuntimeTransport;
  getAccountRelayProof?: () => Promise<{
    userId: string;
    token: string;
  } | null>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Failures where the address gave no answer at all. Demotion is for these only. */
const ROUTE_SILENT_FAILURES = new Set<RemoteRuntimeConnectionAttemptFailure>([
  "timeout",
  "unreachable",
  "unknown",
]);

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

/**
 * How long a local-network route gets to open while another route is still
 * waiting behind it. A socket on the same network opens in milliseconds; the
 * default 10 s is for a route that is the last hope. A paired box in a data
 * centre advertises private addresses nobody else can reach, and each of
 * them used to hold the relay back by the full 10 s.
 */
const LAN_CONNECT_TIMEOUT_WITH_FALLBACK_MS = 3_000;
/**
 * The same for a tailnet route. Tailscale answers in well under a second once
 * its path is up, and a few seconds when it first has to go through a DERP
 * relay; while the far brain restarts, `tailscale serve` still accepts the
 * socket and the handshake hangs, which used to hold every later route back
 * by the full 10 s.
 */
const TAILNET_CONNECT_TIMEOUT_WITH_FALLBACK_MS = 5_000;

export async function bootstrapPairedRuntime(args: {
  target: RemoteRuntimeTarget;
  registry: RemoteTargetRegistry;
  pairedStore: DesktopPairedMachineStore;
  appVersion: string;
  options?: PairedRuntimeBootstrapOptions;
}): Promise<PairedRuntimeBootstrapResult> {
  const credentials = args.target.pairedMachine
    ? args.pairedStore.getForReference(args.target.pairedMachine)
    : null;
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
  const correlationId = randomUUID();
  const attemptRecorder = createRouteAttemptRecorder();
  const { attempts, record: recordAttempt } = attemptRecorder;
  let relayAuthError: PairedRuntimeRelayAuthRequiredError | null = null;
  let accountHelloCode: PairedRuntimeAccountHelloCode | null = null;
  // Keep the phases explicit even if a future candidate-builder change
  // accidentally reorders endpoints.
  const orderedCandidates = orderPairedCandidates(candidates);
  const markEndpointFailed = (
    candidate: PairedRuntimeEndpointCandidate,
    failure: RemoteRuntimeConnectionAttemptFailure,
  ): void => {
    if (failure === "identity") {
      // A different machine answered here. Demotion clears on any answer, and a
      // neighbour can answer too, so the address is forgotten, not demoted.
      args.pairedStore.forgetEndpoint(
        credentials.hostIdentity.deviceId,
        candidate.endpoint,
      );
      return;
    }
    // Only a route that never answered is evidence against the address. Every
    // other failure came from a host that did answer (a rejected pairing or
    // account, a superseded or too-old peer), and demoting that route teaches
    // the dial order nothing about whether the address is alive.
    if (!ROUTE_SILENT_FAILURES.has(failure)) return;
    args.pairedStore.markEndpointFailed(
      credentials.hostIdentity.deviceId,
      candidate.endpoint,
    );
  };
  for (const [candidateIndex, candidate] of orderedCandidates.entries()) {
    const attemptStartedAt = Date.now();
    const hasFallback = candidateIndex < orderedCandidates.length - 1;
    const safeHost = pairedRuntimeRouteHost(candidate.endpoint);
    let relayAccountToken: string | null = null;
    let relayAccountOwnerUserId: string | null = null;
    if (candidate.kind === "relay") {
      let proof: { userId: string; token: string } | null = null;
      try {
        proof = await args.options?.getAccountRelayProof?.() ?? null;
      } catch (error) {
        relayAuthError = new PairedRuntimeRelayAuthRequiredError(
          "Sign in to ADE to connect through ADE Relay.",
          error,
        );
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "skipped",
          failure: "authentication",
        });
        continue;
      }
      if (
        !proof?.userId.trim()
        || !proof.token.trim()
      ) {
        relayAuthError = new PairedRuntimeRelayAuthRequiredError(
          "Sign in to ADE to connect through ADE Relay.",
        );
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "skipped",
          failure: "authentication",
        });
        continue;
      }
      const expectedOwnerUserId = credentials.accountOwnerUserId?.trim() ?? "";
      if (expectedOwnerUserId && proof.userId.trim() !== expectedOwnerUserId) {
        relayAuthError = new PairedRuntimeRelayAuthRequiredError(
          "Sign in with the same ADE account as this machine to connect through ADE Relay.",
        );
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "skipped",
          failure: "authentication",
        });
        continue;
      }
      relayAccountToken = proof.token.trim();
      relayAccountOwnerUserId = proof.userId.trim();
    }
    let transport: SyncRuntimeTransport;
    try {
      transport = await openTransport({
        credentials,
        endpoint: candidate.endpoint,
        appVersion: args.appVersion,
        relayAccountToken,
        ...(candidate.kind === "relay" ? { correlationId } : {}),
        ...(candidate.kind === "lan" && hasFallback
          ? { connectTimeoutMs: LAN_CONNECT_TIMEOUT_WITH_FALLBACK_MS }
          : candidate.kind === "tailnet" && hasFallback
            ? { connectTimeoutMs: TAILNET_CONNECT_TIMEOUT_WITH_FALLBACK_MS }
            : {}),
      });
    } catch (error) {
      if (error instanceof PairedRuntimeRelayAuthRequiredError) {
        relayAuthError = error;
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "failed",
          failure: "authentication",
        });
        continue;
      }
      if (
        error instanceof PairedRuntimeHelloRejectedError
        && (
          error.helloCode === "account_not_signed_in"
          || error.helloCode === "account_verification_failed"
        )
        && accountHelloCode == null
      ) {
        accountHelloCode = error.helloCode;
      }
      const failure = classifyPairedRuntimeFailure(error);
      markEndpointFailed(candidate, failure);
      recordAttempt({
        kind: candidate.kind,
        host: safeHost,
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        outcome: "failed",
        failure,
      });
      continue;
    }

    if (transport.connection.hello.features?.portForward !== true) {
      transport.close();
      recordAttempt({
        kind: candidate.kind,
        host: safeHost,
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        outcome: "failed",
        failure: "capability",
      });
      continue;
    }

    const client = new RuntimeRpcClient(transport);
    let initializeResult: unknown;
    const latencyStartedAt = Date.now();
    // Pipelined: `projects.list` goes out right behind `initialize` instead of
    // one round trip later. The runtime marks the session initialized before
    // its first await, so the second request finds it ready. Its answer is
    // used only once `initialize` proves the runtime compatible; any failure
    // other than a dead transport falls back to asking again afterwards.
    const initializing = client.initialize(
      DESKTOP_CLIENT_NAMES.remote,
      args.appVersion,
    );
    const pipelinedProjects = client.call("projects.list", {});
    pipelinedProjects.catch(() => {});
    try {
      initializeResult = await initializing;
    } catch (error) {
      client.close();
      if (isPairedTransportFailure(error)) {
        const failure = classifyPairedRuntimeFailure(error);
        markEndpointFailed(candidate, failure);
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "failed",
          failure,
        });
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
      projects = coerceProjects(await pipelinedProjects.catch(async (error) => {
        if (isPairedTransportFailure(error)) throw error;
        return await client.call("projects.list", {});
      }));
    } catch (error) {
      client.close();
      if (isPairedTransportFailure(error)) {
        const failure = classifyPairedRuntimeFailure(error);
        markEndpointFailed(candidate, failure);
        recordAttempt({
          kind: candidate.kind,
          host: safeHost,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
          outcome: "failed",
          failure,
        });
        continue;
      }
      throw compatibilityError(error);
    }

    try {
      const connectedAt = Date.now();
      recordAttempt({
        kind: candidate.kind,
        host: safeHost,
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, connectedAt - attemptStartedAt),
        outcome: "connected",
      });
      const updated = args.registry.update(args.target.id, {
        lastSeenArch: pairedArch(args.target, credentials),
        runtimeBinaryVersion: initializeInfo.version,
        lastConnectedAt: connectedAt,
      });
      const routeUpdatedCredentials = args.pairedStore.markEndpointSucceeded(
        credentials.hostIdentity.deviceId,
        candidate.endpoint,
        connectedAt,
      );
      if (Object.prototype.hasOwnProperty.call(
        transport.connection.hello,
        "cloudRelayWssUrl",
      )) {
        const learnedRelay = transport.connection.hello.cloudRelayWssUrl ?? null;
        const endpointsWithoutPreviousRelay = routeUpdatedCredentials.endpoints.filter(
          (endpoint) => endpoint !== credentials.relayUrl,
        );
        args.pairedStore.save(
          {
            ...routeUpdatedCredentials,
            relayUrl: learnedRelay,
            endpoints: learnedRelay
              ? [learnedRelay, ...endpointsWithoutPreviousRelay]
              : endpointsWithoutPreviousRelay,
          },
          { replaceConnectionMetadata: true },
        );
      }
      const portForwardClient = createSyncPortForwardClient(transport.connection, {
        machineLabel: updated.name?.trim() || updated.hostname?.trim() || null,
      });
      return {
        client,
        transport,
        portForwardClient,
        relayAccountOwnerUserId,
        result: {
          target: updated,
          arch: updated.lastSeenArch ?? "unknown",
          version: initializeInfo.version,
          appVersion: initializeInfo.desktopAppVersion,
          route: {
            kind: candidate.kind,
            endpoint: candidate.endpoint,
            latencyMs,
            correlationId,
            attempts,
            ...(attemptRecorder.omittedAttemptCount > 0
              ? { omittedAttemptCount: attemptRecorder.omittedAttemptCount }
              : {}),
          },
          capabilities: initializeInfo.capabilities,
          compatibilityWarnings: initializeInfo.compatibilityWarnings,
          projects,
          hostStall: hostStallFromHello(transport.connection.hello, Date.now()),
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  // Every route is spent. Diagnose once from the recorded attempts and say it
  // in one sentence — the per-route hosts, ports and outcomes stay in
  // `attempts` for the UI's route details and the diagnostic ID.
  const failure = dominantPairedRuntimeFailure(attempts);
  const diagnostic = {
    correlationId,
    attempts,
    failure,
    ...(attemptRecorder.omittedAttemptCount > 0
      ? { omittedAttemptCount: attemptRecorder.omittedAttemptCount }
      : {}),
  };
  // A skipped relay leg only wins when nothing more actionable was found; a
  // host that rejected the pairing outranks "you aren't signed in".
  if (relayAuthError && failure === "authentication" && accountHelloCode == null) {
    throw new PairedRuntimeRelayAuthRequiredError(
      relayAuthError.message,
      relayAuthError.cause,
      diagnostic,
    );
  }
  throw new PairedRuntimeTransportUnavailableError(
    pairedRuntimeFailureMessage(failure, credentials.hostIdentity.name, accountHelloCode),
    undefined,
    diagnostic,
  );
}
