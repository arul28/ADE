import { logActivityRelayFailure } from "./logging";
import { trustedHttpsOrigin } from "./trustedOrigin";

/**
 * The slice of the Worker env this hand-off needs. Declared here rather than
 * imported from `directory.ts` so the relay call has no dependency on the
 * routing module that uses it.
 */
export type ActivityRelayEnv = {
  /**
   * Push relay origin. The relay is a different worker over a different D1, so
   * machine membership changes have to be forwarded to it explicitly: it owns
   * the Activity feed and the roster of machines allowed to publish into it.
   */
  PUSH_RELAY_URL?: string;
  /** Optional service binding used in place of a public fetch to the relay. */
  ACTIVITY_RELAY?: { fetch: typeof fetch };
  /**
   * REQUIRED. Shared secret proving to the relay that a machine membership
   * change came from this worker and not from a machine holding an account
   * token.
   */
  DIRECTORY_AUTH_SECRET?: string;
};

/** Options a caller (or a test) can inject around the relay hand-off. */
export type ActivityRelayOptions = {
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
};

export type ActivityRelayOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * The relay is addressed by origin and the paths below are appended to it, so
 * a configured value that carries one is trusted for its origin rather than
 * refused — the one way this differs from the CORS allow-list.
 */
function trustedActivityRelayBaseUrl(env: ActivityRelayEnv): string | null {
  return trustedHttpsOrigin(env.PUSH_RELAY_URL);
}

/**
 * Forward a machine membership change to the push relay.
 *
 * Two credentials travel together, and they answer different questions:
 *
 * - The caller's already-verified bearer token says WHICH ACCOUNT this is for.
 *   The relay re-verifies it and derives its own account id from it, so this
 *   worker can never act on an account it was not called for.
 * - `x-ade-directory-auth` says THIS CAME FROM THE DIRECTORY. A removed machine
 *   keeps a valid account token by design (that is the whole premise of the
 *   revocation tables), so the token alone cannot authorize un-revoking a
 *   machine — otherwise the removed machine clears its own revocation and
 *   resumes publishing. Only the directory knows this secret.
 *
 * The secret is required for both operations rather than only the re-pair, so a
 * half-configured deployment fails loudly on the first machine removal instead
 * of silently leaving the security-critical route unauthenticated. It is sent
 * over whichever transport is configured — the `ACTIVITY_RELAY` service binding
 * or a public HTTPS fetch — because a service binding carries no attestable
 * provenance marker the relay could check on its own.
 *
 * A failure here is never swallowed: it is logged, retried once, and returned
 * so the caller can report it.
 */
export async function callActivityRelay(
  request: Request,
  env: ActivityRelayEnv,
  args: {
    operation: "purge" | "restore";
    machineKey: string;
    correlationId: string;
    options: ActivityRelayOptions;
  },
): Promise<ActivityRelayOutcome> {
  const baseUrl = trustedActivityRelayBaseUrl(env);
  if (!baseUrl) return { ok: false, reason: "activity relay is not configured" };
  const directoryAuth = env.DIRECTORY_AUTH_SECRET?.trim();
  if (!directoryAuth) {
    return { ok: false, reason: "directory relay authentication is not configured" };
  }
  const authorization = request.headers.get("authorization");
  if (!authorization) return { ok: false, reason: "missing caller authorization" };
  const path = `/attention/account/machines/${encodeURIComponent(args.machineKey)}`;
  const url = args.operation === "purge" ? `${baseUrl}${path}` : `${baseUrl}${path}/pairing`;
  const fetchImpl = args.options.fetchImpl
    ?? (env.ACTIVITY_RELAY ? env.ACTIVITY_RELAY.fetch.bind(env.ACTIVITY_RELAY) : fetch);
  const retryDelayMs = Math.max(0, args.options.retryDelayMs ?? 250);
  let reason = "activity relay is unreachable";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      const response = await fetchImpl(url, {
        method: args.operation === "purge" ? "DELETE" : "POST",
        headers: {
          accept: "application/json",
          authorization,
          "x-ade-directory-auth": directoryAuth,
          "x-ade-correlation-id": args.correlationId,
        },
        redirect: "error",
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true };
      reason = `activity relay returned ${response.status}`;
      // A rejected token or a refused request will not heal on a retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  logActivityRelayFailure({
    correlationId: args.correlationId,
    operation: args.operation,
    machineKey: args.machineKey,
    reason,
    attempts: 2,
  });
  return { ok: false, reason };
}
