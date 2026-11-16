/**
 * The user's own scene pictures, kept in IndexedDB in the renderer.
 *
 * Pictures are re-encoded on import: the longest edge is capped at
 * `MAX_EDGE` and the result is a JPEG, so a 20 MB photo becomes a few hundred
 * KB and decoding it on every launch stays cheap. Nothing here leaves the
 * machine; preferences only ever hold the `user:<id>` key.
 *
 * The backdrop draws a copy sized for the screen (`userSceneUrl` with a
 * size), kept in its own database: a picture costs memory for every pixel it
 * decodes, and a 5120-pixel picture on a 2560-pixel screen would decode four
 * times the pixels the screen shows. The copy is made once per picture and
 * size, in a worker (`sceneCopy.worker.ts`). The stored picture stays as it
 * is, for larger screens and for the Settings tiles.
 */

import { readScreenPixels, screenCopySize, type ScreenPixels } from "./sceneLibrary";
import type { SceneCopyRequest, SceneCopyResponse } from "./sceneCopy.worker";

const DB_NAME = "ade-scenes";
const STORE = "images";
// Wide enough for a 5120-pixel ultrawide to show an imported picture sharp.
const MAX_EDGE = 5120;
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

/**
 * The screen-sized copies live in a database of their own, so the pictures'
 * database keeps version 1 and an older ADE still opens it.
 */
const COPY_DB_NAME = "ade-scene-copies";
const COPY_STORE = "copies";
/** Copies kept per picture (one per screen size it was shown on), newest first. */
const MAX_COPIES_PER_SCENE = 3;
const COPY_QUALITY = 0.9;
/** A copy that takes longer than this is given up; the picture itself shows. */
const COPY_TIMEOUT_MS = 20_000;

type SceneCopyRow = { key: string; sceneId: string; blob: Blob; width: number; height: number; madeAt: number };

const dbPromises = new Map<string, Promise<IDBDatabase>>();
/** Object URLs by picture id (the picture itself) or copy key (`<id>@<w>x<h>`). */
const urlCache = new Map<string, string>();
/** Each picture's pixels, so a cached copy is found without reading the picture. */
const sizeById = new Map<string, ScreenPixels>();
/** Copies being made, by copy key, so two callers share one worker. */
const copiesInFlight = new Map<string, Promise<Blob | null>>();
const listeners = new Set<() => void>();

function openDb(name: string, store: string, keyPath: string): Promise<IDBDatabase> {
  const existing = dbPromises.get(name);
  if (existing) return existing;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the scene store"));
  });
  dbPromises.set(name, opening);
  opening.catch(() => {
    dbPromises.delete(name);
  });
  return opening;
}

function runIn<T>(
  name: string,
  store: string,
  keyPath: string,
  mode: IDBTransactionMode,
  body: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb(name, store, keyPath).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = body(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Scene store request failed"));
      }),
  );
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return runIn(DB_NAME, STORE, "id", mode, body);
}

function runCopies<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return runIn(COPY_DB_NAME, COPY_STORE, "key", mode, body);
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

/**
 * An object URL for a stored picture, or null when it is gone. With `screen`
 * (device pixels), the URL of the copy sized for that screen
 * (`screenCopySize`), made the first time; the picture itself when it is not
 * much larger than the screen or the copy cannot be made. Cached per id and
 * size. With `makeCopy: false`, a copy that is not stored yet is not made:
 * the picture itself comes back at once.
 */
export async function userSceneUrl(
  id: string,
  screen?: ScreenPixels | null,
  { makeCopy = true }: { makeCopy?: boolean } = {},
): Promise<string | null> {
  const knownSize = sizeById.get(id);
  if (!screen || knownSize) {
    const size = screen && knownSize ? screenCopySize(knownSize, screen) : null;
    const cached = urlCache.get(size ? copyKey(id, size) : id);
    if (cached) return cached;
  }
  try {
    const row = await run<UserScene | undefined>("readonly", (store) => store.get(id) as IDBRequest<UserScene | undefined>);
    if (!row) return null;
    sizeById.set(id, { width: row.width, height: row.height });
    const copySize = screen ? screenCopySize(row, screen) : null;
    const key = copySize ? copyKey(id, copySize) : id;
    const copy = !copySize ? null : makeCopy ? await sceneCopy(row, copySize) : await storedCopy(key);
    // Cached by what it shows, so a failed copy is tried again the next time
    // the picture loads.
    const cacheKey = copy ? key : id;
    const again = urlCache.get(cacheKey);
    if (again) return again;
    const url = URL.createObjectURL(copy ?? row.blob);
    urlCache.set(cacheKey, url);
    return url;
  } catch {
    return null;
  }
}

