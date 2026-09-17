import { useSyncExternalStore } from "react";

import type { SceneStillRecord } from "../../../shared/chatScene";

/**
 * Where a scene's picture lives once the scene itself has stopped.
 *
 * A scene is code, and the whole point of freezing one is that the code never
 * runs again. That leaves a question this store answers: what does the user see
 * when they come back? Three moments need an answer and they need the same one
 * — scrolling back to a settled turn, remounting a row the virtualizer threw
 * away, and reopening the chat in a new window — so there is one index rather
 * than a cache per surface.
 *
 * Two layers, because they fail at different times. The in-memory map holds the
 * PNG data URL the capture produced, which is instant and costs no protocol
 * round trip; the persisted index holds the project-relative artifact uri,
 * which survives the window closing and is resolved back through
 * `ade-artifact://project/`. A still is written to both, and read from whichever
 * still has it.
 *
 * Keyed by the caller's `scopeKey` — the transcript row key, or the call id for
 * a scene drawn on a call. That key is what makes two byte-identical scenes at
 * different positions keep their own picture, and it is stable across a reopen
 * for exactly the same reason the row key is.
 */

export type SceneStill = {
  /** PNG data URL, present only in the window that took the capture. */
  dataUrl: string | null;
  /** The bytes on disk, once main has stored them. Survives a reopen. */
  record: SceneStillRecord | null;
};

const STORAGE_KEY = "ade.scene.stills.v1";
/**
 * How many stills the persisted index keeps.
 *
 * `localStorage` is a few megabytes for the whole origin and this index shares
 * it with everything else the renderer persists, so it is bounded by entry
 * count and pruned oldest-first. Only the uri is written — never the data URL —
 * which keeps an entry at a couple of hundred bytes and makes the bound about
 * rows rather than pixels.
 */
const PERSISTED_LIMIT = 400;

const stills = new Map<string, SceneStill>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function readPersisted(): Record<string, SceneStillRecord> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, SceneStillRecord>;
  } catch {
    // A corrupt index is not worth a failed render; it is a cache.
    return {};
  }
}

function writePersisted(next: Record<string, SceneStillRecord>): void {
  if (typeof localStorage === "undefined") return;
  try {
    const keys = Object.keys(next);
    // Insertion order is the age order here: `JSON.parse` preserves it for
    // string keys and every write appends. Dropping from the front therefore
    // drops the oldest rows, which are the ones furthest up a transcript.
    const trimmed = keys.length > PERSISTED_LIMIT
      ? Object.fromEntries(keys.slice(keys.length - PERSISTED_LIMIT).map((key) => [key, next[key]!]))
      : next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota, private mode, a disabled store: the in-memory half still works
    // for this window, which is the case that matters most.
  }
}

/** Remember a still. The data URL is this window's; the record is durable. */
export function rememberSceneStill(
  scopeKey: string,
  still: { dataUrl?: string | null; record?: SceneStillRecord | null },
): void {
  if (!scopeKey) return;
  const previous = stills.get(scopeKey) ?? { dataUrl: null, record: null };
  const next: SceneStill = {
    dataUrl: still.dataUrl ?? previous.dataUrl,
    record: still.record ?? previous.record,
  };
  stills.set(scopeKey, next);
  if (next.record) {
    const persisted = readPersisted();
    // Re-inserted rather than updated in place, so a still that was just taken
    // counts as the newest entry for the trim above.
    delete persisted[scopeKey];
    persisted[scopeKey] = next.record;
    writePersisted(persisted);
  }
  notify();
}

/** The still for a scene, or null. Reads the persisted index on a miss. */
export function readSceneStill(scopeKey: string | null | undefined): SceneStill | null {
  if (!scopeKey) return null;
  const inMemory = stills.get(scopeKey);
  if (inMemory && (inMemory.dataUrl || inMemory.record)) return inMemory;
  const record = readPersisted()[scopeKey];
  if (!record) return null;
  // Promoted into memory so a scrolling transcript does not parse the index
  // once per row per render.
  const hydrated: SceneStill = { dataUrl: null, record };
  stills.set(scopeKey, hydrated);
  return hydrated;
}

