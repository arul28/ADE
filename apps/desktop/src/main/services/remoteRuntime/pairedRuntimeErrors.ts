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

/**
 * The host closed this RPC channel because one reply would pass its send
 * budget. The host is alive: it answered, and the next call opens a new
 * channel. A caller must not report the machine as unreachable for it.
 */
export class PairedRuntimeRpcOverBudgetError extends Error {
  readonly code = "PAIRED_RUNTIME_RPC_OVER_BUDGET" as const;

  constructor(message: string) {
    super(message);
    this.name = "PairedRuntimeRpcOverBudgetError";
  }
}

/** True when `error`, or an error up to five `cause` links below it, is a `Ctor`. */
function hasCauseOfType(error: unknown, Ctor: new (...args: never[]) => Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof Ctor) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** True for `PairedRuntimeRpcOverBudgetError`, also when a wrapper carries it as `cause`. */
export function isPairedRuntimeRpcOverBudgetError(error: unknown): boolean {
  return hasCauseOfType(error, PairedRuntimeRpcOverBudgetError);
}

/**
 * The host closed this connection because another connection from the same
 * device replaced it. Something else on this computer that shares this
 * machine's pairing (a second ADE on the same home, for example) is connected
 * now. Reconnecting on our own would only close that one in turn, and the two
 * would take the machine from each other forever.
 */
export class PairedRuntimeSupersededError extends Error {
  readonly code = "PAIRED_RUNTIME_SUPERSEDED" as const;

  constructor(message = "Another ADE on this computer is using this connection.") {
    super(message);
    this.name = "PairedRuntimeSupersededError";
  }
}

/** True for `PairedRuntimeSupersededError`, also when a wrapper carries it as `cause`. */
export function isPairedRuntimeSupersededError(error: unknown): boolean {
  return hasCauseOfType(error, PairedRuntimeSupersededError);
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
