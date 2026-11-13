import { describe, expect, it } from "vitest";

import { decodeAttributedBody } from "./attributedBody";

/**
 * The fixed typedstream prefix Messages writes before the string body:
 * `streamtyped`, the NSAttributedString/NSObject class chain, then `NSString`
 * with its `+` (0x2B) value tag. Real blobs continue with the length and UTF-8
 * bytes this file appends.
 */
const TYPEDSTREAM_PREFIX = Buffer.from([
  0x04, 0x0b,
  ...Buffer.from("streamtyped", "utf8"),
  0x81, 0xe8, 0x03, 0x84, 0x01, 0x40,
  0x84, 0x84, 0x84, 0x12,
  ...Buffer.from("NSAttributedString", "utf8"),
  0x00,
  0x84, 0x84, 0x08,
  ...Buffer.from("NSObject", "utf8"),
  0x00,
  0x85, 0x92,
  0x84, 0x84, 0x84, 0x08,
  ...Buffer.from("NSString", "utf8"),
  0x01, 0x94, 0x84, 0x01, 0x2b,
]);

/** Bytes Messages writes after the string body (range/version metadata). */
const TYPEDSTREAM_SUFFIX = Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x2b]);

function typedstream(body: string, lengthEncoding: "short" | "uint16" | "uint32" = "short"): Buffer {
  const bodyBytes = Buffer.from(body, "utf8");
  let lengthBytes: Buffer;
  if (lengthEncoding === "uint16") {
    lengthBytes = Buffer.alloc(3);
    lengthBytes[0] = 0x81;
    lengthBytes.writeUInt16LE(bodyBytes.length, 1);
  } else if (lengthEncoding === "uint32") {
    lengthBytes = Buffer.alloc(5);
    lengthBytes[0] = 0x82;
    lengthBytes.writeUInt32LE(bodyBytes.length, 1);
  } else {
    lengthBytes = Buffer.from([bodyBytes.length]);
  }
  return Buffer.concat([TYPEDSTREAM_PREFIX, lengthBytes, bodyBytes, TYPEDSTREAM_SUFFIX]);
}

describe("decodeAttributedBody", () => {
  it.each([
    ["a short string", typedstream("hello"), "hello"],
    ["a code-shaped string", typedstream("482913"), "482913"],
  ])("decodes %s", (_name, blob, expected) => {
    expect(decodeAttributedBody(blob)).toBe(expected);
  });

  it("decodes a string longer than 127 bytes, which uses the 0x81 uint16 length", () => {
    const body = "A".repeat(200);
    expect(decodeAttributedBody(typedstream(body, "uint16"))).toBe(body);
  });

  it("uses the byte count, not the character count, for multi-byte UTF-8", () => {
    const body = "Your code is 482913 🎉 — don’t share it";
    expect(decodeAttributedBody(typedstream(body))).toBe(body);
  });

  it("decodes a string written with the 0x82 uint32 length", () => {
    expect(decodeAttributedBody(typedstream("hello", "uint32"))).toBe("hello");
  });

  it.each([
    ["an empty blob", Buffer.alloc(0)],
    ["random text", Buffer.from("this is not a typedstream", "utf8")],
    ["the class marker with no tag", Buffer.concat([TYPEDSTREAM_PREFIX.subarray(0, -1), Buffer.from("!!")])],
  ])("returns null for %s", (_name, blob) => {
    expect(decodeAttributedBody(blob)).toBeNull();
  });

  it("returns null for a body truncated below its declared length", () => {
    const blob = Buffer.concat([TYPEDSTREAM_PREFIX, Buffer.from([0x20]), Buffer.from("short", "utf8")]);
    expect(decodeAttributedBody(blob)).toBeNull();
  });

  it("returns null for invalid UTF-8 rather than replacement characters", () => {
    const blob = Buffer.concat([TYPEDSTREAM_PREFIX, Buffer.from([0x02, 0xff, 0xfe])]);
    expect(decodeAttributedBody(blob)).toBeNull();
  });

  it("returns null for an unsupported length marker (0x83)", () => {
    const blob = Buffer.concat([TYPEDSTREAM_PREFIX, Buffer.from([0x83, 0x01, 0x00, 0x00, 0x00, 0x41])]);
    expect(decodeAttributedBody(blob)).toBeNull();
  });

  it("returns null for a missing blob", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(undefined)).toBeNull();
  });
});
