import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  AppleRuntimeDeleteResult,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimeSimulatorDisposition,
  OpenProjectBinding,
} from "../../../shared/types";
import { appleRuntimeInstallActive } from "../../../shared/appleRuntimeVersions";
import { newestAppleRuntimeRunning } from "../../../shared/appleRuntimeVersions";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { appleDeviceSupportsDuo } from "./appleDuo";

/**
 * How long a running install may go without a progress event before the list
 * is read again. Desktop windows hear `apple.runtime.install` several times a
 * second; the web client has no event stream, so this is its progress.
 */
const INSTALL_QUIET_REREAD_MS = 2_500;

export type AppleRuntimes = {
  inventory: AppleRuntimeInventory | null;
  /** A remove or prune is running. */
  removing: boolean;
  /** Start a download; `version` pins one runtime, none lets Xcode fetch what its SDK needs. */
  install: (version?: string | null) => Promise<void>;
  cancelInstall: () => void;
  remove: (id: string, simulators: AppleRuntimeSimulatorDisposition) => Promise<AppleRuntimeDeleteResult | null>;
  prune: (simulators: AppleRuntimeSimulatorDisposition) => Promise<AppleRuntimeDeleteResult | null>;
  runXcodeSetup: () => Promise<void>;
  /** Install the runtime a missing model needs, then create that model on it. */
  installAndCreate: (deviceType: string) => void;
};

/**
 * The machine's simulator runtimes, for the picker's Runtimes section, the
 * Create control's "Not installed" option and the Xcode note.
 *
 * Every call and the event subscription carry the lane's pin, so they read
 * and change the runtimes of the machine that owns the lane's simulators; the
 * lane id rides along so the remote command path can place the call. The list
 * is read when the pane opens, on `refreshNonce`, and when an install settles;
 * progress in between arrives as `apple.runtime.install` events (or, with no
 * event stream, a re-read while the install is quiet).
 */
