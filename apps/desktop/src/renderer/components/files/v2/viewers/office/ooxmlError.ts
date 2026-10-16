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
 * Only a parser's own `OoxmlError` message is authored as user-facing copy, so
 * only that is shown verbatim. The one error from outside the parsers that can
 * reach here is `streamFileBytes` refusing a read past the byte cap, which gets
 * its own sentence rather than the helper's byte-limit string; anything else
 * (an IPC rejection, a DOM exception) falls back to the generic line, because
 * raw error text is not a thing to put in front of a reader.
 */
export function ooxmlFailureMessage(err: unknown): string {
  if (err instanceof OoxmlError && err.message) return err.message;
  if (err instanceof Error && /too large to stream/i.test(err.message)) {
    return "This file is too large to preview. Open it externally.";
  }
  return "The file could not be parsed.";
}
