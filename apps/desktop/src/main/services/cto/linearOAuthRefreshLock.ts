import { withCredentialRenewalLock } from "../account/credentialRenewalLock";

const LOCK_FILE = "linear-oauth-refresh.lock";
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 10_000;

export class LinearOAuthRefreshLockTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for Linear OAuth refresh lock.");
    this.name = "LinearOAuthRefreshLockTimeoutError";
  }
}

/**
 * Serialize Linear OAuth refresh across ADE runtimes (desktop + ade serve) that
 * share the same encrypted credential store. Linear rotates refresh tokens on
 * each exchange, so concurrent refreshes can cause the loser to get
 * invalid_grant and wipe a still-valid connection.
 */
export async function withLinearOAuthRefreshLock<T>(
  secretsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withCredentialRenewalLock(secretsDir, LOCK_FILE, fn, {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    timeoutError: () => new LinearOAuthRefreshLockTimeoutError(),
  });
}
