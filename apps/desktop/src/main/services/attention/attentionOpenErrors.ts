// User-facing copy for a failed Activity click-through.
//
// Seeing an Activity item means the owning machine is already on your account,
// so clicking it is expected to "just work" — pair if needed, connect if
// disconnected, then open. When that chain genuinely fails the user needs to
// know WHICH part failed in their own terms; a raw RPC string ("method
// runtime.connect failed: ECONNREFUSED") reads as a broken app.

/** Which step of the pair → connect → open chain produced the failure. */
export type AttentionOpenStage = "pair" | "connect" | "open";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Translate a pairing/connection/open failure into one sentence the user can
 * act on. The original message is preserved as `cause` so the logs keep the
 * diagnostic detail the copy deliberately drops.
 */
export function describeAttentionOpenFailure(
  error: unknown,
  stage: AttentionOpenStage,
  machineName: string | null | undefined,
): Error {
  const raw = errorText(error);
  const machine = machineName?.trim() || "The owning ADE machine";
  const offline =
    /offline|unreachable|not reachable|econnrefused|ehostunreach|enetunreach|etimedout|timed out|no route to host|could not connect|connection (refused|closed|reset)/i
      .test(raw);
  // Deliberately narrow. A bare `session` matches the name of a routine remote
  // RPC ("timed out waiting for method sessions.list"), and a bare `401`
  // matches an ephemeral port ("ECONNREFUSED 127.0.0.1:52401") — both are
  // ordinary unreachable-machine failures, and both used to be reported as
  // "Sign in to ADE again", sending the user to fix an account that was fine.
  const signedOut =
    /\bnot signed in\b|\bsigned out\b|\bsign (?:in|back in)\b|unauthenticated|unauthori[sz]/i
      .test(raw)
    || /\b401\b/.test(raw)
    || /\b(?:session|token|credentials?) (?:has )?(?:expired|invalid|revoked)|\b(?:expired|invalid|revoked) (?:session|token|credentials?)\b/i
      .test(raw);

  const message = signedOut
    ? `Sign in to ADE again, then open this item from ${machine}.`
    : offline
      ? `${machine} is not reachable right now. Wake it or reconnect it to the network, then try again.`
      : stage === "pair"
        ? `ADE could not pair with ${machine}. Open ADE on that machine, then try again.`
        : stage === "connect"
          ? `ADE could not connect to ${machine}. Make sure ADE is running there, then try again.`
          : `ADE connected to ${machine} but could not open this project.`;

  const failure = new Error(message);
  if (raw) failure.cause = error;
  return failure;
}
