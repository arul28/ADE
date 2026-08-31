/** Every error this package throws carries a stable machine-readable code. */
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
  | "disposed";

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
