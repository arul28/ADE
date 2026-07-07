import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../desktop/src/main/services/state/kvDb";
import { createModelPickerStore, MODEL_PICKER_MAX_RECENTS } from "./modelPickerStore";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("modelPickerStore (db-backed)", () => {
  const cleanupRoots: string[] = [];
  const openDbs: AdeDb[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const db of openDbs.splice(0)) {
      try {
        db.close();
      } catch {
        // best-effort teardown
      }
    }
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  async function makeDb(): Promise<{ db: AdeDb; root: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-model-picker-db-"));
    cleanupRoots.push(root);
    const db = await openKvDb(path.join(root, ".ade", "ade.db"), createLogger() as any);
    openDbs.push(db);
    return { db, root };
  }

  // Point migration at a guaranteed-missing path so the real
  // ~/.ade/modelPicker.json never bleeds into these specs.
  function noMigration(root: string): string {
    return path.join(root, "no-such-legacy.json");
  }

  it("starts empty on a fresh db", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    expect(store.getFavorites()).toEqual([]);
    expect(store.getRecents()).toEqual([]);
  });

  it("toggleFavorite adds and removes entries and reports state", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });

    const first = store.toggleFavorite("claude-opus-4-8");
    expect(first).toEqual({ favorites: ["claude-opus-4-8"], isFavorite: true });

    const second = store.toggleFavorite("gpt-5");
    expect(second.favorites).toEqual(["claude-opus-4-8", "gpt-5"]);
    expect(second.isFavorite).toBe(true);

    const third = store.toggleFavorite("claude-opus-4-8");
    expect(third).toEqual({ favorites: ["gpt-5"], isFavorite: false });
  });

  it("setFavorites reconciles to the desired set (adds, drops, dedupes, trims)", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });

    expect(store.setFavorites(["a", "a", "  b  ", "", "c"])).toEqual(["a", "b", "c"]);
    // Existing rows are restamped so setFavorites is also a reorder API.
    expect(store.setFavorites(["c", "a", "b"])).toEqual(["c", "a", "b"]);
    // Drop "a", keep "b", add "d".
    expect(store.setFavorites(["b", "d"])).toEqual(["b", "d"]);
    // Clearing removes everything.
    expect(store.setFavorites([])).toEqual([]);
  });

  it("favorites persist across store re-creation on the same db", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    store.setFavorites(["a", "b", "c"]);

    const reopened = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    expect(reopened.getFavorites()).toEqual(["a", "b", "c"]);
  });

  it("pushRecent caps at MAX_RECENTS and orders by recency", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });

    for (let i = 0; i < MODEL_PICKER_MAX_RECENTS + 5; i += 1) {
      store.pushRecent(`model-${i}`);
    }
    const recents = store.getRecents();
    expect(recents).toHaveLength(MODEL_PICKER_MAX_RECENTS);
    // Newest push is first; the oldest 5 were pruned off the tail.
    expect(recents[0]).toBe(`model-${MODEL_PICKER_MAX_RECENTS + 4}`);
    expect(recents).not.toContain("model-0");

    // Re-pushing an existing entry moves it to the head without growing the list.
    const tail = recents[recents.length - 1];
    expect(tail).toBeDefined();
    if (!tail) throw new Error("unreachable");
    const moved = store.pushRecent(tail);
    expect(moved[0]).toBe(tail);
    expect(moved).toHaveLength(MODEL_PICKER_MAX_RECENTS);
    expect(new Set(moved).size).toBe(MODEL_PICKER_MAX_RECENTS);
  });

  it("preserves recency when multiple models are pushed in the same millisecond", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T23:30:00.000Z"));

    store.pushRecent("z-model");
    expect(store.pushRecent("a-model")).toEqual(["a-model", "z-model"]);
  });

  it("ignores empty/whitespace modelId for toggleFavorite and pushRecent", async () => {
    const { db, root } = await makeDb();
    const store = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    expect(store.toggleFavorite("")).toEqual({ favorites: [], isFavorite: false });
    expect(store.toggleFavorite("   ")).toEqual({ favorites: [], isFavorite: false });
    expect(store.pushRecent("")).toEqual([]);
  });

  it("imports the legacy modelPicker.json only once, even if imported rows are later cleared", async () => {
    const { db, root } = await makeDb();
    const legacyFilePath = path.join(root, "modelPicker.json");
    fs.writeFileSync(
      legacyFilePath,
      JSON.stringify({
        version: 1,
        favorites: ["fav-a", "fav-b"],
        // Newest-first, as the legacy file stored them.
        recents: ["recent-1", "recent-2", "recent-3"],
      }),
      "utf8",
    );

    const store = createModelPickerStore({ db, legacyFilePath });
    expect(store.getFavorites()).toEqual(["fav-a", "fav-b"]);
    expect(store.getRecents()).toEqual(["recent-1", "recent-2", "recent-3"]);

    // Clear every imported row, then re-open: the durable migration marker must
    // prevent stale JSON state from being resurrected just because tables are
    // empty again.
    store.setFavorites([]);
    for (const recent of store.getRecents()) {
      db.run("delete from model_picker_recents where model_id = ?", [recent]);
    }
    const reopened = createModelPickerStore({ db, legacyFilePath });
    expect(reopened.getFavorites()).toEqual([]);
    expect(reopened.getRecents()).toEqual([]);
  });

  it("does not import the legacy file when the db already has data", async () => {
    const { db, root } = await makeDb();
    const seed = createModelPickerStore({ db, legacyFilePath: noMigration(root) });
    seed.setFavorites(["existing"]);

    const legacyFilePath = path.join(root, "modelPicker.json");
    fs.writeFileSync(
      legacyFilePath,
      JSON.stringify({ version: 1, favorites: ["imported"], recents: ["imported-recent"] }),
      "utf8",
    );

    const store = createModelPickerStore({ db, legacyFilePath });
    expect(store.getFavorites()).toEqual(["existing"]);
    expect(store.getRecents()).toEqual([]);
  });
});
