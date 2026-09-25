import { describe, expect, it } from "vitest";
import {
  ACP_STDERR_TAIL_LIMIT,
  isSandboxUnsupportedFailureText,
  presentChatFailure,
  readChatErrorPresentation,
  sanitizeAcpStderrTail,
  summarizeAcpStderrTail,
} from "./chatErrorPresentation";

describe("presentChatFailure", () => {
  it("rewrites Cursor sandbox ConfigurationError into a human card", () => {
    const presented = presentChatFailure({
      message: "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
      errorCode: "ConfigurationError",
      provider: "Cursor",
    });
    expect(presented.title).toBe("Couldn't start this turn");
    expect(presented.body).toContain("can't use Cursor's sandbox");
    expect(presented.body.toLowerCase()).not.toContain("sandboxoptions");
    expect(presented.nextAction).toBe("Retry the turn.");
    expect(presented.technicalDetail).toContain("sandboxing is not supported");
  });

  it("never titles a generic failure Error or Unknown", () => {
    const presented = presentChatFailure({
      kind: "unknown",
      message: "Error (Unknown in 0 seconds)",
    });
    expect(presented.title.toLowerCase()).not.toContain("error");
    expect(presented.title.toLowerCase()).not.toContain("unknown");
    expect(presented.body.toLowerCase()).not.toBe("error");
  });

  // The card is reached from every provider's failure path, so no unnamed or
  // non-Cursor failure may claim Cursor stopped the turn.
  it("never names Cursor in a non-Cursor provider's card", () => {
    const droidUnknown = presentChatFailure({
      kind: "unknown",
      message: "Error",
      provider: "Factory Droid",
    });
    expect(droidUnknown.body).toBe("Factory Droid stopped this turn before it could finish.");

    const droidNetwork = presentChatFailure({
      kind: "network",
      message: "unknown",
      provider: "Factory Droid",
    });
    expect(droidNetwork.body).toBe("The connection to Factory Droid dropped mid-run.");

    const droidBusy = presentChatFailure({ kind: "busy", provider: "Factory Droid" });
    expect(droidBusy.title).toBe("Factory Droid is already working");

    // A Codex seatbelt/landlock failure trips the same sandbox text match.
    const codexSandbox = presentChatFailure({
      message: "seatbelt sandboxing was requested, but sandboxing is not supported in this environment.",
      provider: "Codex",
    });
    expect(codexSandbox.body).toBe("This ADE runtime can't provide the sandbox Codex asked for.");
    expect(codexSandbox.technicalDetail).toContain("seatbelt sandboxing was requested");

    for (const presented of [droidUnknown, droidNetwork, droidBusy, codexSandbox]) {
      expect(`${presented.title} ${presented.body} ${presented.nextAction ?? ""}`.toLowerCase())
        .not.toContain("cursor");
    }
  });

  it("stays provider-neutral when no provider is known", () => {
    expect(presentChatFailure({ kind: "unknown", message: "Error" }).body)
      .toBe("This turn stopped before it could finish.");
    expect(presentChatFailure({ kind: "network", message: "Error" }).body)
      .toBe("The connection dropped mid-run.");
    expect(presentChatFailure({ kind: "busy" }).title).toBe("This chat is already working");
    expect(presentChatFailure({ kind: "configuration", message: "sandboxing is not supported" }).body)
      .toBe("This ADE runtime can't provide the sandbox this agent asked for.");
  });

  // Each field is matched on its own. Joined, a "Sandbox" word in `message`
  // paired with an unrelated "not supported" in `detail` and served Cursor
  // sandbox guidance for a failure that had nothing to do with the sandbox.
  it("does not read a sandbox failure out of two unrelated fields", () => {
    expect(isSandboxUnsupportedFailureText("Sandbox startup failed", "Model not supported"))
      .toBe(false);
    const presented = presentChatFailure({
      kind: "network",
      message: "Sandbox startup failed",
      detail: "Model not supported",
      provider: "Cursor",
    });
    expect(presented.title).toBe("Connection issue");
    // The real message survives instead of being discarded for sandbox copy.
    expect(presented.body).toBe("Sandbox startup failed");
    expect(presented.body).not.toContain("can't use Cursor's sandbox");

    // A match inside one field is still a match.
    expect(isSandboxUnsupportedFailureText(null, "sandboxing is not supported in this environment"))
      .toBe(true);
  });

  it("normalizes a provider key into its display label", () => {
    expect(presentChatFailure({ kind: "unknown", message: "Error", provider: "droid" }).body)
      .toBe("Droid stopped this turn before it could finish.");
  });

  it("keeps rate-limit copy without duplicating the body as technical-only text", () => {
    const presented = presentChatFailure({
      kind: "rate_limit",
      message: "Cursor rate limited this request.",
      detail: "rate_limited",
    });
    expect(presented.title).toBe("Usage limit reached");
    expect(presented.body).toBe("Cursor rate limited this request.");
    expect(presented.technicalDetail).toBe("rate_limited");
  });
});

