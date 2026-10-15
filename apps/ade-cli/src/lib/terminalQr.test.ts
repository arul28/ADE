import { describe, expect, it } from "vitest";
import { renderTerminalQr } from "./terminalQr";

/**
 * The terminal QR code carries the sign-in link of `ade login`. A wrong code
 * fails silently: it draws, and a phone refuses it. So one drawing is pinned
 * against an answer that did not come from this encoder.
 */
describe("renderTerminalQr", () => {
  it("draws the sign-in link as a code that an independent reader decodes", () => {
    // This drawing was read back from the text alone by Apple's CoreImage QR
    // detector, which returned the link. Any encoding mistake (data bits, error
    // correction, masking, format bits) changes it.
    expect(renderTerminalQr("https://ade-app.dev/device?user_code=ABCD-EFGH", { color: false })!.split("\n")).toEqual([
      "█████████████████████████████████",
      "██ ▄▄▄▄▄ █▄▀ ▀ ▄▄█▀█▀▄▄█ ▄▄▄▄▄ ██",
      "██ █   █ █   █▀▄ ▀█▀█▄▄█ █   █ ██",
      "██ █▄▄▄█ █▄█▀ ▄▀▄▄ ██ ██ █▄▄▄█ ██",
      "██▄▄▄▄▄▄▄█▄█ █ █▄█ ▀ █▄█▄▄▄▄▄▄▄██",
      "██    █▀▄▀▄█ ▄ ▄▄█ ▄  ▀ ▀▀ ▄▄█ ██",
      "███  █▄▀▄█▀  ▄▄ ▄▀▄█▀█▀▀▀▀▀█▄▄▀██",
      "███▄ █▀▄▄ █ ▄▀ █ ▀▀ █ ▀▀▀▀█▄ ▀▀██",
      "██▀█ ▄▀▄▄▀██  ██▀███▄ ▀▀▄ ▀█▄ ▄██",
      "████ ▄▄▄▄▄ ████▀█▀█▀▀█▀ █ ▄ ▀ ███",
      "██▄█▄▄█▄▄  █▄▀▄█    ▀█▄▄██▄█ ████",
      "███▄██▄█▄▄▀▄▄▄█▀█ ▀▄▄▄ ▄▄▄   ▀▀██",
      "██ ▄▄▄▄▄ ██ █  ▀▀▀▀▄ ▄ █▄█  █▄███",
      "██ █   █ █▀▄▀▀ █    ▀█ ▄▄  ▀▄█ ██",
      "██ █▄▄▄█ █ ▀▀▀█▄ ▀▀▄██▀█▀ ▀▀▄▀▄██",
      "██▄▄▄▄▄▄▄█▄█▄▄██████▄▄▄█▄▄███▄███",
      "█████████████████████████████████",
    ]);
  });

  it.each([
    // The largest code this encoder draws (version 10, level L) holds 271 bytes.
    ["the longest text that fits", "x".repeat(271), {}, true],
    ["one byte too many", "x".repeat(272), {}, false],
    // Capacity is counted in UTF-8 bytes, not characters: "é" is two.
    ["non-ASCII text that fits in bytes", "é".repeat(135), {}, true],
    ["non-ASCII text that fits in characters only", "é".repeat(136), {}, false],
    // A short link is 33 columns wide with its quiet zone.
    ["a terminal exactly as wide as the code", "https://ade-app.dev/device?user_code=ABCD-EFGH", { maxColumns: 33 }, true],
    ["a terminal one column too narrow", "https://ade-app.dev/device?user_code=ABCD-EFGH", { maxColumns: 32 }, false],
  ] as Array<[string, string, { maxColumns?: number }, boolean]>)("answers %s with a code or with nothing, never a broken code", (_label, text, options, drawn) => {
    const plain = renderTerminalQr(text, { ...options, color: false });
    // "Nothing" is the caller's signal to print the link as text instead.
    expect(plain === null).toBe(!drawn);
    if (!drawn) return;
    const rows = plain!.split("\n");
    // Square in modules: two module rows per text row, the same width in every row.
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    expect(rows.length).toBe(Math.ceil(rows[0].length / 2));
    // Black on white when colors can be used: the same drawing, painted.
    const painted = renderTerminalQr(text, { ...options, color: true })!;
    expect(painted.split("\n")).toHaveLength(rows.length);
    expect(painted).toContain("\u001b[");
    expect(plain).not.toContain("\u001b[");
  });
});
