import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeSshHostKeyTrustStatus,
} from "../../../shared/types/remoteRuntime";
import type { SyncHelloErrorPayload } from "../../../shared/types/sync";

export type PairedRuntimeRouteDiagnostic = {
  correlationId: string;
  attempts: RemoteRuntimeConnectionAttempt[];
  omittedAttemptCount?: number;
  /** Dominant cause across the attempts — what the headline was written from. */
  failure?: RemoteRuntimeConnectionAttemptFailure;
};

function assignCause(target: Error, cause: unknown): void {
  if (cause === undefined) return;
  Object.defineProperty(target, "cause", {
    configurable: true,
    enumerable: false,
    value: cause,
  });
}

export class PairedRuntimeTransportUnavailableError extends Error {
  readonly code = "PAIRED_RUNTIME_TRANSPORT_UNAVAILABLE" as const;

  constructor(
    message: string,
    cause?: unknown,
    readonly diagnostic?: PairedRuntimeRouteDiagnostic,
  ) {
    super(message);
    this.name = "PairedRuntimeTransportUnavailableError";
    assignCause(this, cause);
  }
}

/**
 * A `hello_error` the paired host sent back. The host already told us *why* in
 * a structured `code`; the message is prose meant for a human and must never be
 * pattern-matched to recover the reason. Carrying the code (and the rejecting
 * host's identity) keeps classification structural.
 */
export class PairedRuntimeHelloRejectedError extends Error {
  readonly code = "PAIRED_RUNTIME_HELLO_REJECTED" as const;

  constructor(
    message: string,
    readonly helloCode: SyncHelloErrorPayload["code"] | null,
    readonly rejectingHost?: { deviceId: string; name?: string } | null,
  ) {
    super(message);
    this.name = "PairedRuntimeHelloRejectedError";
  }
}

export class PairedRuntimeCompatibilityError extends Error {
  readonly code = "PAIRED_RUNTIME_COMPATIBILITY" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PairedRuntimeCompatibilityError";
    assignCause(this, cause);
  }
}

export class PairedRuntimeRelayAuthRequiredError extends Error {
  readonly code = "PAIRED_RUNTIME_RELAY_AUTH_REQUIRED" as const;

  constructor(
    message = "Sign in to ADE to connect through ADE Relay.",
    cause?: unknown,
    readonly diagnostic?: PairedRuntimeRouteDiagnostic,
  ) {
    super(message);
    this.name = "PairedRuntimeRelayAuthRequiredError";
    assignCause(this, cause);
  }
}

export class PairedRuntimeSshTrustRequiredError extends Error {
  readonly code = "PAIRED_RUNTIME_SSH_TRUST_REQUIRED" as const;

  constructor(
    readonly trustStatus: Extract<
      RemoteRuntimeSshHostKeyTrustStatus,
      { state: "needs_trust" | "changed" }
    >,
  ) {
    super(
      trustStatus.state === "changed"
        ? "The SSH host key changed after the paired connection failed."
        : "The SSH host key must be trusted before ADE can fall back from the paired connection.",
    );
    this.name = "PairedRuntimeSshTrustRequiredError";
  }
}
