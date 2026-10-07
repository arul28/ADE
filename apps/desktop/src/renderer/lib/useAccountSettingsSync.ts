/**
 * Mounts the account-settings sync into the running app.
 *
 * Split from `accountSettingsSync.ts` on purpose: the sync engine itself
 * depends on nothing but the scope helpers, so its tests drive the whole
 * hydrate/write-through path against a hand-built store. This file is the only
 * place that knows about React, the root app store, and the account status bus.
 */

import { useEffect } from "react";

import { rootAppStoreApi } from "../state/appStore";
import { fetchAccountStatus, subscribeAccountStatus } from "./account";
import { registerAccountSettingsSync } from "./accountSettingsFlush";
import {
  startAccountSettingsSync,
} from "./accountSettingsSync";

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

/**
 * Mounts the sync for the running app, bound to the ROOT store.
 *
 * The root store is where the persisted preferences live — a project-scoped
 * store is a per-window view over the same values — so hydrating anywhere else
 * would apply the account's theme to one window and leave the next stale.
 *
 * Mounted once, from `App`. Every dependency degrades quietly: no preload
 * bridge (the hosted web client), no account, or no brain each mean this
 * machine keeps its local copy and syncs the next time it can.
 *
 * `getProjectRemote` returns null because no account-repo preference lives in
 * the app store yet. The registry supports them; the resolver gains a real
 * remote on the day one appears.
 */
export function useAccountSettingsSync(): void {
  useEffect(() => {
    let signedIn = false;
    let accountUserId: string | null = null;
    // Per-device settings (Apple devices) file under this computer's sync
    // device id. It arrives asynchronously; when it does, re-run the pull so
    // those rows hydrate without waiting for the next tick.
    let localDeviceId: string | null = null;
    let notifySignedIn: (() => void) | null = null;
    const sync = window.ade?.sync;
    void (sync?.getLocalStatus ? sync.getLocalStatus() : sync?.getStatus?.())
      ?.then((status) => {
        localDeviceId = status?.localDevice?.deviceId?.trim() || null;
        if (localDeviceId && signedIn) notifySignedIn?.();
      })
      .catch(() => undefined);
    const stop = startAccountSettingsSync({
      store: rootAppStoreApi,
      getApi: () => window.ade?.accountSettings ?? null,
      isSignedIn: () => signedIn,
      getAccountUserId: () => accountUserId,
      subscribeSignedIn: (listener) => {
        notifySignedIn = listener;
        return subscribeAccountStatus((status) => {
          // Only a CHANGE is worth a pull. The status bus republishes the same
          // signed-in status on every cached read, and hydrating on each of
          // those would be a request storm carrying no new information.
          const nextUserId = status.signedIn ? status.userId?.trim() || null : null;
          if (status.signedIn === signedIn && nextUserId === accountUserId) return;
          signedIn = status.signedIn;
          accountUserId = nextUserId;
          listener();
        });
      },
      getProjectRemote: () => null,
      getLocalDeviceId: () => localDeviceId,
    });
    // Seeds `signedIn` through the status bus above, which is also what a later
    // sign-in arrives on. One subscriber, one path.
    void fetchAccountStatus().catch(() => undefined);
    // Published so a save or a launch can await the brain's own answer instead
    // of racing the 30-second tick; see `accountSettingsFlush`.
    registerAccountSettingsSync(stop);
    return () => {
      registerAccountSettingsSync(null);
      stop();
    };
  }, []);
}
