import { describe, expect, it } from "vitest";

import { PERSONAL_CHAT_SYSTEM_PROMPT, resolvePersonalSystemPrompt } from "./personalSession";

describe("resolvePersonalSystemPrompt", () => {
  it("returns the constant unchanged when the host asked for nothing", () => {
    expect(resolvePersonalSystemPrompt({})).toBe(PERSONAL_CHAT_SYSTEM_PROMPT);
    expect(resolvePersonalSystemPrompt({ instructions: undefined })).toBe(PERSONAL_CHAT_SYSTEM_PROMPT);
  });

  it("puts the host text after ADE's for append", () => {
    const prompt = resolvePersonalSystemPrompt({
      instructions: { mode: "append", text: "You are the Halyard assistant." },
    });
    expect(prompt.startsWith(PERSONAL_CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith("You are the Halyard assistant.")).toBe(true);
  });

  // The whole point of replace: a host-branded assistant must not be told it
  // is in "an ADE personal chat", because it will eventually say so.
  it("uses the host text alone for replace", () => {
    const prompt = resolvePersonalSystemPrompt({
      instructions: { mode: "replace", text: "You are the Halyard assistant." },
    });
    expect(prompt).toBe("You are the Halyard assistant.");
    expect(prompt).not.toContain("ADE personal chat");
  });

  it("trims host text on both modes", () => {
    expect(resolvePersonalSystemPrompt({ instructions: { mode: "replace", text: "  x  " } }))
      .toBe("x");
    expect(resolvePersonalSystemPrompt({ instructions: { mode: "append", text: "  x  " } }))
      .toBe(`${PERSONAL_CHAT_SYSTEM_PROMPT}\n\nx`);
  });

  // A persisted record from an older build, or a caller that reached the
  // session object directly, must not be able to produce an empty prompt.
  it.each([
    ["empty append", { mode: "append" as const, text: "" }],
    ["empty replace", { mode: "replace" as const, text: "" }],
    ["whitespace replace", { mode: "replace" as const, text: "  \n " }],
  ])("falls back to the constant for %s", (_label, instructions) => {
    expect(resolvePersonalSystemPrompt({ instructions })).toBe(PERSONAL_CHAT_SYSTEM_PROMPT);
  });
});
