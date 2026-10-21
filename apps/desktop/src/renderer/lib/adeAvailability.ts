/**
 * Whether a `window.ade` member really exists in this window.
 *
 * The hosted web client implements only part of `window.ade`. A member it lacks
 * is still a callable (so a direct call never throws synchronously inside an
 * effect), but it carries {@link ADE_UNAVAILABLE}, its calls reject with
 * {@link AdeUnavailableError}, and a truthiness check on it would pass. Feature
 * checks go through {@link isAdeAvailable} instead.
 */
export const ADE_UNAVAILABLE: unique symbol = Symbol.for("ade.unavailable") as never;

export class AdeUnavailableError extends Error {
  readonly code = "ade_unavailable";
  constructor(readonly member: string) {
    super(`${member} is not available in the ADE web app.`);
    this.name = "AdeUnavailableError";
  }
}

/** True when `value` is a real `window.ade` namespace or method, not a stand-in. */
export function isAdeAvailable(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return (value as { [ADE_UNAVAILABLE]?: boolean })[ADE_UNAVAILABLE] !== true;
}

export function isAdeUnavailableError(error: unknown): error is AdeUnavailableError {
  return error instanceof AdeUnavailableError
    || (typeof error === "object" && error != null && (error as { code?: unknown }).code === "ade_unavailable");
}
