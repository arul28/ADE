import { describe, expect, it } from "vitest";
import { endsInsideOsc52, OSC52_MAX_BASE64_CHARS, parseOsc52Payload } from "./osc52";

describe("OSC 52", () => {
  it.each([
    ["c;aGVsbG8=", { kind: "write", text: "hello" }],
    // A read would hand this computer's clipboard to the program that asked.
    ["c;?", { kind: "ignore", reason: "query" }],
    // An empty payload would clear the clipboard.
    ["c;", { kind: "ignore", reason: "empty" }],
    [`c;${"A".repeat(OSC52_MAX_BASE64_CHARS + 4)}`, { kind: "ignore", reason: "too-large" }],
    ["c;not base64!", { kind: "ignore", reason: "invalid" }],
  ])("parses %#", (payload, expected) => {
    expect(parseOsc52Payload(payload)).toEqual(expected);
  });

  it.each([
    ["\x1b]52;c;aGVs", true],
    ["\x9d52;c;aGVs", true],
    ["\x1b]52;c;aGVsbG8=\x07", false],
    ["\x1b]52;c;aGVsbG8=\x1b\\", false],
    ["\x1b]52;c;aGVs\x18", false],
    ["\x1b]52;c;aGVsbG8=\x07 then \x1b]52;c;d29y", true],
    ["plain output", false],
  ])("knows when history stops inside a copy %#", (data, open) => {
    expect(endsInsideOsc52(data)).toBe(open);
  });
});
