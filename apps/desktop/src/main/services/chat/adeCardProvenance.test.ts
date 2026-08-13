import { describe, expect, it } from "vitest";

import {
  readTrustedAdeCardAuthor,
  withTrustedAdeCardAuthor,
} from "./adeCardProvenance";

describe("adeCardProvenance", () => {
  it("reads back only what a trusted bridge stamped", () => {
    const args = { sessionId: "chat-1", card: { cardId: "c1" } };
    const stamped = withTrustedAdeCardAuthor(args, { pluginId: "ade-lint", displayName: "Lint" });

    expect(readTrustedAdeCardAuthor(stamped)).toEqual({ pluginId: "ade-lint", displayName: "Lint" });
    // The caller's object is untouched: the allowlist check and the log line
    // both ran against it before this.
    expect(readTrustedAdeCardAuthor(args)).toBeNull();
  });

  it("cannot be forged by a caller that only speaks JSON", () => {
    // Every untrusted caller — an agent through `run_ade_action`, an automation
    // step, a plugin child over its socket — hands the host a parsed JSON
    // object. This is the property that makes the stamp unspoofable, so it is
    // asserted rather than assumed.
    const forged = JSON.parse(JSON.stringify({
      sessionId: "chat-1",
      authoredBy: { pluginId: "ade-linear" },
      "@@trusted": { pluginId: "ade-linear" },
    }));
    expect(readTrustedAdeCardAuthor(forged)).toBeNull();

    const stamped = withTrustedAdeCardAuthor({ sessionId: "chat-1" }, { pluginId: "ade-lint" });
    expect(readTrustedAdeCardAuthor(JSON.parse(JSON.stringify(stamped)))).toBeNull();
  });

  it("does not leak into anything that enumerates or serializes the args", () => {
    const stamped = withTrustedAdeCardAuthor({ sessionId: "chat-1" }, { pluginId: "ade-lint" });
    expect(Object.keys(stamped)).toEqual(["sessionId"]);
    expect(JSON.stringify(stamped)).toBe(JSON.stringify({ sessionId: "chat-1" }));
  });

  it("refuses an author with no id rather than stamping a blank attribution", () => {
    const args = { sessionId: "chat-1" };
    expect(withTrustedAdeCardAuthor(args, { pluginId: "   " })).toBe(args);
    expect(readTrustedAdeCardAuthor(withTrustedAdeCardAuthor(args, { pluginId: "   " }))).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(readTrustedAdeCardAuthor(null)).toBeNull();
    expect(readTrustedAdeCardAuthor("ade-lint")).toBeNull();
  });
});
