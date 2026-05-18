import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModelPickerStore, MODEL_PICKER_MAX_RECENTS } from "./modelPickerStore";

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `ade-model-picker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
}

describe("modelPickerStore", () => {
  it("starts empty when the persistence file is missing", () => {
    const filePath = tempFile("missing.json");
    const store = createModelPickerStore({ filePath });
    expect(store.getFavorites()).toEqual([]);
    expect(store.getRecents()).toEqual([]);
  });

  it("toggleFavorite adds and removes entries and reports state", () => {
    const filePath = tempFile("toggle.json");
    const store = createModelPickerStore({ filePath });
    const first = store.toggleFavorite("claude-opus-4-7");
    expect(first).toEqual({ favorites: ["claude-opus-4-7"], isFavorite: true });
    const second = store.toggleFavorite("gpt-5");
    expect(second.favorites).toEqual(["claude-opus-4-7", "gpt-5"]);
    expect(second.isFavorite).toBe(true);
    const third = store.toggleFavorite("claude-opus-4-7");
    expect(third).toEqual({ favorites: ["gpt-5"], isFavorite: false });
  });

  it("setFavorites dedupes, trims, and persists", () => {
    const filePath = tempFile("set-favorites.json");
    const store = createModelPickerStore({ filePath });
    const result = store.setFavorites(["a", "a", "  b  ", "", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
    const reloaded = createModelPickerStore({ filePath });
    expect(reloaded.getFavorites()).toEqual(["a", "b", "c"]);
  });

  it("pushRecent prepends, dedupes, and caps at MAX_RECENTS", () => {
    const filePath = tempFile("recents.json");
    const store = createModelPickerStore({ filePath });
    for (let i = 0; i < MODEL_PICKER_MAX_RECENTS + 5; i += 1) {
      store.pushRecent(`model-${i}`);
    }
    const recents = store.getRecents();
    expect(recents).toHaveLength(MODEL_PICKER_MAX_RECENTS);
    expect(recents[0]).toBe(`model-${MODEL_PICKER_MAX_RECENTS + 4}`);
    // Re-pushing an existing entry should move it to head without growing the list.
    const before = store.getRecents();
    const head = before[before.length - 1];
    expect(head).toBeDefined();
    if (!head) throw new Error("unreachable");
    const moved = store.pushRecent(head);
    expect(moved[0]).toBe(head);
    expect(moved).toHaveLength(MODEL_PICKER_MAX_RECENTS);
    expect(new Set(moved).size).toBe(MODEL_PICKER_MAX_RECENTS);
  });

  it("ignores empty/whitespace modelId in toggleFavorite and pushRecent", () => {
    const filePath = tempFile("empty.json");
    const store = createModelPickerStore({ filePath });
    expect(store.toggleFavorite("")).toEqual({ favorites: [], isFavorite: false });
    expect(store.toggleFavorite("   ")).toEqual({ favorites: [], isFavorite: false });
    expect(store.pushRecent("")).toEqual([]);
  });

  it("tolerates a malformed persistence file", () => {
    const filePath = tempFile("malformed.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "this is not json", "utf8");
    const store = createModelPickerStore({ filePath });
    expect(store.getFavorites()).toEqual([]);
    expect(store.getRecents()).toEqual([]);
  });

  it("flushes pending recents so reload sees them", () => {
    const filePath = tempFile("flush.json");
    const store = createModelPickerStore({ filePath });
    store.pushRecent("alpha");
    store.flush();
    const reloaded = createModelPickerStore({ filePath });
    expect(reloaded.getRecents()).toEqual(["alpha"]);
  });
});
