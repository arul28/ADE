/**
 * Extracts the plain string from an iMessage `message.attributedBody` blob.
 *
 * Modern macOS stores a message's text in `message.text` only when the text is
 * plain. A message with a link preview, an emoji-rendered attribute, or a rich
 * style keeps `text` NULL and stores an `NSAttributedString` serialised as an
 * Apple typedstream in `attributedBody`. Without this decoder those messages
 * look empty and a sign-in code inside one is silently lost.
 *
 * The typedstream is a chain of length-prefixed objects. The string is the
 * extent after the `NSString` class marker: a `+` (0x2B) tag, then the byte
 * count (one byte below 0x80, `0x81` + uint16 LE, or `0x82` + uint32 LE),
 * then that many UTF-8 bytes. There is no public format description, so the
 * marker search is defensive: a malformed blob returns null rather than a
 * truncated or mojibake string.
 *
 * Privacy: the decoded text is a message body. It is returned to the caller and
 * must never be written to a log, telemetry event, error message or test name.
 *
 * @module messages/attributedBody
 */

/** The class name typedstream writes before an NSString payload. */
const NSStringMarker = Buffer.from("NSString", "utf8");

/** The typedstream tag that introduces a string value. */
const STRING_TAG = 0x2b;

/**
 * How far past the class marker the `+` tag may sit before the candidate is
 * rejected. Real blobs put it four bytes later (`01 94 84 01`); the allowance
 * covers minor writer differences without letting a later object's tag stand in.
 */
const MAX_TAG_DISTANCE = 32;

/**
 * Returns the plain text stored in an `attributedBody` blob, or null when the
 * blob is not a typedstream whose string this decoder can prove.
 */
export function decodeAttributedBody(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob) return null;
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (bytes.length === 0) return null;

  let searchFrom = 0;
  while (searchFrom < bytes.length) {
    const markerAt = bytes.indexOf(NSStringMarker, searchFrom);
    if (markerAt === -1) return null;

    const tagAt = bytes.indexOf(STRING_TAG, markerAt + NSStringMarker.length);
    if (tagAt !== -1 && tagAt - markerAt <= MAX_TAG_DISTANCE) {
      const value = readLengthPrefixedString(bytes, tagAt + 1);
      if (value !== null) return value;
    }
    // Another `NSString` marker later in the blob (a swapped key or a nested
    // attribute) is still worth a look; a marker with no usable payload is not
    // allowed to consume the rest of the search.
    searchFrom = markerAt + 1;
  }
  return null;
}

/** Reads the string body that starts at `start`, or null when it is malformed. */
function readLengthPrefixedString(bytes: Buffer, start: number): string | null {
  if (start >= bytes.length) return null;

  let cursor = start;
  const first = bytes[cursor]!;
  cursor += 1;

  let length: number;
  if (first < 0x80) {
    length = first;
  } else if (first === 0x81) {
    if (cursor + 2 > bytes.length) return null;
    length = bytes.readUInt16LE(cursor);
    cursor += 2;
  } else if (first === 0x82) {
    if (cursor + 4 > bytes.length) return null;
    length = bytes.readUInt32LE(cursor);
    cursor += 4;
  } else {
    return null;
  }

  // A declared length larger than what the blob holds means the value is
  // truncated (or the tag was not a string after all). Refuse rather than
  // return the partial run.
  if (cursor + length > bytes.length) return null;
  if (length === 0) return "";

  try {
    // Fatal mode: invalid UTF-8 is a corrupt blob, not a reason to hand back
    // replacement characters that could hide a code inside garbage.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor, cursor + length));
  } catch {
    return null;
  }
}
