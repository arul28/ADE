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
const MAX_CONTAINER_LENGTH = 65_536;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

/** Decode exactly one CBOR value; trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { value, offset } = decodeValue(buf, 0, 0);
  if (offset !== buf.length) throw new RangeError("Trailing bytes after the CBOR value.");
  return value;
}

function decodeValue(buf: Buffer, offset: number, depth: number): { value: CborValue; offset: number } {
  if (depth > MAX_DEPTH) throw new RangeError("CBOR value is nested too deeply.");
  if (offset >= buf.length) throw new RangeError("Truncated CBOR value.");
  const initial = buf[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0: {
      const { length, next } = readArgument(buf, offset, info);
      return { value: length, offset: next };
    }
    case 1: {
      const { length, next } = readArgument(buf, offset, info);
      return { value: -1 - length, offset: next };
    }
    case 2: {
      const { length, next } = readArgument(buf, offset, info);
      return readBytes(buf, next, length);
    }
    case 3: {
      const { length, next } = readArgument(buf, offset, info);
      const result = readBytes(buf, next, length);
      let text: string;
      try {
        text = utf8Decoder.decode(result.value as Buffer);
      } catch {
        throw new RangeError("Invalid UTF-8 in CBOR text.");
      }
      return { value: text, offset: result.offset };
    }
    case 4: {
      const { length, next } = readArgument(buf, offset, info);
      if (length > MAX_CONTAINER_LENGTH) throw new RangeError("CBOR array is too long.");
      const items: CborValue[] = [];
      let cursor = next;
      for (let index = 0; index < length; index += 1) {
        const decoded = decodeValue(buf, cursor, depth + 1);
        items.push(decoded.value);
        cursor = decoded.offset;
      }
      return { value: items, offset: cursor };
    }
    case 5: {
      const { length, next } = readArgument(buf, offset, info);
      if (length > MAX_CONTAINER_LENGTH) throw new RangeError("CBOR map is too long.");
      const map: CborMap = new Map();
      let cursor = next;
      for (let index = 0; index < length; index += 1) {
        const key = decodeValue(buf, cursor, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") {
          throw new RangeError("CBOR map keys must be integers or text.");
        }
        const entry = decodeValue(buf, key.offset, depth + 1);
        if (map.has(key.value)) throw new RangeError("CBOR map has a duplicate key.");
        map.set(key.value, entry.value);
        cursor = entry.offset;
      }
      return { value: map, offset: cursor };
    }
    case 7: {
      if (info === 20) return { value: false, offset: offset + 1 };
      if (info === 21) return { value: true, offset: offset + 1 };
      if (info === 22) return { value: null, offset: offset + 1 };
      throw new RangeError("Unsupported CBOR simple value.");
    }
    default:
      throw new RangeError("Unsupported CBOR major type.");
  }
}

function readBytes(buf: Buffer, offset: number, length: number): { value: Buffer; offset: number } {
  if (length > buf.length - offset) throw new RangeError("Truncated CBOR value.");
  return { value: buf.subarray(offset, offset + length), offset: offset + length };
}

function readArgument(buf: Buffer, offset: number, info: number): { length: number; next: number } {
  if (info < 24) return { length: info, next: offset + 1 };
  const need = (bytes: number): void => {
    if (offset + bytes > buf.length) throw new RangeError("Truncated CBOR value.");
  };
  if (info === 24) {
    need(2);
    return { length: buf[offset + 1]!, next: offset + 2 };
  }
  if (info === 25) {
    need(3);
    return { length: buf.readUInt16BE(offset + 1), next: offset + 3 };
  }
  if (info === 26) {
    need(5);
    return { length: buf.readUInt32BE(offset + 1), next: offset + 5 };
  }
  if (info === 27) {
    need(9);
    const value = buf.readBigUInt64BE(offset + 1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("CBOR integer is too large.");
    return { length: Number(value), next: offset + 9 };
  }
  throw new RangeError("Unsupported CBOR additional information.");
}