export function useAppleRuntimes({
  runtimePinRef,
  pinKey,
  laneId,
  enabled,
  refreshNonce,
  onInstallSettled,
  onError,
  createDevice,
}: {
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** `pin?.key`: the effects re-run when the target machine changes, not when the pin object is rebuilt. */
  pinKey: string | null;
  laneId: string | null;
  enabled: boolean;
  refreshNonce: number;
  onInstallSettled?: (install: AppleRuntimeInstallState) => void;
  onError?: (error: unknown) => void;
  /** Make a simulator: Install & create's last step, and the done toast's offer. */
  createDevice: (spec: { runtime: string; deviceType: string }) => void;
}): AppleRuntimes {
  const [inventory, setInventory] = useState<AppleRuntimeInventory | null>(null);
  const [removing, setRemoving] = useState(false);
  const readTicket = useRef(0);
  const onSettledRef = useRef(onInstallSettled);
  onSettledRef.current = onInstallSettled;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const createDeviceRef = useRef(createDevice);
  createDeviceRef.current = createDevice;
  /**
   * "Install & create": the model the person picked while its runtime was
   * missing. When the download settles as done, it is created on the newest
   * runtime that now runs it; with nothing picked, the toast offers a Duo.
   */
  const installThenCreateRef = useRef<string | null>(null);
  const announceSettled = useCallback((install: AppleRuntimeInstallState) => {
    const wanted = installThenCreateRef.current;
    installThenCreateRef.current = null;
    onSettledRef.current?.(install);
    if (install.phase === "failed") {
      showToast({
        id: "apple-runtime-install",
        tone: "error",
        title: `iOS ${install.version} didn't install`,
        message: install.message ?? undefined,
        durationMs: READABLE_TOAST_DURATION_MS,
      });
      return;
    }
    if (install.phase !== "done") return;
    void window.ade.iosSimulator.runtimeList(runtimePinRef.current).then((next) => {
      const target = newestAppleRuntimeRunning(next.runtimes, wanted);
      const model = target?.deviceTypes.find((type) => type.identifier === wanted) ?? null;
      if (target && model) {
        showToast({ id: "apple-runtime-install", tone: "success", title: `iOS ${install.version} is installed`, message: `Creating ${model.name}…` });
        createDeviceRef.current({ runtime: target.runtimeIdentifier, deviceType: model.identifier });
        return;
      }
      const duo = next.runtimes.flatMap((entry) => entry.deviceTypes.map((type) => ({ entry, type })))
        .find(({ type }) => appleDeviceSupportsDuo({ deviceTypeIdentifier: type.identifier })) ?? null;
      showToast({
        id: "apple-runtime-install",
        tone: "success",
        title: `iOS ${install.version} is installed`,
        ...(duo ? {
          actions: [{
            label: `Create ${duo.type.name}`,
            onClick: () => createDeviceRef.current({ runtime: duo.entry.runtimeIdentifier, deviceType: duo.type.identifier }),
          }],
        } : {}),
      });
    }).catch((cause: unknown) => onErrorRef.current?.(cause));
  }, [runtimePinRef]);
  const scope = laneId ? { laneId } : {};
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** The last install we saw, to notice it settle whether an event or a re-read said so. */
  const lastInstallRef = useRef<AppleRuntimeInstallState | null>(null);
  const lastInstallAtRef = useRef(0);

  /**
   * Every install state we hear, from an event, a list read or the start call:
   * remember it, and announce it once when a running install stops running.
   * Returns whether this one settled it.
   */
  const noteInstall = useCallback((install: AppleRuntimeInstallState | null): boolean => {
    const was = lastInstallRef.current;
    lastInstallRef.current = install;
    lastInstallAtRef.current = Date.now();
    const settled = Boolean(install && appleRuntimeInstallActive(was) && !appleRuntimeInstallActive(install));
    if (settled) announceSettled(install!);
    return settled;
  }, [announceSettled]);

  const noteInventory = useCallback((next: AppleRuntimeInventory) => {
    setInventory(next);
    noteInstall(next.install);
  }, [noteInstall]);

  const reload = useCallback(() => {
    const ticket = ++readTicket.current;
    void window.ade.iosSimulator.runtimeList(runtimePinRef.current)
      .then((next) => {
        if (ticket === readTicket.current) noteInventory(next);
      })
      .catch((cause: unknown) => {
        if (ticket === readTicket.current) onErrorRef.current?.(cause);
      });
  }, [noteInventory, runtimePinRef]);

  useEffect(() => {
    if (!enabled) return;
    reload();
  }, [enabled, pinKey, refreshNonce, reload]);

  useEffect(() => {
    if (!enabled) return;
    return window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "apple.runtime.install") return;
      setInventory((current) => (current ? { ...current, install: event.install } : current));
      if (noteInstall(event.install)) reload();
    }, runtimePinRef.current);
  }, [enabled, noteInstall, pinKey, reload, runtimePinRef]);

  const installRunning = appleRuntimeInstallActive(inventory?.install);
  useEffect(() => {
    if (!enabled || !installRunning) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastInstallAtRef.current >= INSTALL_QUIET_REREAD_MS) reload();
    }, INSTALL_QUIET_REREAD_MS);
    return () => window.clearInterval(timer);
  }, [enabled, installRunning, reload]);

  const install = useCallback(async (version?: string | null) => {
    try {
      const started = await window.ade.iosSimulator.runtimeInstall(
        version ? { ...scopeRef.current, version } : scopeRef.current,
        runtimePinRef.current,
      );
      const was = lastInstallRef.current;
      // An install that failed before it ran (no SDK, too little space) comes
      // back already settled, with no event to say so on the web client.
      if (!noteInstall(started) && !appleRuntimeInstallActive(started) && started.startedAt !== was?.startedAt) {
        announceSettled(started);
      }
      setInventory((current) => (current ? { ...current, install: started } : current));
    } catch (cause) {
      onErrorRef.current?.(cause);
    }
  }, [announceSettled, noteInstall, runtimePinRef]);

  const cancelInstall = useCallback(() => {
    void window.ade.iosSimulator.runtimeInstallCancel(scopeRef.current, runtimePinRef.current)
      .then((state) => setInventory((current) => (current ? { ...current, install: state } : current)))
      .catch((cause: unknown) => onErrorRef.current?.(cause));
  }, [runtimePinRef]);

  /**
   * CoreSimulator unmounts a deleted runtime a moment after `simctl runtime
   * delete` returns, so a list read straight away can still show it. Re-read
   * until the removed runtimes are gone (a few seconds at most).
   */
  const reloadUntilGone = useCallback(async (removedIds: string[]) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = await window.ade.iosSimulator.runtimeList(runtimePinRef.current).catch((cause: unknown) => {
        onErrorRef.current?.(cause);
        return null;
      });
      if (next) noteInventory(next);
      if (!next || !next.runtimes.some((entry) => entry.id && removedIds.includes(entry.id))) return;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }, [noteInventory, runtimePinRef]);

  const runRemoval = useCallback(async (call: () => Promise<AppleRuntimeDeleteResult>) => {
    setRemoving(true);
    let result: AppleRuntimeDeleteResult | null = null;
    try {
      result = await call();
      return result;
    } catch (cause) {
      onErrorRef.current?.(cause);
      return null;
    } finally {
      await reloadUntilGone(result?.deleted.map((entry) => entry.id) ?? []);
      setRemoving(false);
    }
  }, [reloadUntilGone]);

  const remove = useCallback((id: string, simulators: AppleRuntimeSimulatorDisposition) => runRemoval(() =>
    window.ade.iosSimulator.runtimeDelete({ ...scopeRef.current, id, simulators, confirmedByUser: true }, runtimePinRef.current)), [runRemoval, runtimePinRef]);

  const prune = useCallback((simulators: AppleRuntimeSimulatorDisposition) => runRemoval(() =>
    window.ade.iosSimulator.runtimePrune({ ...scopeRef.current, simulators, confirmedByUser: true }, runtimePinRef.current)), [runRemoval, runtimePinRef]);

  const runXcodeSetup = useCallback(async () => {
    try {
      const xcode = await window.ade.iosSimulator.xcodeRunFirstLaunch({ ...scopeRef.current, confirmedByUser: true }, runtimePinRef.current);
      setInventory((current) => (current ? { ...current, xcode } : current));
    } catch (cause) {
      onErrorRef.current?.(cause);
    }
  }, [runtimePinRef]);

  const inventoryRef = useRef(inventory);
  inventoryRef.current = inventory;
  const installAndCreate = useCallback((deviceType: string) => {
    installThenCreateRef.current = deviceType;
    // Pin the runtime this model needs when the brain knows it: with iOS 27.1
    // installed (it runs only the Duo) an iPhone 17 needs iOS 27.0, and an
    // unpinned install asks Xcode for its SDK's 27.1 again.
    const group = inventoryRef.current?.missing?.runtimes
      ?.find((entry) => entry.deviceTypes.some((type) => type.identifier === deviceType)) ?? null;
    void install(group?.installVersion ?? null);
  }, [install]);

  return { inventory, removing, install, cancelInstall, remove, prune, runXcodeSetup, installAndCreate };
}
