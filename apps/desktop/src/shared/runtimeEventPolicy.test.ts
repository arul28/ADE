import { describe, expect, it } from "vitest";

import {
  VOICE_RUNTIME_EVENT_CATEGORY,
  hidesVoiceEvent,
  refusesVoiceCategory,
  voiceCategoryRefusalMessage,
  withoutVoiceEvents,
} from "./runtimeEventPolicy";

/**
 * A voice call's state carries its running transcript, so draining one out of
 * the event buffer is the same disclosure as reading the CTO thread. Three
 * surfaces consult this module — the desktop runtime bridge and both RPC
 * servers — and the rule is only a rule if all three get the same two halves:
 * a named stream is REFUSED (the caller learns it was denied), an
 * uncategorised stream is FILTERED (every other category still arrives and the
 * cursor advances past what was withheld).
 */
describe("the cto_voice event visibility rule", () => {
  const batch = [
    { category: "chat", id: 1 },
    { category: VOICE_RUNTIME_EVENT_CATEGORY, id: 2 },
    { category: "lanes", id: 3 },
  ];

  it("refuses a named voice stream but filters an uncategorised drain", () => {
    expect(refusesVoiceCategory(VOICE_RUNTIME_EVENT_CATEGORY, false)).toBe(true);
    expect(refusesVoiceCategory(VOICE_RUNTIME_EVENT_CATEGORY, true)).toBe(false);
    // Only the voice category is ever refused by name.
    expect(refusesVoiceCategory("chat", false)).toBe(false);
    expect(refusesVoiceCategory(null, false)).toBe(false);
    expect(refusesVoiceCategory(undefined, false)).toBe(false);

    // Refusing the uncategorised drain instead would stall an innocent poller,
    // so it is filtered — and everything else still arrives.
    expect(withoutVoiceEvents(batch, false)).toEqual([
      { category: "chat", id: 1 },
      { category: "lanes", id: 3 },
    ]);
  });

  it("hands the CTO its own batch untouched, as the same array", () => {
    // Identity, not equality: this sits on the hot drain path of every poll,
    // and copying a large batch for the one caller allowed all of it buys
    // nothing.
    expect(withoutVoiceEvents(batch, true)).toBe(batch);
    expect(hidesVoiceEvent({ category: VOICE_RUNTIME_EVENT_CATEGORY }, true)).toBe(false);
    expect(hidesVoiceEvent({ category: VOICE_RUNTIME_EVENT_CATEGORY }, false)).toBe(true);
    expect(hidesVoiceEvent({ category: "chat" }, false)).toBe(false);
  });

  it("gives one denial one wording, naming the method that was refused", () => {
    const message = voiceCategoryRefusalMessage("runtime.events.subscribe");
    expect(message).toContain("runtime.events.subscribe");
    expect(message).toContain(VOICE_RUNTIME_EVENT_CATEGORY);
    expect(message).toContain("cto role");
    // Nothing about the call itself may travel in a refusal.
    expect(message).not.toMatch(/transcript|audio|session/i);
  });
});
