import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { isAdeCloudBinding } from "../../../../shared/adeCloud/binding";
import { captureError } from "../../../../shared/sentry/capture";
import { runAccountCall } from "../../../lib/adeCloudAccountRead";
import {
  ACCOUNT_MODEL_FAVORITE_ID_MAX,
  ACCOUNT_MODEL_FAVORITES_MAX,
} from "../../../../../../account-directory/src/cloud/contract";

// Favorites belong to the person: the account server keeps one list
// (`/account/model-favorites`), so every computer, the web client and the
// phone show the same stars. This client keeps a copy (`localStorage`) to
// show at once and to use while signed out or offline, plus the changes the
// account hasn't confirmed yet, sent at the next sync. Recents stay per
// client (`useModelRecents`).
//
// Before the account list, the list lived on the tab's machine and then in
// this client only. Both reach the account as queued changes: the machine's
// old list is read once and added, then this client's whole list is added
// to the account's once.
const STORAGE_KEY = "ade.modelPicker.favorites.v1";
/** Set once the machine's list was read in; until then each start tries again. */
const IMPORTED_KEY = "ade.modelPicker.favorites.imported.v1";
/** Changes made here that the account hasn't confirmed: `{add, remove}`. Shared by every window. */
const PENDING_KEY = "ade.modelPicker.favorites.pending.v1";
/** Set once this client's list was queued for the account. */
const ACCOUNT_SEEDED_KEY = "ade.modelPicker.favorites.accountSeeded.v1";
/** The account the list, queue and flags here belong to (its user id). */
const OWNER_KEY = "ade.modelPicker.favorites.owner.v1";
/** Opening the picker reads the account again after this long. No timer. */
const RESYNC_AFTER_MS = 15_000;

type Pending = { add: string[]; remove: string[] };

function hasFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) != null;
  } catch {
    return false;
  }
}

function setFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Not saved: the next start does the same step again, which adds nothing new.
  }
}

function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    return null;
  }
}

/** False when storage refused the write (full, or blocked). */
function writeStored(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** A model id the account takes (the server's rule), or null. */
function favoriteId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= ACCOUNT_MODEL_FAVORITE_ID_MAX && !/[\p{Cc}\p{Cf}]/u.test(id) ? id : null;
}

/** The ids of `value` the account takes, deduplicated in order. */
function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(favoriteId).filter((id): id is string => id != null))] : [];
}

/** The queue when storage refused to save it: kept here so the change is still sent. */
let unsavedPending: Pending | null = null;

/**
 * Read from storage each time, so a change another window queued is never
 * overwritten. When storage could not save this window's queue, its own
 * changes win for their ids and every other saved change is kept.
 */
function readPending(): Pending {
  const raw = readStored(PENDING_KEY) as Partial<Pending> | null;
  const saved: Pending = { add: idsOf(raw?.add), remove: idsOf(raw?.remove) };
  if (!unsavedPending) return saved;
  const mine = new Set([...unsavedPending.add, ...unsavedPending.remove]);
  return {
    add: [...saved.add.filter((id) => !mine.has(id)), ...unsavedPending.add],
    remove: [...saved.remove.filter((id) => !mine.has(id)), ...unsavedPending.remove],
  };
}

function savePending(pending: Pending): void {
  unsavedPending = writeStored(PENDING_KEY, pending) ? null : pending;
}

/** `pending` with `id` queued to be added or taken off; the opposite change for it is dropped. */
function markPending(pending: Pending, id: string, change: "add" | "remove"): Pending {
  const add = pending.add.filter((entry) => entry !== id);
  const remove = pending.remove.filter((entry) => entry !== id);
  return change === "add" ? { add: [...add, id], remove } : { add, remove: [...remove, id] };
}

/** `pending` without the changes `sent` carried. */
function withoutSent(pending: Pending, sent: Pending): Pending {
  return {
    add: pending.add.filter((id) => !sent.add.includes(id)),
    remove: pending.remove.filter((id) => !sent.remove.includes(id)),
  };
}

