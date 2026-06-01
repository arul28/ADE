import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdeDb } from "../../../desktop/src/main/services/state/kvDb";

const MAX_RECENTS = 10;
const LEGACY_IMPORT_MARKER_KEY = "model-picker:legacy-import:v1";

export type ModelPickerStore = {
  getFavorites: () => string[];
  setFavorites: (favorites: string[]) => string[];
  toggleFavorite: (modelId: string) => { favorites: string[]; isFavorite: boolean };
  getRecents: () => string[];
  pushRecent: (modelId: string) => string[];
  /** No-op retained for API compatibility (DB writes are synchronous). */
  flush: () => void;
};

export type CreateModelPickerStoreOptions = {
  db: AdeDb;
  /**
   * Path to the legacy `~/.ade/modelPicker.json` file imported once on first
   * DB-backed init when the DB tables are still empty. Defaults to the real
   * per-user file; tests can point this at a fixture (or a missing path to
   * disable migration).
   */
  legacyFilePath?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

let stampSequence = 0;

function indexedStamp(base: string, index: number): string {
  return `${base}#${String(index).padStart(4, "0")}`;
}

function sequencedNowStamp(): string {
  stampSequence = (stampSequence + 1) % 1_000_000;
  return `${nowIso()}#${String(stampSequence).padStart(6, "0")}`;
}

function defaultLegacyFilePath(): string {
  return path.join(os.homedir(), ".ade", "modelPicker.json");
}

function sanitizeIdList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeId(modelId: unknown): string {
  return typeof modelId === "string" ? modelId.trim() : "";
}

type LegacyShape = { favorites: string[]; recents: string[] };

function readLegacyFile(filePath: string): LegacyShape {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { favorites: [], recents: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      favorites: sanitizeIdList(record.favorites),
      recents: sanitizeIdList(record.recents).slice(0, MAX_RECENTS),
    };
  } catch {
    return { favorites: [], recents: [] };
  }
}

function readFavoritesFromDb(db: AdeDb): string[] {
  // Favorites have no intrinsic order in the schema; created_at gives a stable,
  // insertion-ordered read so the UI list doesn't reshuffle between calls.
  const rows = db.all<{ model_id: string }>(
    "select model_id from model_picker_favorites order by created_at asc, model_id asc",
  );
  return sanitizeIdList(rows.map((row) => row.model_id));
}

function readRecentsFromDb(db: AdeDb): string[] {
  const rows = db.all<{ model_id: string }>(
    "select model_id from model_picker_recents order by used_at desc, model_id asc limit ?",
    [MAX_RECENTS],
  );
  return sanitizeIdList(rows.map((row) => row.model_id));
}

/**
 * One-time best-effort import of the legacy `~/.ade/modelPicker.json` into the
 * per-project DB. A durable kv marker records the attempted import, so clearing
 * every favorite/recent later does not resurrect stale JSON state on next boot.
 * Never throws into the caller — favorites/recents are convenience state, not
 * load-bearing.
 */
function migrateLegacyFileIfNeeded(db: AdeDb, legacyFilePath: string): void {
  try {
    if (db.getJson<{ importedAt: string }>(LEGACY_IMPORT_MARKER_KEY)) return;
    const favCount = db.get<{ count: number }>(
      "select count(1) as count from model_picker_favorites",
    );
    const recentCount = db.get<{ count: number }>(
      "select count(1) as count from model_picker_recents",
    );
    if (Number(favCount?.count ?? 0) > 0 || Number(recentCount?.count ?? 0) > 0) {
      db.setJson(LEGACY_IMPORT_MARKER_KEY, { importedAt: nowIso(), skipped: "existing-db-state" });
      return;
    }
    if (!fs.existsSync(legacyFilePath)) {
      db.setJson(LEGACY_IMPORT_MARKER_KEY, { importedAt: nowIso(), skipped: "missing-file" });
      return;
    }

    const legacy = readLegacyFile(legacyFilePath);
    if (legacy.favorites.length === 0 && legacy.recents.length === 0) {
      db.setJson(LEGACY_IMPORT_MARKER_KEY, { importedAt: nowIso(), skipped: "empty-or-invalid-file" });
      return;
    }

    const base = nowIso();
    db.run("begin");
    try {
      legacy.favorites.forEach((id, index) => {
        // Stagger created_at by index so the imported order is preserved by the
        // `order by created_at` read above without colliding on identical stamps.
        const createdAt = indexedStamp(base, index);
        db.run(
          "insert into model_picker_favorites (model_id, created_at) values (?, ?) on conflict(model_id) do nothing",
          [id, createdAt],
        );
      });
      // Legacy recents are newest-first; map index to descending used_at so the
      // DB read (order by used_at desc) reproduces the original ordering.
      legacy.recents.forEach((id, index) => {
        const usedAt = indexedStamp(base, legacy.recents.length - index);
        db.run(
          "insert into model_picker_recents (model_id, used_at) values (?, ?) on conflict(model_id) do update set used_at = excluded.used_at",
          [id, usedAt],
        );
      });
      db.setJson(LEGACY_IMPORT_MARKER_KEY, { importedAt: nowIso(), favorites: legacy.favorites.length, recents: legacy.recents.length });
      db.run("commit");
    } catch (error) {
      db.run("rollback");
      throw error;
    }
  } catch {
    // best-effort migration — leave the file alone and continue.
  }
}

