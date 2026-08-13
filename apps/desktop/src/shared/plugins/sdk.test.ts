import { describe, expect, it } from "vitest";

import {
  isPluginCollectionIfFull,
  PLUGIN_COLLECTION_IF_FULL_MODES,
  pluginCollectionPutParams,
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
