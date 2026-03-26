const DRAFT_STORAGE_KEY = "ade.chat.drafts";
const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 10_000;

type DraftEntry = {
  text: string;
  modelId?: string;
  updatedAt: number;
};

type DraftStore = Record<string, DraftEntry>; // keyed by sessionId or "draft:<laneId>"

function readDrafts(): DraftStore {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeDrafts(store: DraftStore) {
  try {
    // Evict oldest entries if over MAX_DRAFTS
    const entries = Object.entries(store).sort(
      (a, b) => b[1].updatedAt - a[1].updatedAt,
    );
    const trimmed = Object.fromEntries(entries.slice(0, MAX_DRAFTS));
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore quota errors
  }
}

export function saveDraft(key: string, text: string, modelId?: string) {
  if (!key || !text.trim()) {
    removeDraft(key);
    return;
  }
  const store = readDrafts();
  store[key] = {
    text: text.slice(0, MAX_DRAFT_LENGTH),
    modelId,
    updatedAt: Date.now(),
  };
  writeDrafts(store);
}

export function loadDraft(key: string): DraftEntry | null {
  if (!key) return null;
  const store = readDrafts();
  return store[key] ?? null;
}

export function removeDraft(key: string) {
  if (!key) return;
  const store = readDrafts();
  delete store[key];
  writeDrafts(store);
}
