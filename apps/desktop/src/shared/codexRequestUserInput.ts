/**
 * Codex app-server `item/tool/requestUserInput` `isBlocking`.
 *
 * Wire default (rust-v0.153.4 `request_user_input.rs`):
 * `is_blocking: wire.is_blocking.unwrap_or(true)`.
 * Only an explicit JSON `false` is non-blocking steering.
 */
export function parseCodexIsBlocking(value: unknown): boolean {
  if (value === false) return false;
  return true;
}

export function readCodexIsBlocking(params: Record<string, unknown> | null | undefined): boolean {
  if (!params) return true;
  if (Object.prototype.hasOwnProperty.call(params, "isBlocking")) {
    return parseCodexIsBlocking(params.isBlocking);
  }
  if (Object.prototype.hasOwnProperty.call(params, "is_blocking")) {
    return parseCodexIsBlocking(params.is_blocking);
  }
  return true;
}
