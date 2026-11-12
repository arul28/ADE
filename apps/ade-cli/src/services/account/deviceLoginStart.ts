/**
 * Starting a device sign-in against the account directory (`/device/code`),
 * kept trying for a while when the directory can't be reached yet: a computer
 * that just booted (a fresh ADE Cloud computer) can start its sign-in before
 * its network or DNS is up, and nobody is there to press Retry.
 *
 * Every failure a retry may fix (no connection, a timeout, an answer without
 * JSON) is retried with a growing wait until the window is used up; then the
 * error names what happened and how long ADE kept trying. Its two prefixes
 * ("ADE account device service timed out" / "could not be reached") are
 * stable: the desktop maps them (`accountBridge.ts`), and the cloud setup card
 * reads "ADE kept trying" as this retry having run (`cloudBoxSignInStart.ts`).
 */

/** The longest a device sign-in start keeps retrying an unreachable account directory (`retryUnreachableForMs`). */
const DEVICE_START_RETRY_MAX_MS = 60_000;
const DEVICE_START_RETRY_FIRST_DELAY_MS = 1_000;
const DEVICE_START_RETRY_MAX_DELAY_MS = 8_000;

export type DeviceLoginStartOptions = {
  ignoreEnvCredential?: boolean;
  /**
   * Keep trying for this long (capped at a minute) when the account directory
   * can't be reached, times out, or answers without JSON. A computer that just
   * booted can start its sign-in before its network or DNS is up. Without it,
   * one try.
   */
  retryUnreachableForMs?: number;
};

/** Why `/device/code` gave no usable answer: what a retry may fix. */
type DeviceBridgeStartFailure =
  | { kind: "network"; code: string | null }
  | { kind: "timeout" }
  | { kind: "not_json"; status: number };

/**
 * Why a `/device/code` request gave no usable answer: its fetch failed, or
 * (with the response's `status`) its body was not JSON. A timeout is either.
 */
function deviceBridgeFailure(error: unknown, status?: number): DeviceBridgeStartFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
  if (status !== undefined) return { kind: "not_json", status };
  // Node's fetch puts the socket's error code (ENOTFOUND, EAI_AGAIN,
  // ECONNREFUSED…) on `cause`. Only a bare code goes out, never a host or body.
  // A host with several addresses fails with an AggregateError of one per address.
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
  const record = cause && typeof cause === "object" ? cause as { code?: unknown; errors?: unknown } : null;
  const first = Array.isArray(record?.errors) ? record.errors[0] as { code?: unknown } | undefined : undefined;
  const code = record?.code ?? first?.code ?? null;
  return { kind: "network", code: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null };
}

/** An action's `retryUnreachableForMs`, as a whole number of milliseconds, or none (the start caps it). */
export function readDeviceStartRetryMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/**
 * Why the account directory gave no usable answer, in the words the person
 * (and the cloud setup card, which reads the last line of `ade login`) sees.
 * Only a network error code goes in, never a URL or a body.
 */
function deviceBridgeStartError(failure: DeviceBridgeStartFailure, triedForMs: number): Error {
  const tried = triedForMs >= 1_000 ? ` ADE kept trying for ${Math.round(triedForMs / 1_000)} s.` : "";
  if (failure.kind === "timeout") {
    return new Error(`ADE account device service timed out.${tried} Check this computer's network connection and the account directory, then retry.`);
  }
  const why = failure.kind === "not_json"
    ? ` (it answered HTTP ${failure.status} without JSON)`
    : failure.code ? ` (network error ${failure.code})` : " (network error)";
  return new Error(`ADE account device service could not be reached${why}.${tried} Check this computer's network connection and the account directory, then retry.`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One POST to `/device/code`: the answer, or why it gave none that a retry may fix. */
async function requestDeviceCode(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  body: string,
): Promise<{ response: Response; payload: Record<string, unknown> } | { failure: DeviceBridgeStartFailure }> {
  let response: Response;
  try {
    response = await request(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
    });
  } catch (error) {
    return { failure: deviceBridgeFailure(error) };
  }
  try {
    return { response, payload: asRecord(await response.json()) };
  } catch (error) {
    return { failure: deviceBridgeFailure(error, response.status) };
  }
}

/**
 * POSTs `body` to `/device/code` and resolves with the directory's answer (any
 * status: the caller reads a refusal), retrying an unreachable directory for
 * up to `retryUnreachableForMs` (capped at a minute). Throws the
 * "timed out" / "could not be reached" error once the window is used up.
 */
export async function requestDeviceCodeWithRetry(args: {
  request: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
  body: string;
  retryUnreachableForMs?: number;
  logger: { warn: (event: string, meta?: Record<string, unknown>) => void };
}): Promise<{ response: Response; payload: Record<string, unknown> }> {
  // A retry sends the same secret: each answer is its own device code, and
  // one the directory made for a lost answer just expires unused.
  const retryForMs = Math.min(DEVICE_START_RETRY_MAX_MS, Math.max(0, args.retryUnreachableForMs ?? 0));
  // Wall-clock time: the window is real waiting, whatever clock the session reads.
  const startedAtMs = Date.now();
  let retryDelayMs = DEVICE_START_RETRY_FIRST_DELAY_MS;
  let attempt = await requestDeviceCode(args.request, args.url, args.body);
  while ("failure" in attempt) {
    const elapsedMs = Date.now() - startedAtMs;
    // The last wait is cut to what is left, so the whole window is used.
    const waitMs = Math.min(retryDelayMs, retryForMs - elapsedMs);
    if (waitMs < 250) {
      args.logger.warn("account.device_login_start_unreachable", {
        kind: attempt.failure.kind,
        ...(attempt.failure.kind === "network" && attempt.failure.code ? { code: attempt.failure.code } : {}),
        ...(attempt.failure.kind === "not_json" ? { status: attempt.failure.status } : {}),
        elapsedMs,
      });
      throw deviceBridgeStartError(attempt.failure, elapsedMs);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    retryDelayMs = Math.min(DEVICE_START_RETRY_MAX_DELAY_MS, retryDelayMs * 2);
    attempt = await requestDeviceCode(args.request, args.url, args.body);
  }
  return attempt;
}
