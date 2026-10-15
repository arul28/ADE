// Why an office preview could not be produced, in terms the viewers can turn
// into copy and a fallback. A raw exception is never shown to a user.

export type OoxmlFailureReason =
  /** The bytes are not a zip archive at all (a renamed CSV, a truncated download). */
  | "not-zip"
  /** Legacy binary format (.xls/.ppt) or a password-protected OOXML package. */
  | "encrypted-or-legacy"
  /** An entry past the preview size cap. */
  | "too-large"
  /** The package exists but does not contain the parts this format requires. */
  | "invalid"
  /** Zip-level damage, a refused entry, or an unsupported compression method. */
  | "corrupt";

export class OoxmlError extends Error {
  readonly reason: OoxmlFailureReason;

  constructor(reason: OoxmlFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = "OoxmlError";
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A short, honest line for a viewer's failure card.
 *
 * Both viewers import their parser dynamically, so this lives here rather than
 * being pulled in alongside it: the message of an `OoxmlError` IS the copy, and
 * anything else gets the generic line rather than a raw stack.
 */
export function ooxmlFailureMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "The file could not be parsed.";
}
