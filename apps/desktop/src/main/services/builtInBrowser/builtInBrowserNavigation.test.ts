import { describe, expect, it } from "vitest";
import { isAllowedNavigationUrl, normalizeBrowserUrl } from "./builtInBrowserNavigation";

describe("builtInBrowserNavigation", () => {
  it("normalizes plain domains to https URLs", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("normalizes localhost-like URLs to http", () => {
    expect(normalizeBrowserUrl("localhost:5173/work")).toBe("http://localhost:5173/work");
    expect(normalizeBrowserUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("allows only http, https, and about:blank navigation", () => {
    expect(isAllowedNavigationUrl("https://example.com")).toBe(true);
    expect(isAllowedNavigationUrl("http://localhost:5173")).toBe(true);
    expect(isAllowedNavigationUrl("about:blank")).toBe(true);
    expect(isAllowedNavigationUrl("file:///tmp/test.html")).toBe(false);
    expect(isAllowedNavigationUrl("about:config")).toBe(false);
  });

  it("rejects unsupported normalized protocols", () => {
    expect(() => normalizeBrowserUrl("file:///tmp/test.html")).toThrow("Unsupported browser URL protocol");
    expect(() => normalizeBrowserUrl("about:config")).toThrow("Only about:blank");
  });
});
