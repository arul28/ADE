import { describe, expect, it } from "vitest";

import { describeAttentionOpenFailure } from "./attentionOpenErrors";

/**
 * The contract this file defends: an Activity click-through that fails must
 * read as plain language naming the machine, never as the raw RPC string that
 * produced it. Seeing the item already proved the machine is on the account, so
 * the copy has to point at the real problem (asleep, offline, signed out) or
 * the user concludes ADE itself is broken.
 */
describe("describeAttentionOpenFailure", () => {
  it("reports an unreachable machine in the user's own terms", () => {
    for (const raw of [
      "connect ECONNREFUSED 127.0.0.1:8791",
      "connect EHOSTUNREACH 10.0.1.4:8791",
      "connect ENETUNREACH 10.0.1.4:8791",
      "Remote ADE service timed out waiting for method projects.list (15000ms).",
      "Remote ADE service connection closed.",
      "no route to host",
      "The machine is offline.",
    ]) {
      const failure = describeAttentionOpenFailure(new Error(raw), "connect", "Studio Mac");
      expect(failure.message).toBe(
        "Studio Mac is not reachable right now."
        + " Wake it or reconnect it to the network, then try again.",
      );
      // The diagnostic survives for the logs, but never for the dialog.
      expect(failure.message).not.toContain(raw);
      expect((failure.cause as Error).message).toBe(raw);
    }
  });

  it("keeps the unreachable reading no matter which stage failed", () => {
    // Which step of pair → connect → open ran is irrelevant once the machine is
    // demonstrably not answering; the recovery is the same either way.
    for (const stage of ["pair", "connect", "open"] as const) {
      expect(
        describeAttentionOpenFailure(new Error("ETIMEDOUT"), stage, "Studio Mac").message,
      ).toContain("is not reachable right now");
    }
  });

  it("does not read an RPC method named `sessions` as a signed-out account", () => {
    // Regression: `sessions.list` is a real remote method, and matching a bare
    // `session` sent the user to re-authenticate an account that was fine while
    // their machine was simply asleep.
    const failure = describeAttentionOpenFailure(
      new Error("Remote ADE service timed out waiting for method sessions.list (15000ms)."),
      "connect",
      "Studio Mac",
    );
    expect(failure.message).toContain("is not reachable right now");
    expect(failure.message).not.toContain("Sign in");
  });

  it("does not read an ephemeral port containing 401 as an auth failure", () => {
    // Regression: an unanchored `401` matched `127.0.0.1:52401`, so a refused
    // connection to a random high port was reported as a sign-in problem.
    for (const raw of [
      "Remote ADE service connection failed: connect ECONNREFUSED 127.0.0.1:52401",
      "connect ETIMEDOUT 10.0.1.4:8401",
    ]) {
      const failure = describeAttentionOpenFailure(new Error(raw), "connect", "Studio Mac");
      expect(failure.message).toContain("is not reachable right now");
    }
  });

  it("asks for a fresh sign-in only on a genuine auth failure", () => {
    for (const raw of [
      "Sign in to ADE to connect through ADE Relay.",
      "You are not signed in.",
      "Request failed with status 401 Unauthorized",
      "unauthenticated",
      "The session expired.",
      "invalid token",
    ]) {
      expect(
        describeAttentionOpenFailure(new Error(raw), "open", "Studio Mac").message,
      ).toBe("Sign in to ADE again, then open this item from Studio Mac.");
    }
  });

  it("prefers the auth reading when an auth failure also closed the connection", () => {
    // Relay rejects an unauthenticated socket by closing it, so both signals are
    // present; re-connecting a reachable machine would not help.
    expect(
      describeAttentionOpenFailure(
        new Error("Connection closed: 401 Unauthorized"),
        "connect",
        "Studio Mac",
      ).message,
    ).toContain("Sign in to ADE again");
  });

  it("names the failing step when the cause is neither offline nor auth", () => {
    const unknown = new Error("Pairing rejected by peer policy.");
    expect(describeAttentionOpenFailure(unknown, "pair", "Studio Mac").message).toBe(
      "ADE could not pair with Studio Mac. Open ADE on that machine, then try again.",
    );
    expect(describeAttentionOpenFailure(unknown, "connect", "Studio Mac").message).toBe(
      "ADE could not connect to Studio Mac. Make sure ADE is running there, then try again.",
    );
    expect(describeAttentionOpenFailure(unknown, "open", "Studio Mac").message).toBe(
      "ADE connected to Studio Mac but could not open this project.",
    );
  });

  it("falls back to a generic machine noun when the name is missing", () => {
    for (const name of [null, undefined, "", "   "]) {
      expect(
        describeAttentionOpenFailure(new Error("unreachable"), "connect", name).message,
      ).toBe(
        "The owning ADE machine is not reachable right now."
        + " Wake it or reconnect it to the network, then try again.",
      );
    }
  });

  it("survives a non-Error rejection", () => {
    // Runtime RPC rejections are not always Errors; the copy still has to work.
    expect(describeAttentionOpenFailure("ECONNREFUSED", "connect", "Studio Mac").message)
      .toContain("is not reachable right now");
    const empty = describeAttentionOpenFailure(undefined, "open", "Studio Mac");
    expect(empty.message).toBe("ADE connected to Studio Mac but could not open this project.");
    // Nothing to preserve, so no misleading cause is attached.
    expect(empty.cause).toBeUndefined();
  });
});
