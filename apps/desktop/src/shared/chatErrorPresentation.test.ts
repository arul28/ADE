import { describe, expect, it } from "vitest";
import {
  presentChatFailure,
  readChatErrorPresentation,
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
