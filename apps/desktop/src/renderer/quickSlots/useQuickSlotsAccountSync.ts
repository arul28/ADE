import { useEffect } from "react";
import { QUICK_SLOTS_STORAGE_KEY, type QuickSlotsPreferences } from "../../shared/quickSlots";
import { fetchAccountStatus, subscribeAccountStatus } from "../lib/account";
import { startAccountSettingsSync, type AccountSyncedSetting } from "../lib/accountSettingsSync";
import { useQuickSlotsStore } from "./quickSlotsStore";

/** The account settings store takes rows under this size. */
const MAX_ROW_BYTES = 16_000;

type QuickSlotsStoreState = ReturnType<typeof useQuickSlotsStore.getState>;

/** The slots as one account value, the oldest profiles left out when the whole list is too big. */
function accountValueOf(state: QuickSlotsStoreState): QuickSlotsPreferences {
  const value: QuickSlotsPreferences = {
    version: 1,
    slots: state.slots,
    profiles: state.profiles,
    leader: state.leader,
    keepOpenAfterRelease: state.keepOpenAfterRelease,
    profileCaretBehavior: state.profileCaretBehavior,
  };
  let profiles = value.profiles;
  while (profiles.length > 0 && JSON.stringify({ ...value, profiles }).length >= MAX_ROW_BYTES) profiles = profiles.slice(1);
  return profiles === value.profiles ? value : { ...value, profiles };
}

/**
 * The engine's own stamps and retry marks, under keys of their own: the app's
 * sync writes its whole stamp map, and a second engine on the same keys would
 * overwrite it.
 */
const ownStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(`ade.quickSlots.accountSync:${key}`);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(`ade.quickSlots.accountSync:${key}`, value);
    } catch {
      // A lost stamp costs one extra apply after a reload.
    }
  },
};

const QUICK_SLOTS_SETTING: AccountSyncedSetting<QuickSlotsStoreState> = {
  // The account key is the local storage key's own name: one name, not two.
  key: QUICK_SLOTS_STORAGE_KEY.replace(/^ade\./, ""),
  scope: "account",
  read: accountValueOf,
  apply: (state, value) => state.applyAccount(value),
};

/**
 * Quick slots follow the account (`quickSlots.v1`, scope all): a change here
 * goes to the account, and the account's newer copy comes in. This
 * computer's localStorage stays the local copy. Reads ride the account
 * store's change event and the window showing again; no timer of its own.
 * Account level: no pin.
 */
export function useQuickSlotsAccountSync(): void {
  useEffect(() => {
    let signedIn = false;
    let accountUserId: string | null = null;
    const stop = startAccountSettingsSync<QuickSlotsStoreState>({
      store: useQuickSlotsStore,
      settings: [QUICK_SLOTS_SETTING],
      getApi: () => window.ade?.accountSettings ?? null,
      isSignedIn: () => signedIn,
      getAccountUserId: () => accountUserId,
      subscribeSignedIn: (listener) =>
        subscribeAccountStatus((status) => {
          const nextUserId = status.signedIn ? status.userId?.trim() || null : null;
          if (status.signedIn === signedIn && nextUserId === accountUserId) return;
          signedIn = status.signedIn;
          accountUserId = nextUserId;
          listener();
        }),
      getProjectRemote: () => null,
      storage: ownStorage,
      // The app's own sync already reads on a timer; this one waits for the
      // account store's change event and the window showing again.
      setInterval: () => null,
      clearInterval: () => undefined,
    });
    void fetchAccountStatus().catch(() => undefined);
    return () => stop();
  }, []);
}
