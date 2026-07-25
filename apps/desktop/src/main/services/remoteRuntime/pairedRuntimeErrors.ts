import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeSshHostKeyTrustStatus,
} from "../../../shared/types/remoteRuntime";

export type PairedRuntimeRouteDiagnostic = {
  correlationId: string;
  attempts: RemoteRuntimeConnectionAttempt[];
  omittedAttemptCount?: number;
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

  constructor(message = "Sign in to ADE to connect through ADE Relay.", cause?: unknown) {
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