/** `list` with the changes the account hasn't confirmed yet applied. */
function withPending(list: readonly string[], pending: Pending): string[] {
  const next = list.filter((id) => !pending.remove.includes(id));
  for (const id of pending.add) if (!next.includes(id)) next.push(id);
  return next;
}

/**
 * The account refused the change and sending it again can't land: the list
 * is full (409) or it holds an id the account can't take (400, 413). A busy
 * list answers 503 and is sent again later.
 */
function isRefusedChange(answer: { status: number }): boolean {
  return answer.status === 400 || answer.status === 409 || answer.status === 413;
}

/**
 * The signed-in account's user id; null when signed out. Undefined on an ADE
 * without the account bridge: the list here is then not tied to an account.
 */
async function accountUserId(): Promise<string | null | undefined> {
  const status = typeof window !== "undefined" ? window.ade?.account?.status : undefined;
  if (typeof status !== "function") return undefined;
  try {
    const userId = (await status())?.userId;
    return typeof userId === "string" && userId ? userId : null;
  } catch {
    return null;
  }
}

function getImportApi(): ((pin: OpenProjectBinding) => Promise<{ favorites: string[] }>) | null {
  if (typeof window === "undefined") return null;
  const getFavorites = window.ade?.modelPicker?.getFavorites;
  return typeof getFavorites === "function" ? getFavorites : null;
}

/** The machine import runs at most once per start; a failure tries again at the next start. */
let importTried = false;
let syncInFlight: Promise<void> | null = null;
/** A star while a sync ran: sync once more after it. */
let syncAgain = false;
let lastSyncAt = 0;

type FavoritesState = {
  favorites: string[];
  toggleFavorite: (modelId: string) => void;
  /** Reads the account's list and sends the changes made here. Never throws. */
  sync: (options?: { force?: boolean }) => Promise<void>;
};

