import { randomUUID } from "node:crypto";
import {
  PairedRuntimeCompatibilityError,
  PairedRuntimeRelayAuthRequiredError,
  type PairedRuntimeRouteDiagnostic,
} from "../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import {
  buildPairedEndpointCandidates,
  classifyPairedRuntimeFailure,
  createRouteAttemptRecorder,
  MAX_ROUTE_ATTEMPTS,
  orderPairedCandidates,
  pairedRuntimeRouteHost,
  type PairedRuntimeEndpointCandidate,
} from "../../../desktop/src/main/services/remoteRuntime/pairedRuntimeRoutes";
import { DesktopPairedMachineStore } from "../../../desktop/src/main/services/remoteRuntime/syncPairedMachineStore";
import {
  openSyncRuntimeTransport,
  type SyncRuntimeTransport,
} from "../../../desktop/src/main/services/remoteRuntime/syncRuntimeTransport";
import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeTarget,
} from "../../../desktop/src/shared/types/remoteRuntime";
import type { DesktopPairedMachineCredentials } from "../../../desktop/src/shared/types/pairedRuntime";
import {
  withBoundedAttempt,
  type RemoteLaunchBudget,
} from "./remoteLaunchBudget";

export type RemoteRoutePreference = "auto" | "lan" | "tailnet" | "relay";

export type AccountRelayProof = {
  userId: string;
  token: string;
};

export type AccountRelayProofResolver = () => Promise<AccountRelayProof | null>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pairedRouteAccountProof(args: {
  kind: "lan" | "tailnet" | "relay";
  credentials: Pick<DesktopPairedMachineCredentials, "accountOwnerUserId">;
  getAccountRelayProof: AccountRelayProofResolver;
}): Promise<AccountRelayProof | null> {
  if (args.kind !== "relay") return null;
  let proof: AccountRelayProof | null;
  try {
    proof = await args.getAccountRelayProof();
  } catch (error) {
    throw new PairedRuntimeRelayAuthRequiredError(
      "Sign in to ADE to connect through Relay. Local network and Tailscale connections still work without an account.",
      error,
    );
  }
  if (!proof?.userId.trim() || !proof.token.trim()) {
    throw new PairedRuntimeRelayAuthRequiredError(
      "Sign in to ADE to connect through Relay. Local network and Tailscale connections still work without an account.",
    );
  }
  const expectedOwnerUserId = args.credentials.accountOwnerUserId?.trim() ?? "";
  if (expectedOwnerUserId && proof.userId.trim() !== expectedOwnerUserId) {
    throw new PairedRuntimeRelayAuthRequiredError(
      "Sign in with the same ADE account as this Mac to connect through Relay. Local network and Tailscale connections still work without an account.",
    );
  }
  return { userId: proof.userId.trim(), token: proof.token.trim() };
}

export async function assertRelayAccountUnchanged(
  initialProof: AccountRelayProof | null,
  getAccountRelayProof: AccountRelayProofResolver,
): Promise<void> {
  if (!initialProof) return;
  const currentProof = await getAccountRelayProof().catch(() => null);
  if (currentProof?.userId.trim() === initialProof.userId) return;
  throw new PairedRuntimeRelayAuthRequiredError(
    "Your ADE account changed before the Relay connection finished. Sign in with the same account as this Mac and try again.",
  );
}

export function pairedEndpointCandidatesForPreference(
  candidates: PairedRuntimeEndpointCandidate[],
  preference: RemoteRoutePreference,
): PairedRuntimeEndpointCandidate[] {
  if (preference === "auto") return candidates;
  return candidates.filter((candidate) => candidate.kind === preference);
}

