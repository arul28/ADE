import { describe, expect, it } from "vitest";

import { appleMessageDateToIso, handlesMatch, normalizeHandle } from "./messagesDatabase";

/** Apple's epoch, 2001-01-01T00:00:00Z, as a UNIX timestamp. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

describe("appleMessageDateToIso", () => {
  it("reads modern macOS nanoseconds since 2001", () => {
    // 2026-11-13T00:00:00Z, written the way current macOS writes message.date.
    const nanos = (Date.UTC(2026, 10, 13) - APPLE_EPOCH_MS) * 1_000_000;
    expect(appleMessageDateToIso(nanos)).toBe("2026-11-13T00:00:00.000Z");
  });

  it("reads seconds since 2001 from very old databases", () => {
    const seconds = (Date.UTC(2014, 5, 1, 12, 30) - APPLE_EPOCH_MS) / 1000;
    expect(appleMessageDateToIso(seconds)).toBe("2014-06-01T12:30:00.000Z");
  });

  it("accepts a bigint column value", () => {
    const nanos = BigInt((Date.UTC(2026, 10, 13) - APPLE_EPOCH_MS) * 1_000_000);
    expect(appleMessageDateToIso(nanos)).toBe("2026-11-13T00:00:00.000Z");
  });

  it.each([
    ["zero", 0],
    ["null", null],
    ["undefined", undefined],
    ["a negative value", -1],
    ["a non-numeric string", "not-a-number"]
  ])("returns null for %s", (_name, value) => {
    expect(appleMessageDateToIso(value as number | string | null | undefined)).toBeNull();
  });

  it("returns null for an implausible far-future value", () => {
    const nanos = (Date.UTC(2500, 0, 1) - APPLE_EPOCH_MS) * 1_000_000;
    expect(appleMessageDateToIso(nanos)).toBeNull();
  });
});

describe("normalizeHandle", () => {
  it.each([
    ["a formatted US number", "+1 (555) 123-4567", "5551234567"],
    ["a bare US number", "5551234567", "5551234567"],
    ["an email", "Person@Example.COM", "person@example.com"],
    ["a short code", "12345", "12345"],
    ["blank input", "   ", ""],
  ])("normalizes %s", (_name, input, expected) => {
    expect(normalizeHandle(input)).toBe(expected);
  });
});

describe("handlesMatch", () => {
  it("matches the same phone number written with different formatting and country code", () => {
    expect(handlesMatch("+1 (555) 123-4567", "555-123-4567")).toBe(true);
  });

  it("matches an email case-insensitively", () => {
    expect(handlesMatch("Sam@Example.com", "sam@example.COM")).toBe(true);
  });

  it("does not match different numbers", () => {
    expect(handlesMatch("+1 555 123 4567", "+1 555 123 4568")).toBe(false);
  });

  it("does not match an empty input with anything", () => {
    expect(handlesMatch("", "")).toBe(false);
  });
});