/**
 * The stills a voice call left behind, oldest first.
 *
 * Call scope is its own index rather than a second lookup over the scene one:
 * a call draws several scenes over its length and the card wants all of them,
 * while a transcript row wants exactly the one it drew.
 */
const callStills = new Map<string, SceneStillRecord[]>();
const CALL_STILLS_STORAGE_KEY = "ade.cto.callStills.v1";
/** Stills kept per call. A long call draws a handful; a card shows a few. */
const CALL_STILLS_LIMIT = 8;
/** Calls kept in the persisted index, pruned oldest-first like the scene one. */
const PERSISTED_CALL_LIMIT = 60;

function readPersistedCalls(): Record<string, SceneStillRecord[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CALL_STILLS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, SceneStillRecord[]>;
  } catch {
    return {};
  }
}

export function rememberCallStill(callId: string, record: SceneStillRecord): void {
  if (!callId || !record?.uri) return;
  const existing = callStills.get(callId) ?? readPersistedCalls()[callId] ?? [];
  // A call redraws the same scene as it talks, and each redraw settles into its
  // own still; the same uri twice is the same picture and is dropped.
  if (existing.some((entry) => entry.uri === record.uri)) return;
  const next = [...existing, record].slice(-CALL_STILLS_LIMIT);
  callStills.set(callId, next);
  try {
    const persisted = readPersistedCalls();
    delete persisted[callId];
    persisted[callId] = next;
    const keys = Object.keys(persisted);
    const trimmed = keys.length > PERSISTED_CALL_LIMIT
      ? Object.fromEntries(keys.slice(keys.length - PERSISTED_CALL_LIMIT).map((key) => [key, persisted[key]!]))
      : persisted;
    localStorage?.setItem(CALL_STILLS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // See `writePersisted`: the card still works in this window.
  }
  notify();
}

const NO_STILLS: SceneStillRecord[] = [];

export function readCallStills(callId: string | null | undefined): SceneStillRecord[] {
  if (!callId) return NO_STILLS;
  const inMemory = callStills.get(callId);
  if (inMemory) return inMemory;
  const persisted = readPersistedCalls()[callId];
  if (!persisted?.length) return NO_STILLS;
  callStills.set(callId, persisted);
  return persisted;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-render when this scene's still arrives. */
export function useSceneStill(scopeKey: string | null | undefined): SceneStill | null {
  return useSyncExternalStore(
    subscribe,
    () => readSceneStill(scopeKey),
    () => readSceneStill(scopeKey),
  );
}

/** Re-render when a call's stills arrive — the card mounts before they do. */
export function useCallStills(callId: string | null | undefined): SceneStillRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => readCallStills(callId),
    () => readCallStills(callId),
  );
}

/**
 * Where a still's bytes can be shown from.
 *
 * The data URL first — it is already in memory and needs no protocol — then
 * the artifact uri, which only resolves in a local desktop window. A remote
 * project has no `ade-artifact://` handler, so a still taken on another machine
 * answers null and the caller shows nothing rather than a broken image.
 */
export function sceneStillSrc(still: SceneStill | SceneStillRecord | null | undefined): string | null {
  if (!still) return null;
  if ("dataUrl" in still && still.dataUrl) return still.dataUrl;
  const record = "record" in still ? still.record : still;
  const uri = record?.uri?.trim();
  if (!uri) return null;
  if (/^ade-artifact:\/\//i.test(uri)) return uri;
  if (/^https?:\/\//i.test(uri) || uri.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(uri)) return null;
  return `ade-artifact://project/${uri.split("/").map(encodeURIComponent).join("/")}`;
}

/** Test seam: forget everything this window remembers. */
export function resetSceneStillsForTest(): void {
  stills.clear();
  callStills.clear();
  try {
    localStorage?.removeItem(STORAGE_KEY);
    localStorage?.removeItem(CALL_STILLS_STORAGE_KEY);
  } catch {
    /* no store to clear */
  }
  notify();
}