const useFavoritesStore = create<FavoritesState>((set, get) => {
  const setLocal = (favorites: string[], pending: Pending) => {
    set({ favorites });
    // The list copy is convenience state (the account holds the list); the queue is not.
    writeStored(STORAGE_KEY, favorites);
    savePending(pending);
  };

  /** Adds the old list on the tab's machine, once. Stars taken off here are not added back. */
  const importFromMachine = async (): Promise<void> => {
    if (importTried || hasFlag(IMPORTED_KEY)) return;
    const pin = useAppStore.getState().projectBinding;
    const getFavorites = getImportApi();
    // No tab open, a tab on ADE Cloud (no computer holds the old list), or no
    // bridge yet: a later sync imports.
    if (!pin || isAdeCloudBinding(pin) || !getFavorites) return;
    importTried = true;
    try {
      const result = await getFavorites(pin);
      const pending = readPending();
      const favorites = get().favorites;
      const added = idsOf(result?.favorites).filter((id) => !favorites.includes(id) && !pending.remove.includes(id));
      // The machine's list first, as before; this client's picks after it.
      setLocal([...added, ...favorites], added.reduce((next, id) => markPending(next, id, "add"), pending));
      setFlag(IMPORTED_KEY);
    } catch (error) {
      captureError(error, { fingerprint: ["model-picker", "favorites-import"], level: "warning", handled: true });
    }
  };

  /** Queues this client's whole list for the account, once. */
  const seedAccount = () => {
    if (hasFlag(ACCOUNT_SEEDED_KEY)) return;
    const pending = readPending();
    // In the list's order, so the account keeps the order shown here.
    const seed = idsOf(get().favorites).slice(0, ACCOUNT_MODEL_FAVORITES_MAX);
    setLocal(get().favorites, { ...pending, add: [...seed, ...pending.add.filter((id) => !seed.includes(id))] });
    setFlag(ACCOUNT_SEEDED_KEY);
  };

  /**
   * Another account signed in here: the list, the queue and the old machine
   * list are the other account's, so this one starts from its own list.
   */
  const claimFor = (owner: string) => {
    const previous = readStored(OWNER_KEY);
    if (typeof previous === "string" && previous !== owner) {
      setLocal([], { add: [], remove: [] });
      setFlag(ACCOUNT_SEEDED_KEY);
      setFlag(IMPORTED_KEY);
    }
    writeStored(OWNER_KEY, owner);
  };

  const syncOnce = async (): Promise<void> => {
    const owner = await accountUserId();
    if (owner) claimFor(owner);
    // The machine's old list shows here even while signed out.
    await importFromMachine();
    // Signed out: keep the list here and the changes for the next sync.
    if (owner === null) return;
    seedAccount();
    // At most one list's worth each way per call; the rest goes with the next one.
    const queued = readPending();
    const sent: Pending = { add: queued.add.slice(0, ACCOUNT_MODEL_FAVORITES_MAX), remove: queued.remove.slice(0, ACCOUNT_MODEL_FAVORITES_MAX) };
    const answer = sent.add.length || sent.remove.length
      ? await runAccountCall({ call: "changeModelFavorites", add: sent.add, remove: sent.remove, ...(owner ? { account: owner } : {}) })
      : await runAccountCall({ call: "modelFavorites" });
    // The account changed while the call ran: the answer is the old account's.
    if (owner && await accountUserId() !== owner) return;
    if (answer && !answer.ok && isRefusedChange(answer)) {
      // The adds can't land (a removal never makes the list too long). Drop
      // them, send the removals again, and show the account's list. A refused
      // call of removals only drops those too, so the queue always shrinks.
      captureError(new Error(answer.message), {
        fingerprint: ["model-picker", "favorites-refused"],
        level: "warning",
        handled: true,
        tags: { code: answer.code },
      });
      const left = withoutSent(readPending(), sent.add.length ? { add: sent.add, remove: [] } : sent);
      setLocal(get().favorites.filter((id) => !sent.add.includes(id)), left);
      syncAgain = true;
      return;
    }
    // No account bridge, signed out, offline, busy, or an older server: keep
    // the list here and the changes for the next sync.
    if (!answer || !answer.ok || !answer.result) return;
    // Changes made while the call ran stay queued; the ones it carried are done.
    const left = withoutSent(readPending(), sent);
    setLocal(withPending(answer.result.favorites, left), left);
    if (left.add.length || left.remove.length) syncAgain = true;
  };

  return {
    favorites: typeof window !== "undefined" ? idsOf(readStored(STORAGE_KEY)) : [],
    toggleFavorite: (modelId: string) => {
      const id = favoriteId(modelId);
      if (!id) return;
      const favorites = get().favorites;
      const removing = favorites.includes(id);
      setLocal(
        removing ? favorites.filter((entry) => entry !== id) : [...favorites, id],
        markPending(readPending(), id, removing ? "remove" : "add"),
      );
      void get().sync({ force: true });
    },
    sync: async (options) => {
      if (syncInFlight) {
        if (options?.force) syncAgain = true;
        return syncInFlight;
      }
      if (!options?.force && Date.now() - lastSyncAt < RESYNC_AFTER_MS) return;
      syncInFlight = (async () => {
        try {
          do {
            syncAgain = false;
            lastSyncAt = Date.now();
            await syncOnce();
          } while (syncAgain);
        } catch (error) {
          captureError(error, { fingerprint: ["model-picker", "favorites-sync"], level: "warning", handled: true });
        } finally {
          syncInFlight = null;
        }
      })();
      return syncInFlight;
    },
  };
});

export function useModelFavorites(): {
  favorites: string[];
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
} {
  const favorites = useFavoritesStore((state) => state.favorites);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);
  const sync = useFavoritesStore((state) => state.sync);
  const isFavorite = useCallback((modelId: string) => favorites.includes(modelId), [favorites]);

  // Opening the picker reads the account's list (at most every 15 s), so a
  // star given on another device shows here.
  useEffect(() => {
    void sync();
  }, [sync]);

  return { favorites, toggleFavorite, isFavorite };
}
