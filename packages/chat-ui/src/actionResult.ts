/**
 * Usage-limit and account-switch actions answer `{ ok: false, reason, message }`
 * rather than throwing when the runtime refuses them (a busy turn, a
 * signed-out account). Turn that answer into an error so a control shows the
 * refusal instead of reporting success.
 */
export async function requireAccepted(result: unknown): Promise<void> {
  const value = await result;
  if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
    const message = (value as { message?: unknown }).message;
    throw new Error(typeof message === "string" && message ? message : "The runtime refused this action.");
  }
}
