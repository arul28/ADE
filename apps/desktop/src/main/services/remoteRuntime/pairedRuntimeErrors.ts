import type {
  RemoteRuntimeConnectionAttempt,
  RemoteRuntimeConnectionAttemptFailure,
  RemoteRuntimeSshHostKeyTrustStatus,
} from "../../../shared/types/remoteRuntime";
import type { SyncHelloErrorPayload } from "../../../shared/types/sync";
import { describeLinkHeldByOtherAdeApp } from "../../../shared/connectionDiagnosis";
import { expectedErrorKind, markExpected } from "../../../shared/expectedError";

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

  constructor(message = describeLinkHeldByOtherAdeApp(null)) {
    super(message);
    this.name = "PairedRuntimeSupersededError";
  }
}

/** True for `PairedRuntimeSupersededError`, also when a wrapper carries it as `cause`. */
export function isPairedRuntimeSupersededError(error: unknown): boolean {
  return hasCauseOfType(error, PairedRuntimeSupersededError);
}

/** The ADE account sign-in a relay route carries, from the account service. */
export type AccountRelayProof = { userId: string; token: string };

/**
 * The account proof for one relay hello to the machine `credentials` names:
 * the signed-in account, which must be the account that paired it, if any.
 * Throws `PairedRuntimeRelayAuthRequiredError` (with what failed as its cause)
 * when there is none to send, so a caller never dials the relay unsigned.
 */
export async function resolveAccountRelayProof(
  credentials: { accountOwnerUserId?: string | null },
  getAccountRelayProof: (() => Promise<AccountRelayProof | null>) | undefined,
): Promise<AccountRelayProof> {
  let proof: AccountRelayProof | null;
  try {
    proof = await getAccountRelayProof?.() ?? null;
  } catch (error) {
    throw new PairedRuntimeRelayAuthRequiredError("Sign in to ADE to connect through ADE Relay.", error);
  }
  if (!proof?.userId.trim() || !proof.token.trim()) {
    throw new PairedRuntimeRelayAuthRequiredError("Sign in to ADE to connect through ADE Relay.");
  }
  const expectedOwnerUserId = credentials.accountOwnerUserId?.trim() ?? "";
  if (expectedOwnerUserId && proof.userId.trim() !== expectedOwnerUserId) {
    throw new PairedRuntimeRelayAuthRequiredError(
      "Sign in with the same ADE account as this machine to connect through ADE Relay.",
    );
  }
  return { userId: proof.userId.trim(), token: proof.token.trim() };
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
    // Signed out, or signed in as another account: the user signs in, and
    // nothing in ADE is broken. A cause that already says why (the account
    // service unreachable) keeps its own kind.
    markExpected(this, expectedErrorKind(cause) ?? "user");
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

export const REMOTE_CONNECT_STOPPED_NOTICE =
  "ADE won't retry on its own. Fix this, then press Try again.";

/**
 * ADE refused to dial because a recent connect failed; nothing was sent. The
 * "failed recently" text is what Sentry's expected-outcome filter matches.
 */
export class RemoteConnectBackoffError extends Error {
  readonly code = "REMOTE_CONNECT_BACKOFF";

  constructor(failureMessage: string, retryAtMs: number | null) {
    const tail = retryAtMs == null
      ? REMOTE_CONNECT_STOPPED_NOTICE
      : `Retrying in ${Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))}s.`;
    super(`Remote ADE service connection failed recently (${failureMessage}). ${tail}`);
    this.name = "RemoteConnectBackoffError";
  }
}

/**
 * The connection dropped while a call that may not run twice was in flight, so
 * ADE cannot say whether the machine ran it. `reconnected` says whether the
 * machine answered again right after: then it is reachable, and only this one
 * call's outcome is unknown. Null when another call dropped the connection and
 * owns reconnecting it: this call cannot say how that went.
 */
export class RemoteActionOutcomeUnknownError extends Error {
  readonly code = "REMOTE_ACTION_OUTCOME_UNKNOWN";

  constructor(readonly reconnected: boolean | null) {
    super(
      "Remote ADE service connection was interrupted before ADE could confirm the action result. " +
        (reconnected === null
          ? "Check whether it finished on that machine before retrying it."
          : reconnected
          ? "ADE reconnected to the machine; retry the action if it is still needed."
          : "ADE could not reconnect to the machine; check the destination before retrying the action."),
    );
    this.name = "RemoteActionOutcomeUnknownError";
  }
}