export function pairedConnectionLabel(
  candidate: Pick<PairedRuntimeEndpointCandidate, "endpoint" | "kind">,
): string {
  const url = new URL(candidate.endpoint);
  const host = `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  if (candidate.kind === "lan") return `local network (${host})`;
  if (candidate.kind === "tailnet") return `Tailscale (${host})`;
  return `ADE Relay (${url.hostname})`;
}

function remoteRoutePreferenceLabel(
  preference: RemoteRoutePreference,
): string {
  if (preference === "auto") return "automatic";
  if (preference === "lan") return "local network";
  if (preference === "tailnet") return "Tailscale";
  return "ADE Relay";
}

type PairedConnectionFailureReason =
  | "credentials_missing"
  | "route_unavailable"
  | "all_paths_failed";

export class PairedRemoteConnectionUnavailableError extends Error {
  constructor(
    readonly reason: PairedConnectionFailureReason,
    readonly failures: readonly string[],
    message: string,
    readonly diagnostic?: {
      correlationId: string;
      attempts: RemoteRuntimeConnectionAttempt[];
      omittedAttemptCount?: number;
    },
  ) {
    super(message);
    this.name = "PairedRemoteConnectionUnavailableError";
  }
}

export function relayAuthErrorWithDiagnostic(
  error: PairedRuntimeRelayAuthRequiredError,
  diagnostic: PairedRuntimeRouteDiagnostic,
): PairedRuntimeRelayAuthRequiredError {
  return new PairedRuntimeRelayAuthRequiredError(
    error.message,
    error.cause,
    diagnostic,
  );
}

export type OpenedPairedCandidate<T> = {
  value: T;
  candidate: PairedRuntimeEndpointCandidate;
  connectedAt: number;
  correlationId: string;
  attempts: RemoteRuntimeConnectionAttempt[];
  omittedAttemptCount: number;
};

export async function openPairedCandidate<T>(args: {
  target: RemoteRuntimeTarget;
  budget: RemoteLaunchBudget;
  appVersion: string;
  getAccountRelayProof: AccountRelayProofResolver;
  routePreference: RemoteRoutePreference;
  acceptTransport: (transport: SyncRuntimeTransport) => Promise<T>;
}): Promise<OpenedPairedCandidate<T>> {
  const pairedStore = new DesktopPairedMachineStore();
  const credentials = args.target.pairedMachine
    ? pairedStore.getForReference(args.target.pairedMachine)
    : null;
  if (!credentials) {
    throw new PairedRemoteConnectionUnavailableError(
      "credentials_missing",
      [],
      "Paired credentials for this account machine were not found.",
    );
  }
  const candidates = pairedEndpointCandidatesForPreference(
    buildPairedEndpointCandidates({
      endpoints: credentials.endpoints,
      relayUrl: credentials.relayUrl,
      endpointStates: credentials.endpointStates,
    }),
    args.routePreference,
  );
  if (!candidates.length) {
    throw new PairedRemoteConnectionUnavailableError(
      "route_unavailable",
      [],
      `No ${remoteRoutePreferenceLabel(args.routePreference)} path is saved for ${args.target.name}.`,
    );
  }

  const correlationId = randomUUID();
  const failures: string[] = [];
  const attemptRecorder = createRouteAttemptRecorder();
  const { attempts, record: recordAttempt } = attemptRecorder;
  let relayAuthError: PairedRuntimeRelayAuthRequiredError | null = null;
  const orderedCandidates = orderPairedCandidates(candidates);
  for (const candidate of orderedCandidates) {
    const attemptStartedAt = Date.now();
    const safeHost = pairedRuntimeRouteHost(candidate.endpoint);
    let transport: SyncRuntimeTransport | null = null;
    try {
      const relayProof = await pairedRouteAccountProof({
        kind: candidate.kind,
        credentials,
        getAccountRelayProof: args.getAccountRelayProof,
      });
      transport = await withBoundedAttempt(args.budget, 10_000, async (attempt) =>
        await openSyncRuntimeTransport({
          credentials,
          endpoint: candidate.endpoint,
          appVersion: args.appVersion,
          connectTimeoutMs: attempt.timeoutMs,
          authTimeoutMs: attempt.timeoutMs,
          signal: attempt.signal,
          relayAccountToken: relayProof?.token ?? null,
          ...(candidate.kind === "relay" ? { correlationId } : {}),
        })
      );
      await assertRelayAccountUnchanged(
        relayProof,
        args.getAccountRelayProof,
      );
      const value = await args.acceptTransport(transport);
      const connectedAt = Date.now();
      try {
        pairedStore.markEndpointSucceeded(
          credentials.hostIdentity.deviceId,
          candidate.endpoint,
          connectedAt,
        );
      } catch (error) {
        process.stderr.write(
          `Warning: could not save paired endpoint metadata: ${errorMessage(error)}\n`,
        );
      }
      recordAttempt({
        kind: candidate.kind,
        host: safeHost,
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, connectedAt - attemptStartedAt),
        outcome: "connected",
      });
      return {
        value,
        candidate,
        connectedAt,
        correlationId,
        attempts,
        omittedAttemptCount: attemptRecorder.omittedAttemptCount,
      };
    } catch (error) {
      try { transport?.close(); } catch {}
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
      if (error instanceof PairedRuntimeCompatibilityError) throw error;
      const failure = classifyPairedRuntimeFailure(error);
      recordAttempt({
        kind: candidate.kind,
        host: safeHost,
        startedAt: attemptStartedAt,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        outcome: "failed",
        failure,
      });
      if (failures.length < MAX_ROUTE_ATTEMPTS) {
        failures.push(`${pairedConnectionLabel(candidate)}: ${failure}`);
      }
    }
  }
  if (relayAuthError) {
    throw relayAuthErrorWithDiagnostic(relayAuthError, {
      correlationId,
      attempts,
      ...(attemptRecorder.omittedAttemptCount > 0
        ? { omittedAttemptCount: attemptRecorder.omittedAttemptCount }
        : {}),
    });
  }
  throw new PairedRemoteConnectionUnavailableError(
    "all_paths_failed",
    failures,
    `Could not open a paired ADE runtime connection to ${args.target.name}. ${failures
      .slice(0, 4)
      .join(" | ")}`,
    {
      correlationId,
      attempts,
      ...(attemptRecorder.omittedAttemptCount > 0
        ? { omittedAttemptCount: attemptRecorder.omittedAttemptCount }
        : {}),
    },
  );
}
