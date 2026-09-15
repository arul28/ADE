import { describe, expect, it } from "vitest";

import {
  buildComposerClipboardPayload,
  parseComposerClipboard,
  serializeComposerClipboard,
} from "./composerClipboard";

describe("buildComposerClipboardPayload", () => {
  it("carries only labels whose token is actually in the text", () => {
    const payload = buildComposerClipboardPayload(
      "ping @chat:abc",
      new Map([["@chat:abc", "Lane B"], ["@lane:zzz", "Stale lane"]]),
    );
    expect(payload.chips).toEqual([{ token: "@chat:abc", label: "Lane B" }]);
  });
});

describe("parseComposerClipboard", () => {
  it("round-trips a payload", () => {
    const payload = buildComposerClipboardPayload("see @chat:abc", new Map([["@chat:abc", "Lane B"]]));
    const parsed = parseComposerClipboard(serializeComposerClipboard(payload));
    expect(parsed).toEqual({ version: 1, text: "see @chat:abc", chips: [{ token: "@chat:abc", label: "Lane B" }] });
  });

  it("returns null for clipboard content that is not an ADE payload", () => {
    expect(parseComposerClipboard("just some copied text")).toBeNull();
    expect(parseComposerClipboard("")).toBeNull();
    expect(parseComposerClipboard(null)).toBeNull();
    expect(parseComposerClipboard(JSON.stringify({ version: 99, text: "x", chips: [] }))).toBeNull();
  });

  it("drops a label whose token does not appear in the pasted text", () => {
    const parsed = parseComposerClipboard(JSON.stringify({
      version: 1,
      text: "hello",
      chips: [{ token: "@chat:abc", label: "Injected" }],
    }));
    expect(parsed?.chips).toEqual([]);
  });

  it("keeps the text when the chip list is malformed, because plain text must never be lost", () => {
    const parsed = parseComposerClipboard(JSON.stringify({ version: 1, text: "@chat:abc", chips: "nope" }));
    expect(parsed?.text).toBe("@chat:abc");
    expect(parsed?.chips).toEqual([]);
  });
});
