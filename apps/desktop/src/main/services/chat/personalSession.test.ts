import { describe, expect, it } from "vitest";

import { PERSONAL_CHAT_SYSTEM_PROMPT, adeSkillCatalogFor, resolvePersonalSystemPrompt } from "./personalSession";

describe("resolvePersonalSystemPrompt", () => {
  // `append` puts the trimmed host text after ADE's; `replace` uses it alone,
  // because a host-branded assistant must not be told it is in "an ADE personal
  // chat". Empty host text (an older persisted record, or a caller that reached
  // the session object directly) must never produce an empty prompt.
  it.each([
    ["no instructions", {}, PERSONAL_CHAT_SYSTEM_PROMPT],
    ["undefined instructions", { instructions: undefined }, PERSONAL_CHAT_SYSTEM_PROMPT],
    ["append", { instructions: { mode: "append" as const, text: "  x  " } }, `${PERSONAL_CHAT_SYSTEM_PROMPT}\n\nx`],
    ["replace", { instructions: { mode: "replace" as const, text: "  x  " } }, "x"],
    ["empty append", { instructions: { mode: "append" as const, text: "" } }, PERSONAL_CHAT_SYSTEM_PROMPT],
    ["empty replace", { instructions: { mode: "replace" as const, text: "" } }, PERSONAL_CHAT_SYSTEM_PROMPT],
    ["whitespace replace", { instructions: { mode: "replace" as const, text: "  \n " } }, PERSONAL_CHAT_SYSTEM_PROMPT],
  ])("resolves %s", (_label, session, expected) => {
    expect(resolvePersonalSystemPrompt(session)).toBe(expected);
  });
});

describe("adeSkillCatalogFor", () => {
  // Only an explicit `assistant` personal chat gets the reduced catalog; an
  // absent or unknown profile is an SDK host's chat and keeps getting none.
  it.each([
    [{ surface: "work" as const }, "full"],
    [{ surface: "work" as const, personalProfile: "assistant" as const }, "full"],
    [{ surface: "personal" as const, personalProfile: "assistant" as const }, "assistant"],
    [{ surface: "personal" as const, personalProfile: "embedded" as const }, "none"],
    [{ surface: "personal" as const }, "none"],
  ])("gives %j the %s catalog", (session, expected) => {
    expect(adeSkillCatalogFor(session)).toBe(expected);
  });
});
