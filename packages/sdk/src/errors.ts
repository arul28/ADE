/**
 * Every code this package throws, as a value.
 *
 * Exported so a rehydration path — an error that crossed a process boundary as
 * a plain string — can validate rather than cast. See
 * `electron/renderer.ts`.
 */
export const ADE_ERROR_CODES = [
  "binary_not_found",
  "download_failed",
  "checksum_mismatch",
  "spawn_failed",
  "connect_failed",
  "handshake_failed",
  "rpc_error",
  "rpc_timeout",
  "transport_closed",
  "protocol_error",
  "thread_not_found",
  "invalid_option",
  "runtime_unavailable",
  "approval_not_found",
  "unauthorized",
  "disposed",
] as const;

/**
 * Every error this package throws carries a stable machine-readable code.
 *
 * Kept as its own union rather than derived from {@link ADE_ERROR_CODES} so
 * each member can carry its own doc comment; a test asserts the two agree.
 */
export type AdeErrorCode =
  | "binary_not_found"
  | "download_failed"
  | "checksum_mismatch"
  | "spawn_failed"
  | "connect_failed"
  | "handshake_failed"
  | "rpc_error"
  | "rpc_timeout"
  | "transport_closed"
  | "protocol_error"
  | "thread_not_found"
  | "invalid_option"
  /**
   * No runtime could be resolved and `allowDownload: false` forbade fetching
   * one. A packaging mistake must fail here, loudly, rather than work on the
   * developer's machine through a silent download and fail on a locked-down
   * user's.
   */
  | "runtime_unavailable"
  /**
   * `approve()` named an item that is not pending. A stop, a teardown, or an
   * earlier call already settled it; the engine settles unknown items silently,
   * so the SDK checks first and says so rather than letting a no-op look like
   * a success.
   */
  | "approval_not_found"
  /**
   * A bridge refused the call before it reached the SDK — the host's
   * `authorize` hook said no. Used by `@ade-dev/sdk/electron`.
   */
  | "unauthorized"
  | "disposed";

/**
 * The list and the union must stay identical. Both directions are checked, so
 * a code added to one and not the other is a compile error here rather than a
 * silently unvalidatable string at the Electron boundary.
 */
type _CodesMatch =
  (typeof ADE_ERROR_CODES)[number] extends AdeErrorCode
    ? AdeErrorCode extends (typeof ADE_ERROR_CODES)[number]
      ? true
      : never
    : never;
const _codesMatch: _CodesMatch = true;
void _codesMatch;

const CODE_SET: ReadonlySet<string> = new Set<string>(ADE_ERROR_CODES);

/** A code read back off the wire, or null when it is not one this SDK declares. */
export function readAdeErrorCode(value: unknown): AdeErrorCode | null {
  return typeof value === "string" && CODE_SET.has(value) ? (value as AdeErrorCode) : null;
}

export class AdeError extends Error {
  readonly code: AdeErrorCode;
  override readonly cause?: unknown;

  constructor(code: AdeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AdeError";
    this.code = code;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
