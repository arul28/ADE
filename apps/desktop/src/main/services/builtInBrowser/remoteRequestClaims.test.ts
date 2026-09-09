import { describe, expect, it } from "vitest";
import { createRemoteRequestClaims } from "./remoteRequestClaims";

describe("createRemoteRequestClaims", () => {
  it("gives a forwarded request to the first window that asks for it", () => {
    const claims = createRemoteRequestClaims();

    expect(claims.claim("bbr-1")).toBe(true);
    expect(claims.claim("bbr-1")).toBe(false);
    expect(claims.claim("bbr-1")).toBe(false);
    // A different request is a different race.
    expect(claims.claim("bbr-2")).toBe(true);
  });

  it("lets a request with no id through rather than making it unanswerable", () => {
    // An older daemon can publish without one. Refusing would turn a duplicate
    // navigation into `ade browser open` doing nothing at all.
    const claims = createRemoteRequestClaims();

    expect(claims.claim("")).toBe(true);
    expect(claims.claim("")).toBe(true);
  });

  it("forgets a claim once no requester could still be waiting on it", () => {
    let now = 1_000;
    const claims = createRemoteRequestClaims({ ttlMs: 100, now: () => now });

    expect(claims.claim("bbr-1")).toBe(true);
    now += 99;
    expect(claims.claim("bbr-1")).toBe(false);
    now += 2;
    // Same id, long after the fact: a genuinely new request, not the twin of
    // one already answered.
    expect(claims.claim("bbr-1")).toBe(true);
  });

  it("keeps the remembered set bounded under a flood", () => {
    let now = 0;
    const claims = createRemoteRequestClaims({ ttlMs: 60_000, max: 3, now: () => now });

    for (let index = 0; index < 50; index += 1) {
      now += 1;
      expect(claims.claim(`bbr-${index}`)).toBe(true);
    }

    expect(claims.size()).toBe(3);
    // The oldest ids are the ones dropped, so the most recent are still guarded.
    expect(claims.claim("bbr-49")).toBe(false);
  });
});
