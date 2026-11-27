import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
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
// this client only. The first sync with the account adds this client's whole
// list to it, and the machine's old list is read once and merged in first.
const STORAGE_KEY = "ade.modelPicker.favorites.v1";
/** Set once the machine's list was merged in; until then each start tries again. */
const IMPORTED_KEY = "ade.modelPicker.favorites.imported.v1";
/** Changes made here that the account hasn't confirmed: `{add, remove}`. */
const PENDING_KEY = "ade.modelPicker.favorites.pending.v1";
/** Set once this client's list was added to the account's. */
const ACCOUNT_MERGED_KEY = "ade.modelPicker.favorites.accountMerged.v1";
/** Opening the picker reads the account again after this long. No timer. */
const RESYNC_AFTER_MS = 15_000;

type Pending = { add: string[]; remove: string[] };

function readFlag(key: string): boolean {
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
    // Not saved: the next start does the same merge again, which changes nothing.
  }
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) if (typeof entry === "string" && entry.length > 0 && !out.includes(entry)) out.push(entry);
  return out;
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore — the copy here is convenience state; the account holds the list.
  }
}

function readPending(): Pending {
  const raw = readJson(PENDING_KEY) as Partial<Pending> | null;
  return { add: idsOf(raw?.add), remove: idsOf(raw?.remove) };
}

/** `list` with the changes the account hasn't confirmed yet applied. */
function withPending(list: readonly string[], pending: Pending): string[] {
  const next = list.filter((id) => !pending.remove.includes(id));
  for (const id of pending.add) if (!next.includes(id)) next.push(id);
  return next;
}

/** The machine's list with this client's own picks added after it, minus `removed`. */
function mergeImported(imported: readonly string[], local: readonly string[], removed: ReadonlySet<string>): string[] {
  const merged = idsOf(imported).filter((value) => !removed.has(value));
  for (const value of local) if (!merged.includes(value)) merged.push(value);
  return merged;
}

function getImportApi(): ((pin: OpenProjectBinding) => Promise<{ favorites: string[] }>) | null {
  if (typeof window === "undefined") return null;
  const getFavorites = window.ade?.modelPicker?.getFavorites;
  return typeof getFavorites === "function" ? getFavorites : null;
}

/** A refusal that sending the same change again can't change (not sign-in, network, rate or a busy list). */
function isRefusedChange(answer: { code: string; status: number }): boolean {
  return (answer.status === 400 || answer.status === 409 || answer.status === 413) && answer.code !== "favorites_busy";
}

let importInFlight: Promise<void> | null = null;
/** Models removed while the import runs; the merge must not add them back. */
const removedDuringImport = new Set<string>();
let syncInFlight: Promise<void> | null = null;
/** A toggle while a sync ran: sync once more after it. */
let syncAgain = false;
let lastSyncAt = 0;

type FavoritesState = {
  favorites: string[];
  pending: Pending;
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
  /** Reads the account's list and sends the changes made here. Never throws. */
  sync: (options?: { force?: boolean }) => Promise<void>;
};

