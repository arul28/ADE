import { describe, expect, it } from "vitest";
import { parseTrustedDirectoryBaseUrl } from "./accountBridge";

// The bearer sent to the directory is the machine's account token, so the only
// security-relevant unit is where that token is allowed to go: an https origin,
// or http on a loopback host for local dev. Everything else must be rejected.
describe("parseTrustedDirectoryBaseUrl", () => {
  it("accepts an https URL and normalizes trailing slashes", () => {
    expect(parseTrustedDirectoryBaseUrl("https://directory.ade.dev/")).toBe(
      "https://directory.ade.dev",
    );
    expect(
      parseTrustedDirectoryBaseUrl("https://directory.ade.dev/account//"),
    ).toBe("https://directory.ade.dev/account");
  });

  it("accepts http on loopback hosts for local dev", () => {
    expect(parseTrustedDirectoryBaseUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(parseTrustedDirectoryBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(parseTrustedDirectoryBaseUrl("http://[::1]:8787")).toBe(
      "http://[::1]:8787",
    );
  });

  it("rejects http to a remote host", () => {
    expect(parseTrustedDirectoryBaseUrl("http://evil.example.com")).toBeNull();
    expect(
      parseTrustedDirectoryBaseUrl("http://directory.ade.dev/account"),
    ).toBeNull();
  });

  it("rejects bare, relative, or non-URL strings", () => {
    expect(parseTrustedDirectoryBaseUrl("directory.ade.dev")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("/account/machines")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("not a url")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("   ")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl(null)).toBeNull();
    expect(parseTrustedDirectoryBaseUrl(undefined)).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(parseTrustedDirectoryBaseUrl("ftp://directory.ade.dev")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("ws://localhost:8787")).toBeNull();
    expect(parseTrustedDirectoryBaseUrl("file:///etc/passwd")).toBeNull();
  });
});
