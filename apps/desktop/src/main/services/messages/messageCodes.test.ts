import { describe, expect, it } from "vitest";

import { extractSignInCode } from "./messageCodes";

describe("extractSignInCode", () => {
  it.each([
    ["Google's G-prefixed code", "G-123456 is your Google verification code.", "123456"],
    ["Apple ID code", "Your Apple ID code is: 483920. Don't share it.", "483920"],
    ["a space-grouped code", "Your code is 482 913", "482913"],
    ["a hyphen-grouped code", "Your code: 123-456", "123456"],
    ["a short verify code", "Use 1234 to verify", "1234"],
    ["a bank verification code", "Your Bank of America verification code is 924811", "924811"],
    ["an Uber code", "<#> Your Uber code: 4821", "4821"],
    ["a Steam Guard alphanumeric code", "Your Steam Guard code: AB12CD", "AB12CD"],
    ["a PIN", "PIN 8842", "8842"],
    ["a login code", "Your login code is 55219", "55219"],
    ["a verification alphanumeric code", "Verification code: 1F7K9Q", "1F7K9Q"],
    ["a one-time passcode", "Your one-time passcode is 330192", "330192"],
    ["a sign-in code", "Your sign-in code is 7766", "7766"],
    ["an OTP", "Amazon: your OTP is 4821. Expires in 10 minutes.", "4821"],
    ["a 2FA code", "Your 2FA code is 90210", "90210"],
    ["a code next to a sign-in instruction", "Use code 1234 to sign in", "1234"],
  ])("extracts %s", (_name, text, expected) => {
    expect(extractSignInCode(text)?.code).toBe(expected);
  });

  it.each([
    ["a dollar amount", "Your order total is $1234.00"],
    ["a phone number", "Call 555-123-4567"],
    ["a phone number in parentheses", "Call (555) 123-4567"],
    ["a time", "Meeting at 10:30"],
    ["an ISO date", "Your package arrives 2026-11-13"],
    ["a slash date", "You spent $45.20 at Whole Foods on 10/12"],
    ["a year", "Happy birthday! Let's meet in 2027"],
    ["a year used as a code-shaped number", "Your code is 2024"],
    ["an order number", "Costco order #4821 has shipped"],
    ["a postal code", "Your postal code is 94103"],
    ["a card's last four digits", "Your card ending in 4821 was charged $52.10"],
    ["a nine-digit number outside the code range", "Your verification code is 123456789"],
    ["marketing copy with no number", "Reply STOP to opt out"],
    ["a promo code at checkout", "Use code SAVE20 at checkout for 20% off"],
    ["a discount code", "Your discount code is 482913"],
    ["a one-digit number", "Table for 4 at 7"],
    ["empty text", ""],
  ])("returns null for %s", (_name, text) => {
    expect(extractSignInCode(text)).toBeNull();
  });

  it("prefers the number nearest a code keyword over an earlier bare number", () => {
    const result = extractSignInCode("Reference 90210. Your verification code is 482913.");
    expect(result?.code).toBe("482913");
    expect(result?.confidence).toBeGreaterThan(0.8);
  });

  it("rates a keyword-adjacent code above a bare number", () => {
    const keyworded = extractSignInCode("Your code is 482913");
    const bare = extractSignInCode("Reference 482913");
    expect(keyworded?.confidence).toBeGreaterThan(bare?.confidence ?? 1);
  });

  it("returns null for null and undefined input", () => {
    expect(extractSignInCode(null)).toBeNull();
    expect(extractSignInCode(undefined)).toBeNull();
  });
});
