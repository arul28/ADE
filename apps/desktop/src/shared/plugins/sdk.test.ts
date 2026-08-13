import { describe, expect, it } from "vitest";

import {
  hasPluginActionComposerRequest,
  isPluginCollectionIfFull,
  PLUGIN_COLLECTION_IF_FULL_MODES,
  PLUGIN_COMPOSER_TEXT_MAX_BYTES,
  pluginCollectionPutParams,
  readPluginActionComposerEdit,
} from "./sdk";

describe("collections.put wire shape", () => {
  it("puts nothing extra on the wire when no option was named", () => {
    // Byte-for-byte what a plugin written before `ifFull` existed sends, so a
    // newer plugin talking to an older host is indistinguishable from an old one.
    expect(JSON.stringify(pluginCollectionPutParams("cache", "a", { n: 1 })))
      .toBe(JSON.stringify({ collection: "cache", key: "a", value: { n: 1 } }));
    expect(JSON.stringify(pluginCollectionPutParams("cache", "a", { n: 1 }, {})))
      .toBe(JSON.stringify({ collection: "cache", key: "a", value: { n: 1 } }));
  });

  it("carries the option in its own frame when one was named", () => {
    expect(pluginCollectionPutParams("cache", "a", 1, { ifFull: "evictOldest" }))
      .toEqual({ collection: "cache", key: "a", value: 1, options: { ifFull: "evictOldest" } });
  });

  it("accepts exactly the declared modes", () => {
    for (const mode of PLUGIN_COLLECTION_IF_FULL_MODES) expect(isPluginCollectionIfFull(mode)).toBe(true);
    for (const value of ["evictoldest", "evict", "", null, undefined, 1, {}]) {
      expect(isPluginCollectionIfFull(value)).toBe(false);
    }
  });
});

describe("composer edits in an action response", () => {
  it("reads both verbs", () => {
    expect(readPluginActionComposerEdit({ composer: { insertText: "TODO: " } }))
      .toEqual({ mode: "insert", text: "TODO: " });
    expect(readPluginActionComposerEdit({ composer: { replaceText: "Rewrite the whole prompt." } }))
      .toEqual({ mode: "replace", text: "Rewrite the whole prompt." });
  });

  // "Replace, then insert into the replacement" is not what either verb means.
  it("takes the more total verb when a plugin sends both", () => {
    expect(readPluginActionComposerEdit({ composer: { insertText: "a", replaceText: "b" } }))
      .toEqual({ mode: "replace", text: "b" });
  });

  it("lets replace clear the draft but treats an empty insert as nothing to do", () => {
    expect(readPluginActionComposerEdit({ composer: { replaceText: "" } }))
      .toEqual({ mode: "replace", text: "" });
    expect(readPluginActionComposerEdit({ composer: { insertText: "" } })).toBeNull();
  });

  // Most action results carry no composer verb at all, so anything
  // unrecognizable is an absence rather than an error.
  it("is null for a result that says nothing about the composer", () => {
    for (const result of [null, undefined, 42, "text", {}, { composer: null }, { composer: "x" }]) {
      expect(readPluginActionComposerEdit(result)).toBeNull();
    }
  });

  it("drops rather than truncates text over the ceiling", () => {
    const tooLong = "x".repeat(PLUGIN_COMPOSER_TEXT_MAX_BYTES + 1);
    expect(readPluginActionComposerEdit({ composer: { insertText: tooLong } })).toBeNull();
    expect(readPluginActionComposerEdit({ composer: { replaceText: tooLong } })).toBeNull();
    // Measured in UTF-8 bytes, not characters: a multi-byte draft that fits as
    // a string can still be over the wire ceiling.
    const multibyte = "é".repeat(PLUGIN_COMPOSER_TEXT_MAX_BYTES / 2 + 1);
    expect(readPluginActionComposerEdit({ composer: { insertText: multibyte } })).toBeNull();
  });

  // A refusal and a silence look identical to the reader, and only the first is
  // worth telling the person wondering why the button did nothing.
  it("separates asking-and-being-refused from never asking", () => {
    expect(hasPluginActionComposerRequest({ composer: { insertText: "" } })).toBe(true);
    expect(hasPluginActionComposerRequest({ ok: true })).toBe(false);
    expect(hasPluginActionComposerRequest(null)).toBe(false);
  });
});
