import { describe, expect, it } from "vitest";
import { normalizeTotpInput, parseTotp, totpCode } from "./passwordTotp";

// RFC 6238 appendix B: the shared secrets are ASCII "12345678901234567890"
// repeated to the hash's key length, and 8-digit codes at fixed times.
const b32 = (ascii: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of Buffer.from(ascii)) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
};
const SHA1 = b32("12345678901234567890");
const SHA256 = b32("12345678901234567890123456789012");
const SHA512 = b32("1234567890123456789012345678901234567890123456789012345678901234");

describe("authenticator codes", () => {
  it.each([
    [59, "SHA1", SHA1, "94287082"],
    [1111111109, "SHA1", SHA1, "07081804"],
    [2000000000, "SHA1", SHA1, "69279037"],
    [59, "SHA256", SHA256, "46119246"],
    [1234567890, "SHA256", SHA256, "91819424"],
    [59, "SHA512", SHA512, "90693936"],
    [20000000000, "SHA512", SHA512, "47863826"],
  ])("matches RFC 6238 at t=%i with %s", (seconds, algorithm, secret, expected) => {
    const params = parseTotp(`otpauth://totp/x?secret=${secret}&digits=8&algorithm=${algorithm}`);
    expect(params).not.toBeNull();
    expect(totpCode(params!, seconds * 1000).code).toBe(expected);
  });

  it.each([
    ["not a key", null],
    ["otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ", null],
    ["otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=5", null],
    ["otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5", null],
  ])("refuses %s", (input, expected) => {
    expect(parseTotp(input)).toBe(expected);
  });

  it("turns a bare key a site shows into a URI that gives the same codes", () => {
    const uri = normalizeTotpInput("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "github.com");
    expect(uri).toMatch(/^otpauth:\/\/totp\/github\.com\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ$/);
    expect(totpCode(parseTotp(uri!)!, 59_000).code).toBe("287082");
  });
});
