import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  AndroidSdkInstallState,
  AndroidSystemImageEntry,
  AndroidSystemImageInventory,
} from "../../../shared/types/androidEmulator";
import { showToast } from "../app/toast/toastStore";
import { describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";
import { formatAndroidBytes } from "./androidSdkFormat";

/**
 * The picker's System images section: the list from the lane's machine, an
 * install on the machine's one SDK install job, and a removal.
 *
 * It reads only while the section is open. Progress arrives as
 * `android.sdk.install` events; while an install runs, a state read every few
 * seconds covers a lost event (as the setup card does). Every call takes the
 * pin, so a lane on another machine lists and changes that machine's images.
 */

const RUNNING_STATE_READ_MS = 3_000;

export type AndroidSystemImages = {
  inventory: AndroidSystemImageInventory | null;
  loading: boolean;
  /** The last read failure. */
  error: AndroidErrorDescription | null;
  /** The last install, cancel or remove refusal. */
  actionError: AndroidErrorDescription | null;
  install: AndroidSdkInstallState;
  /** The image the running install is for. */
  installingId: string | null;
  /** The image an install or a removal is being sent for. */
  sending: string | null;
  refresh: () => void;
  startInstall: (entry: AndroidSystemImageEntry, acceptedLicenseIds: string[]) => Promise<boolean>;
  cancelInstall: () => void;
  remove: (entry: AndroidSystemImageEntry, confirmedInUse: boolean) => Promise<void>;
  clearActionError: () => void;
};

export function useAndroidSystemImages(pin: OpenProjectBinding | null, open: boolean): AndroidSystemImages {
  const api = window.ade?.androidEmulator ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [inventory, setInventory] = useState<AndroidSystemImageInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AndroidErrorDescription | null>(null);
  const [actionError, setActionError] = useState<AndroidErrorDescription | null>(null);
  const [install, setInstall] = useState<AndroidSdkInstallState>({ state: "idle" });
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const readSeq = useRef(0);
  const installingRef = useRef<{ id: string | null; name: string | null }>({ id: null, name: null });

  const read = useCallback(async () => {
    if (!api) return;
    const seq = ++readSeq.current;
    setLoading(true);
    try {
      const next = await api.listSystemImages({}, pinRef.current);
      if (seq !== readSeq.current) return;
      setInventory(next);
      setInstall(next.install);
      setError(null);
      if (next.install.state === "running") {
        const entry = next.images.find((image) => image.id === next.installingId);
        installingRef.current = { id: next.installingId, name: entry?.name ?? null };
      }
      setInstallingId(next.install.state === "running" ? next.installingId : null);
    } catch (caught) {
      if (seq !== readSeq.current) return;
      setError(describeAndroidError(caught));
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, [api]);

  // A new machine starts from nothing; opening the section reads.
  useEffect(() => {
    setInventory(null);
    setError(null);
    setActionError(null);
    setInstall({ state: "idle" });
    setInstallingId(null);
    installingRef.current = { id: null, name: null };
  }, [pinKey]);
  useEffect(() => {
    if (open) void read();
  }, [open, pinKey, read]);

  /** The end of an image install: one toast, then the list again. */
  const settle = useCallback((next: AndroidSdkInstallState) => {
    setInstall(next);
    if (next.state === "running") return;
    const { id, name } = installingRef.current;
    installingRef.current = { id: null, name: null };
    setInstallingId(null);
    if (id && next.state === "done") {
      showToast({ id: "android-image-installed", tone: "success", title: `Installed ${name ?? id}`, message: "New devices can use it now." });
    } else if (id && next.state === "failed") {
      setActionError(describeAndroidError(`${next.error.code}: ${next.error.message}`));
    }
    void read();
  }, [read]);

  useEffect(() => {
    if (!api || !open) return undefined;
    return api.onEvent((event) => {
      if (event.type === "android.sdk.install") settle(event.install);
      else if (event.type === "android.inventory.changed" && installingRef.current.id === null) void read();
    }, pinRef.current);
    // Keyed on the machine, not the pin object.
  }, [api, open, pinKey, read, settle]);

  const running = install.state === "running";
  useEffect(() => {
    if (!api || !open || !running) return undefined;
    const timer = window.setInterval(() => {
      void api.getSdkInstallState({}, pinRef.current).then(settle).catch((caught: unknown) => {
        // The next event or read answers; keep the failure for the console.
        console.warn("[android] system image install state read failed", caught);
      });
    }, RUNNING_STATE_READ_MS);
    return () => window.clearInterval(timer);
  }, [api, open, pinKey, running, settle]);

  const startInstall = useCallback(async (entry: AndroidSystemImageEntry, acceptedLicenseIds: string[]) => {
    if (!api) return false;
    setSending(entry.id);
    setActionError(null);
    try {
      installingRef.current = { id: entry.id, name: entry.name };
      setInstallingId(entry.id);
      const next = await api.installSystemImage({ id: entry.id, acceptedLicenseIds }, pinRef.current);
      settle(next);
      return true;
    } catch (caught) {
      installingRef.current = { id: null, name: null };
      setInstallingId(null);
      setActionError(describeAndroidError(caught));
      return false;
    } finally {
      setSending(null);
    }
  }, [api, settle]);

  const cancelInstall = useCallback(() => {
    if (!api) return;
    void api.cancelSdkInstall({}, pinRef.current).then(settle).catch((caught: unknown) => {
      setActionError(describeAndroidError(caught));
    });
  }, [api, settle]);

  const remove = useCallback(async (entry: AndroidSystemImageEntry, confirmedInUse: boolean) => {
    if (!api) return;
    setSending(entry.id);
    setActionError(null);
    try {
      const result = await api.removeSystemImage({ id: entry.id, confirmedInUse }, pinRef.current);
      if (result.removed) {
        const freed = result.freedBytes ? ` · ${formatAndroidBytes(result.freedBytes)} freed` : "";
        showToast({ id: "android-image-removed", tone: "success", title: `Removed ${entry.name}${freed}` });
      }
    } catch (caught) {
      setActionError(describeAndroidError(caught));
    } finally {
      setSending(null);
      void read();
    }
  }, [api, read]);

  return {
    inventory,
    loading,
    error,
    actionError,
    install,
    installingId,
    sending,
    refresh: () => void read(),
    startInstall,
    cancelInstall,
    remove,
    clearActionError: () => setActionError(null),
  };
}