const useFavoritesStore = create<FavoritesState>((set, get) => {
  const setLocal = (favorites: string[], pending: Pending) => {
    set({ favorites, pending });
    writeJson(STORAGE_KEY, favorites);
    writeJson(PENDING_KEY, pending);
  };

  /** The one-time read of the old list on the tab's machine. */
  const importFromMachine = async (): Promise<void> => {
    if (readFlag(IMPORTED_KEY)) return;
    if (importInFlight) return importInFlight;
    const pin = useAppStore.getState().projectBinding;
    const getFavorites = getImportApi();
    // No tab open, a tab on ADE Cloud (no computer holds the old list), or no
    // bridge yet: a later sync imports.
    if (!pin || isAdeCloudBinding(pin) || !getFavorites) return;
    importInFlight = (async () => {
      try {
        const result = await getFavorites(pin);
        const { favorites, pending } = get();
        const next = mergeImported(Array.isArray(result?.favorites) ? result.favorites : [], favorites, removedDuringImport);
        // The account hasn't seen these yet: they go with the next change.
        const added = next.filter((id) => !favorites.includes(id));
        setLocal(next, { add: [...pending.add, ...added.filter((id) => !pending.add.includes(id))], remove: pending.remove.filter((id) => !added.includes(id)) });
        setFlag(IMPORTED_KEY);
      } catch (error) {
        // The list here stays as it is; the next start tries the import again.
        captureError(error, { fingerprint: ["model-picker", "favorites-import"], level: "warning", handled: true });
      } finally {
        importInFlight = null;
        removedDuringImport.clear();
      }
    })();
    return importInFlight;
  };

  const syncOnce = async (): Promise<void> => {
    await importFromMachine();
    const merged = readFlag(ACCOUNT_MERGED_KEY);
    const pending = get().pending;
    // The first sync adds this client's whole list to the account's.
    const sent: Pending = merged
      ? pending
      : {
        add: [...get().favorites, ...pending.add.filter((id) => !get().favorites.includes(id))]
          .filter((id) => id.length <= ACCOUNT_MODEL_FAVORITE_ID_MAX)
          .slice(0, ACCOUNT_MODEL_FAVORITES_MAX),
        remove: pending.remove,
      };
    const answer = sent.add.length || sent.remove.length
      ? await runAccountCall({ call: "changeModelFavorites", add: sent.add, remove: sent.remove })
      : await runAccountCall({ call: "modelFavorites" });
    // Changes made while the call ran stay pending; the ones it carried are done.
    const leftAfterSent = (): Pending => {
      const now = get().pending;
      return {
        add: now.add.filter((id) => !sent.add.includes(id)),
        remove: now.remove.filter((id) => !sent.remove.includes(id)),
      };
    };
    if (answer && !answer.ok && isRefusedChange(answer)) {
      // The account refused this change (the list is full, an id it can't
      // take): sending it again can't land. Drop it and show the account's list.
      setFlag(ACCOUNT_MERGED_KEY);
      const left = leftAfterSent();
      setLocal(withPending(get().favorites.filter((id) => !sent.add.includes(id)), left), left);
      syncAgain = true;
      return;
    }
    // No account bridge, signed out, offline, or an older server: keep the
    // list here and the changes for the next sync.
    if (!answer || !answer.ok || !answer.result) return;
    if (!merged) setFlag(ACCOUNT_MERGED_KEY);
    const left = leftAfterSent();
    setLocal(withPending(answer.result.favorites, left), left);
    if (left.add.length || left.remove.length) syncAgain = true;
  };

  return {
    favorites: typeof window !== "undefined" ? idsOf(readJson(STORAGE_KEY)) : [],
    pending: typeof window !== "undefined" ? readPending() : { add: [], remove: [] },
    toggleFavorite: (modelId: string) => {
      const id = modelId.trim();
      if (!id) return;
      const { favorites, pending } = get();
      const removing = favorites.includes(id);
      const next = removing ? favorites.filter((entry) => entry !== id) : [...favorites, id];
      const nextPending: Pending = removing
        ? { add: pending.add.filter((entry) => entry !== id), remove: [...pending.remove.filter((entry) => entry !== id), id] }
        : { add: [...pending.add.filter((entry) => entry !== id), id], remove: pending.remove.filter((entry) => entry !== id) };
      if (importInFlight) {
        if (removing) removedDuringImport.add(id);
        else removedDuringImport.delete(id);
      }
      setLocal(next, nextPending);
      void get().sync({ force: true });
    },
    isFavorite: (modelId: string) => get().favorites.includes(modelId),
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
  const { favorites, toggleFavorite, isFavorite, sync } = useFavoritesStore(
    useShallow((state) => ({
      favorites: state.favorites,
      toggleFavorite: state.toggleFavorite,
      isFavorite: state.isFavorite,
      sync: state.sync,
    })),
  );

  // Opening the picker reads the account's list (at most every 15 s), so a
  // star given on another device shows here.
  useEffect(() => {
    void sync();
  }, [sync]);

  return { favorites, toggleFavorite, isFavorite };
}
