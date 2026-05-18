import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_RECENTS = 10;
const STORE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 250;

type PersistedShape = {
  version: number;
  favorites: string[];
  recents: string[];
};

export type ModelPickerStore = {
  getFavorites: () => string[];
  setFavorites: (favorites: string[]) => string[];
  toggleFavorite: (modelId: string) => { favorites: string[]; isFavorite: boolean };
  getRecents: () => string[];
  pushRecent: (modelId: string) => string[];
  /** Flush any pending debounced write. Exposed for tests/teardown. */
  flush: () => void;
};

export type CreateModelPickerStoreOptions = {
  filePath?: string;
};

function defaultFilePath(): string {
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

function readPersisted(filePath: string): PersistedShape {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: STORE_VERSION, favorites: [], recents: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      version: typeof record.version === "number" ? record.version : STORE_VERSION,
      favorites: sanitizeIdList(record.favorites),
      recents: sanitizeIdList(record.recents).slice(0, MAX_RECENTS),
    };
  } catch {
    return { version: STORE_VERSION, favorites: [], recents: [] };
  }
}

function writePersisted(filePath: string, state: PersistedShape): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = JSON.stringify(state, null, 2);
    fs.writeFileSync(filePath, body, "utf8");
  } catch {
    // best-effort — favorites/recents are convenience state, not load-bearing.
  }
}

export function createModelPickerStore(options: CreateModelPickerStoreOptions = {}): ModelPickerStore {
  const filePath = options.filePath ?? defaultFilePath();
  const state = readPersisted(filePath);

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistSoon = () => {
    if (persistTimer != null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writePersisted(filePath, { ...state, version: STORE_VERSION });
    }, PERSIST_DEBOUNCE_MS);
  };
  const flush = () => {
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writePersisted(filePath, { ...state, version: STORE_VERSION });
  };

  // Flush pending debounced pushRecent on process exit so the latest model
  // selection isn't lost when the user closes the TUI within the debounce window.
  // exit handler runs synchronously and flush uses writeFileSync.
  if (!options.filePath) {
    process.once("exit", () => {
      if (persistTimer != null) flush();
    });
  }

  return {
    getFavorites: () => state.favorites.slice(),
    setFavorites: (favorites) => {
      state.favorites = sanitizeIdList(favorites);
      flush();
      return state.favorites.slice();
    },
    toggleFavorite: (modelId) => {
      const id = typeof modelId === "string" ? modelId.trim() : "";
      if (!id) return { favorites: state.favorites.slice(), isFavorite: false };
      const idx = state.favorites.indexOf(id);
      let isFavorite: boolean;
      if (idx >= 0) {
        state.favorites = [...state.favorites.slice(0, idx), ...state.favorites.slice(idx + 1)];
        isFavorite = false;
      } else {
        state.favorites = [...state.favorites, id];
        isFavorite = true;
      }
      flush();
      return { favorites: state.favorites.slice(), isFavorite };
    },
    getRecents: () => state.recents.slice(),
    pushRecent: (modelId) => {
      const id = typeof modelId === "string" ? modelId.trim() : "";
      if (!id) return state.recents.slice();
      const filtered = state.recents.filter((entry) => entry !== id);
      state.recents = [id, ...filtered].slice(0, MAX_RECENTS);
      persistSoon();
      return state.recents.slice();
    },
    flush,
  };
}

export const MODEL_PICKER_MAX_RECENTS = MAX_RECENTS;

// Process-wide singleton shared across the JSON-RPC server (adeRpcServer) and
// the sync host (syncRemoteCommandService) so favorites + recents stay
// consistent for desktop/TUI/iOS without coordination races. Lazy-init so
// tests can avoid touching the user's real ~/.ade/modelPicker.json by
// supplying their own store instance via `createModelPickerStore`.
let sharedStoreInstance: ModelPickerStore | null = null;
export function getSharedModelPickerStore(): ModelPickerStore {
  if (!sharedStoreInstance) {
    sharedStoreInstance = createModelPickerStore();
  }
  return sharedStoreInstance;
}
export function resetSharedModelPickerStoreForTests(): void {
  sharedStoreInstance = null;
}