function pruneRecents(db: AdeDb): void {
  // Keep only the newest MAX_RECENTS rows; delete the older tail. PK-only table
  // (no UNIQUE index beyond model_id) keeps it CRR-eligible, so the cap is
  // enforced here in app code rather than via a constraint.
  db.run(
    `delete from model_picker_recents
       where model_id not in (
         select model_id from model_picker_recents
         order by used_at desc, model_id asc
         limit ?
       )`,
    [MAX_RECENTS],
  );
}

export function createModelPickerStore(options: CreateModelPickerStoreOptions): ModelPickerStore {
  const { db } = options;
  const legacyFilePath = options.legacyFilePath ?? defaultLegacyFilePath();
  migrateLegacyFileIfNeeded(db, legacyFilePath);

  return {
    getFavorites: () => readFavoritesFromDb(db),
    setFavorites: (favorites) => {
      const desired = sanitizeIdList(favorites);
      const desiredSet = new Set(desired);
      const existing = new Set(readFavoritesFromDb(db));
      // Reconcile to the desired set: delete dropped and restamp every desired
      // row so the caller's order is preserved even for existing favorites.
      db.run("begin");
      try {
        for (const id of existing) {
          if (!desiredSet.has(id)) {
            db.run("delete from model_picker_favorites where model_id = ?", [id]);
          }
        }
        const base = nowIso();
        desired.forEach((id, index) => {
          const createdAt = indexedStamp(base, index);
          db.run(
            "insert into model_picker_favorites (model_id, created_at) values (?, ?) on conflict(model_id) do update set created_at = excluded.created_at",
            [id, createdAt],
          );
        });
        db.run("commit");
      } catch (error) {
        db.run("rollback");
        throw error;
      }
      return readFavoritesFromDb(db);
    },
    toggleFavorite: (modelId) => {
      const id = normalizeId(modelId);
      if (!id) return { favorites: readFavoritesFromDb(db), isFavorite: false };
      const present = db.get<{ present: number }>(
        "select 1 as present from model_picker_favorites where model_id = ? limit 1",
        [id],
      );
      let isFavorite: boolean;
      if (present) {
        db.run("delete from model_picker_favorites where model_id = ?", [id]);
        isFavorite = false;
      } else {
        db.run(
          "insert into model_picker_favorites (model_id, created_at) values (?, ?) on conflict(model_id) do nothing",
          [id, sequencedNowStamp()],
        );
        isFavorite = true;
      }
      return { favorites: readFavoritesFromDb(db), isFavorite };
    },
    getRecents: () => readRecentsFromDb(db),
    pushRecent: (modelId) => {
      const id = normalizeId(modelId);
      if (!id) return readRecentsFromDb(db);
      db.run(
        "insert into model_picker_recents (model_id, used_at) values (?, ?) on conflict(model_id) do update set used_at = excluded.used_at",
        [id, sequencedNowStamp()],
      );
      pruneRecents(db);
      return readRecentsFromDb(db);
    },
    flush: () => {
      // DB writes are synchronous and already durable — nothing to flush.
    },
  };
}

export const MODEL_PICKER_MAX_RECENTS = MAX_RECENTS;

// Process-wide singleton shared across the JSON-RPC server (adeRpcServer) and
// the sync host (syncRemoteCommandService) so favorites + recents stay
// consistent within a process. The per-project cr-sqlite DB is the source of
// truth (it converges desktop/TUI/iOS via CRR replication); the singleton just
// avoids re-running the legacy-file migration on every call. Keyed by the db
// handle so a runtime project switch (new db) rebuilds the store.
let sharedStoreInstance: ModelPickerStore | null = null;
let sharedStoreDb: AdeDb | null = null;
export function getSharedModelPickerStore(db: AdeDb): ModelPickerStore {
  if (!sharedStoreInstance || sharedStoreDb !== db) {
    sharedStoreInstance = createModelPickerStore({ db });
    sharedStoreDb = db;
  }
  return sharedStoreInstance;
}
export function resetSharedModelPickerStoreForTests(): void {
  sharedStoreInstance = null;
  sharedStoreDb = null;
}
