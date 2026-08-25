import { describe, expect, it } from "vitest";
import { isLoopbackHostname, trustedHttpsOrigin } from "../src/trustedOrigin";

/**
 * The accept/reject sets these three call sites used to each decide for
 * themselves — the push relay base URL, the hosted web client's CORS origin,
 * and the diagnostics route's loopback exemption. Pinned here so the shared
 * helper cannot loosen any of them by accident.
 */
describe("trustedHttpsOrigin", () => {
  it.each([
    ["https origin", "https://relay.ade.dev", "https://relay.ade.dev"],
    ["https with a port", "https://relay.ade.dev:8443", "https://relay.ade.dev:8443"],
    ["http on localhost", "http://localhost:8787", "http://localhost:8787"],
    ["http on 127.0.0.1", "http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http on the IPv6 loopback", "http://[::1]:8787", "http://[::1]:8787"],
    ["surrounding whitespace", "  https://relay.ade.dev  ", "https://relay.ade.dev"],
  ])("accepts %s", (_label, raw, expected) => {
    expect(trustedHttpsOrigin(raw)).toBe(expected);
  });

  it.each([
    ["nothing configured", undefined],
    ["an empty string", "   "],
    ["plain http off loopback", "http://relay.ade.dev"],
    // A hostname that merely *contains* a loopback name is a different host.
    ["a lookalike hostname", "http://localhost.evil.test"],
    ["a non-http scheme", "ws://relay.ade.dev"],
    ["embedded credentials", "https://user:pass@relay.ade.dev"],
    ["a query string", "https://relay.ade.dev/?token=abc"],
    ["a fragment", "https://relay.ade.dev/#frag"],
    ["a value that is not a URL", "relay.ade.dev"],
  ])("rejects %s", (_label, raw) => {
    expect(trustedHttpsOrigin(raw)).toBeNull();
  });

  it("keeps the origin of a base URL that carries a path, and refuses it as an exact origin", () => {
    // The one difference between the two call sites: the relay gets paths
    // appended to its base, the CORS allow-list is matched against a bare
    // `Origin` header and so must not silently truncate one.
    expect(trustedHttpsOrigin("https://relay.ade.dev/push")).toBe("https://relay.ade.dev");
    expect(trustedHttpsOrigin("https://relay.ade.dev/push", { requireExactOrigin: true })).toBeNull();
    expect(trustedHttpsOrigin("https://app.ade.dev", { requireExactOrigin: true }))
      .toBe("https://app.ade.dev");
    // `new URL` normalizes a bare host to a trailing slash, which is not the
    // origin — an allow-list entry written that way is a misconfiguration.
    expect(trustedHttpsOrigin("https://app.ade.dev/", { requireExactOrigin: true })).toBeNull();
  });
});

describe("isLoopbackHostname", () => {
  it("names the three spellings of this machine and nothing else", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
    // `URL.hostname` keeps the brackets, so the bare form never reaches here.
    for (const hostname of ["::1", "127.0.0.2", "localhost.evil.test", "app.ade.dev", ""]) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });
});