describe("summarizeAcpStderrTail", () => {
  it("returns nothing for empty or noise-only tails", () => {
    expect(summarizeAcpStderrTail("")).toEqual({ headline: null, technicalDetail: null });
    expect(summarizeAcpStderrTail(null)).toEqual({ headline: null, technicalDetail: null });
    expect(summarizeAcpStderrTail("   \n\n")).toEqual({ headline: null, technicalDetail: null });
    expect(summarizeAcpStderrTail("----------\n==========").headline).toBeNull();
  });

  it("headlines the error line and skips the stack frames under it", () => {
    const tail = [
      "Error: Cannot find module 'foo'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1234)",
      "    at Module._load (node:internal/modules/cjs/loader:567)",
    ].join("\n");
    const summary = summarizeAcpStderrTail(tail);
    expect(summary.headline).toBe("Error: Cannot find module 'foo'");
    // The full tail stays available for Copy, frames included.
    expect(summary.technicalDetail).toContain("at Module._resolveFilename");
  });

  it("strips ANSI escapes and normalizes CRLF before showing text", () => {
    const tail = "\u001b[31munknown model 'gpt-x'\u001b[0m\r\ntry again\r\n";
    const summary = summarizeAcpStderrTail(tail);
    expect(summary.headline).toContain("try again");
    expect(summary.headline).toContain("unknown model 'gpt-x'");
    expect(summary.technicalDetail).not.toContain("\u001b");
    expect(summary.technicalDetail).not.toContain("\r");
  });

  it("redacts token-shaped values so the copy button cannot leak a credential", () => {
    // Assembled at runtime on purpose: a literal here would be a
    // secret-shaped string in source and would trip the CI secret scanner,
    // while the assembled value still exercises each redaction rule.
    const syntheticJwt = [
      "eyJ" + "hbGciOiJIUzI1NiJ9",
      "eyJ" + "zdWIiOiIxIn0",
      "abcdefghij",
    ].join(".");
    const tail = [
      "config error: unknown model",
      "sk-" + "liveFixture000",
      "api_key: placeholder",
      "Authorization: Bearer " + syntheticJwt,
      "failed to start",
    ].join("\n");
    const summary = summarizeAcpStderrTail(tail);
    const shown = summary.technicalDetail ?? "";
    expect(summary.headline).toContain("failed to start");
    expect(shown).not.toContain(syntheticJwt);
    expect(shown).not.toContain("liveFixture000");
    expect(shown).not.toContain("placeholder");
    expect(shown).toContain("[redacted]");
    expect(shown).toContain("failed to start");
  });

  it("bounds a very long line and the whole tail", () => {
    const longLine = `error: ${"x".repeat(5_000)}`;
    const bounded = sanitizeAcpStderrTail(longLine);
    expect(bounded.length).toBeLessThanOrEqual(ACP_STDERR_TAIL_LIMIT);
    const headline = summarizeAcpStderrTail(longLine).headline ?? "";
    expect(headline.length).toBeLessThanOrEqual(401);
    expect(headline.endsWith("…")).toBe(true);
  });

  it("stays inside the cap even when redaction replaces many short tokens", () => {
    // Redacting `token=a` to `token=[redacted]` can grow the text, so the cap
    // must be re-applied after redaction, not only before it.
    const tail = "token=a ".repeat(2_000);
    const cleaned = sanitizeAcpStderrTail(tail);
    expect(cleaned.length).toBeLessThanOrEqual(ACP_STDERR_TAIL_LIMIT);
    expect(cleaned).toContain("[redacted]");
  });

  it("keeps the newest bytes when the tail exceeds the capture cap", () => {
    const tail = `oldest-line\n${"y".repeat(5_000)}\nnewest-line`;
    const cleaned = sanitizeAcpStderrTail(tail);
    expect(cleaned).toContain("newest-line");
    expect(cleaned).not.toContain("oldest-line");
  });
});

describe("presentChatFailure with an ACP stderr tail", () => {
  const tail = [
    "cursor-agent: error: unknown model 'gpt-x'",
    "supported models: auto, sonnet",
  ].join("\n");

  it("leads with the last meaningful stderr line and keeps the tail behind Copy", () => {
    const presented = presentChatFailure({
      kind: "unknown",
      message: "ACP connection closed: cursor exited (code 1, signal none)",
      provider: "cursor",
      stderrTail: tail,
    });
    expect(presented.body).toContain("unknown model 'gpt-x'");
    expect(presented.body).toContain("supported models: auto, sonnet");
    expect(presented.body).not.toContain("ACP connection closed");
    expect(presented.technicalDetail).toContain("cursor-agent: error: unknown model");
    expect(presented.technicalDetail).toContain("supported models: auto, sonnet");
  });

  it("falls back to the existing generic copy when the tail is empty", () => {
    const presented = presentChatFailure({
      kind: "unknown",
      message: "ACP connection closed: cursor exited (code 1, signal none)",
      provider: "cursor",
      stderrTail: "   ",
    });
    expect(presented.body).toContain("ACP connection closed");
    expect(presented.technicalDetail).toBeUndefined();
  });
});

describe("readChatErrorPresentation", () => {
  it("reads a host-emitted presentation object", () => {
    expect(readChatErrorPresentation({
      category: "unknown",
      presentation: {
        title: "Couldn't start this turn",
        body: "Cursor stopped this turn before it could finish.",
        nextAction: "Retry, or switch model.",
        technicalDetail: "agent.send failed",
      },
    })).toEqual({
      title: "Couldn't start this turn",
      body: "Cursor stopped this turn before it could finish.",
      nextAction: "Retry, or switch model.",
      technicalDetail: "agent.send failed",
    });
  });

  it("returns null when presentation is missing", () => {
    expect(readChatErrorPresentation({ category: "unknown" })).toBeNull();
  });
});
