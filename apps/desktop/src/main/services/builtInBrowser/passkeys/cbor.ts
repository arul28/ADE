/**
 * CBOR for WebAuthn: the small subset CTAP2 uses, and nothing more.
 *
 * Encoding covers maps with integer and text keys, byte strings, text,
 * non-negative and negative integers, arrays, booleans and null. Map keys are
 * written in CTAP2 canonical order (shorter encoded key first, then bytewise
 * lexicographic), because an authenticator's attestation object and COSE key
 * are checked for exactly that order by strict relying parties.
 *
 * Decoding reads the same subset back, rejecting indefinite lengths, tags,
 * floats, non-safe integers, duplicate map keys and trailing bytes. It exists
 * so a relying party (and the tests here) can read an attestation object or a
 * COSE key without pulling a CBOR dependency into Electron main.
 */
import { TextDecoder, TextEncoder } from "node:util";

/** COSE and attestation maps only use integer and text keys. */
export type CborMapKey = number | string;
export type CborMap = Map<CborMapKey, CborValue>;
export type CborValue = number | string | Uint8Array | boolean | null | CborValue[] | CborMap;

const MAX_DEPTH = 32;
const utf8Encoder = new TextEncoder();

/** Encode one value. Throws for anything outside the CTAP2 subset. */
export function encodeCbor(value: CborValue): Buffer {
  const out: Buffer[] = [];
  encodeValue(value, out, 0);
  return Buffer.concat(out);
}

function encodeValue(value: CborValue, out: Buffer[], depth: number): void {
  if (depth > MAX_DEPTH) throw new RangeError("CBOR value is nested too deeply.");
  if (typeof value === "number") {
    out.push(encodeInteger(value));
    return;
  }
  if (typeof value === "string") {
    const bytes = utf8Encoder.encode(value);
    out.push(encodeHead(3, bytes.length), Buffer.from(bytes));
    return;
  }
  if (typeof value === "boolean") {
    out.push(Buffer.from([value ? 0xf5 : 0xf4]));
    return;
  }
  if (value === null) {
    out.push(Buffer.from([0xf6]));
    return;
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    out.push(encodeHead(2, bytes.length), bytes);
    return;
  }
  if (Array.isArray(value)) {
    out.push(encodeHead(4, value.length));
    for (const item of value) encodeValue(item, out, depth + 1);
    return;
  }
  if (value instanceof Map) {
    encodeMap(value, out, depth);
    return;
  }
  throw new TypeError("Unsupported CBOR value.");
}

function encodeMap(value: CborMap, out: Buffer[], depth: number): void {
  const entries = Array.from(value, ([key, entryValue]) => {
    if (typeof key !== "number" && typeof key !== "string") {
      throw new TypeError("CBOR map keys must be integers or text.");
    }
    return { keyBytes: encodeCbor(key), value: entryValue };
  });
  // CTAP2 canonical order: sort on the encoded key's bytes, shorter first.
  entries.sort((a, b) => a.keyBytes.length - b.keyBytes.length || Buffer.compare(a.keyBytes, b.keyBytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.keyBytes.equals(entries[index]!.keyBytes)) {
      throw new TypeError("CBOR maps cannot contain the same key twice.");
    }
  }
  out.push(encodeHead(5, entries.length));
  for (const entry of entries) {
    out.push(entry.keyBytes);
    encodeValue(entry.value, out, depth + 1);
  }
}

function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value)) throw new RangeError("CBOR integers must be safe integers.");
  return value >= 0 ? encodeHead(0, value) : encodeHead(1, -1 - value);
}

function encodeHead(major: number, length: number): Buffer {
  const prefix = major << 5;
  if (length < 24) return Buffer.from([prefix | length]);
  if (length <= 0xff) return Buffer.from([prefix | 24, length]);
  if (length <= 0xffff) {
    const bytes = Buffer.alloc(3);
    bytes[0] = prefix | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  if (length <= 0xffffffff) {
    const bytes = Buffer.alloc(5);
    bytes[0] = prefix | 26;
    bytes.writeUInt32BE(length, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(9);
  bytes[0] = prefix | 27;
  bytes.writeBigUInt64BE(BigInt(length), 1);
  return bytes;
}
