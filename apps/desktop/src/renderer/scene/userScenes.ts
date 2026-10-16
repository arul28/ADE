/**
 * The user's own scene pictures, kept in IndexedDB in the renderer.
 *
 * Pictures are re-encoded on import: the longest edge is capped at
 * `MAX_EDGE` and the result is a JPEG, so a 20 MB photo becomes a few hundred
 * KB and decoding it on every launch stays cheap. Nothing here leaves the
 * machine; preferences only ever hold the `user:<id>` key.
 */

const DB_NAME = "ade-scenes";
const STORE = "images";
const MAX_EDGE = 3840;
const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

export type UserScene = {
  id: `user:${string}`;
  name: string;
  blob: Blob;
  width: number;
  height: number;
  addedAt: number;
};

export type UserSceneSummary = Omit<UserScene, "blob">;

let dbPromise: Promise<IDBDatabase> | null = null;
const urlCache = new Map<string, string>();
const listeners = new Set<() => void>();

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the scene store"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Scene store request failed"));
      }),
  );
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeUserScenes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function listUserScenes(): Promise<UserSceneSummary[]> {
  try {
    const rows = await run<UserScene[]>("readonly", (store) => store.getAll() as IDBRequest<UserScene[]>);
    return rows
      .map(({ blob: _blob, ...summary }) => summary)
      .sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

/** An object URL for a stored picture, or null when it is gone. Cached per id. */
export async function userSceneUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  try {
    const row = await run<UserScene | undefined>("readonly", (store) => store.get(id) as IDBRequest<UserScene | undefined>);
    if (!row) return null;
    const url = URL.createObjectURL(row.blob);
    urlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That file is not a picture ADE can read"));
    image.src = url;
  });
}

async function reencode(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const source = URL.createObjectURL(file);
  try {
    const image = await loadImage(source);
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the picture");
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("Could not prepare the picture");
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(source);
  }
}

function newId(): `user:${string}` {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `user:${random}`;
}

export async function addUserScene(file: File): Promise<UserSceneSummary> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture file (PNG, JPEG, WebP or GIF)");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("That picture is over 40 MB");
  const { blob, width, height } = await reencode(file);
  const name = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "My picture";
  const row: UserScene = { id: newId(), name, blob, width, height, addedAt: Date.now() };
  await run("readwrite", (store) => store.put(row));
  notify();
  const { blob: _blob, ...summary } = row;
  return summary;
}

export async function removeUserScene(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
  const cached = urlCache.get(id);
  if (cached) URL.revokeObjectURL(cached);
  urlCache.delete(id);
  notify();
}