function copyKey(id: string, size: ScreenPixels): string {
  return `${id}@${size.width}x${size.height}`;
}

async function storedCopy(key: string): Promise<Blob | null> {
  const row = await runCopies<SceneCopyRow | undefined>("readonly", (store) => store.get(key) as IDBRequest<SceneCopyRow | undefined>)
    .catch(() => undefined);
  return row?.blob ?? null;
}

/** The stored copy at this size, made now when there is none. Null when it cannot be made. */
function sceneCopy(row: UserScene, size: ScreenPixels): Promise<Blob | null> {
  const key = copyKey(row.id, size);
  const inFlight = copiesInFlight.get(key);
  if (inFlight) return inFlight;
  const job = (async () => {
    const stored = await storedCopy(key);
    if (stored) return stored;
    const blob = await makeCopyInWorker({ blob: row.blob, width: size.width, height: size.height, quality: COPY_QUALITY });
    if (!blob) return null;
    const copy: SceneCopyRow = { key, sceneId: row.id, blob, width: size.width, height: size.height, madeAt: Date.now() };
    try {
      await runCopies("readwrite", (store) => store.put(copy));
      await pruneCopies(row.id);
    } catch {
      // Not stored: this launch still shows it, the next one makes it again.
    }
    return blob;
  })().finally(() => copiesInFlight.delete(key));
  copiesInFlight.set(key, job);
  return job;
}

async function copiesOf(sceneId: string): Promise<SceneCopyRow[]> {
  const rows = await runCopies<SceneCopyRow[]>("readonly", (store) => store.getAll() as IDBRequest<SceneCopyRow[]>);
  return rows.filter((row) => row.sceneId === sceneId);
}

/** Keeps the newest `MAX_COPIES_PER_SCENE` copies of a picture. */
async function pruneCopies(sceneId: string): Promise<void> {
  const stale = (await copiesOf(sceneId)).sort((a, b) => b.madeAt - a.madeAt).slice(MAX_COPIES_PER_SCENE);
  for (const row of stale) await deleteCopy(row.key);
}

async function deleteCopy(key: string): Promise<void> {
  await runCopies("readwrite", (store) => store.delete(key));
  const url = urlCache.get(key);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(key);
}

/** Null when there is no worker here or it fails: the caller shows the picture itself. */
async function makeCopyInWorker(request: SceneCopyRequest): Promise<Blob | null> {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  let worker: Worker;
  try {
    const { default: SceneCopyWorker } = await import("./sceneCopy.worker?worker");
    worker = new SceneCopyWorker();
  } catch {
    return null;
  }
  return new Promise<Blob | null>((resolve) => {
    // One worker per copy, ended after it answers: its decode of the full
    // picture is freed with it.
    const finish = (blob: Blob | null) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), COPY_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<SceneCopyResponse>) => finish("blob" in event.data ? event.data.blob : null);
    worker.onerror = () => finish(null);
    worker.postMessage(request);
  });
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
  // The copy for this screen starts now, so a pick right after the import
  // waits on this one job instead of starting its own.
  const copySize = screenCopySize(row, readScreenPixels());
  if (copySize) void sceneCopy(row, copySize);
  notify();
  const { blob: _blob, ...summary } = row;
  return summary;
}

export async function removeUserScene(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
  sizeById.delete(id);
  const cached = urlCache.get(id);
  if (cached) URL.revokeObjectURL(cached);
  urlCache.delete(id);
  try {
    for (const row of await copiesOf(id)) await deleteCopy(row.key);
  } catch {
    // A copy left behind is never shown: copies are found through their picture.
  }
  notify();
}
