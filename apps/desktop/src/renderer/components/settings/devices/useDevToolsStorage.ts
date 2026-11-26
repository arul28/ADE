import React from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AndroidAvd } from "../../../../shared/types/androidEmulator";
import type {
  AppleDeviceListResult,
  AppleInstalledSimulator,
  AppleRuntimeInventory,
  AppleSimulatorOwnershipInfo,
  XcodeDerivedDataResult,
} from "../../../../shared/types/iosSimulator";

/**
 * What developer tools keep on one machine's disk, outside any project:
 * Apple simulators, simulator runtimes, Xcode's build data, Android emulators.
 * Settings › Apple devices, Android devices and Storage read it.
 *
 * Every call carries `pin`, the machine the page is about, so a laptop can
 * look at and clean up a Mac Studio. The reads that walk folders (simulator
 * sizes, build data, emulator sizes) run once when the page opens and again
 * after a change or on Refresh; nothing here polls. Each part loads and fails
 * on its own, so a slow walk never holds the rest of the page.
 */

export type DevToolsPart<T> = { data: T | null; loading: boolean; error: string | null };

/** One simulator as the storage list shows it: who it belongs to and what it costs. */
export type SimulatorRow = {
  sim: AppleInstalledSimulator;
  bytes: number | null;
  /** The lane holding it, by name; null when no lane does. */
  laneName: string | null;
  laneHeld: boolean;
  ownership: AppleSimulatorOwnershipInfo["ownership"] | null;
  /** Who it belongs to, in a word or two. */
  owner: string;
  /** Why it cannot be deleted here, or null when it can. */
  deleteBlocked: string | null;
};

export type DevToolsStorage = {
  simulators: DevToolsPart<SimulatorRow[]> & { totalBytes: number | null; measuring: boolean };
  runtimes: DevToolsPart<AppleRuntimeInventory>;
  buildData: DevToolsPart<XcodeDerivedDataResult>;
  emulators: DevToolsPart<AndroidAvd[]>;
  refresh: () => void;
  refreshApple: () => void;
  refreshAndroid: () => void;
};

const EMPTY = { data: null, loading: false, error: null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Who a simulator belongs to, in the words the list uses. */
export function simulatorOwner(laneName: string | null, laneHeld: boolean, ownership: AppleSimulatorOwnershipInfo["ownership"] | null): string {
  if (laneHeld) return laneName ? `Lane: ${laneName}` : "A lane";
  switch (ownership) {
    case "ade-orphan": return "ADE, no lane";
    case "ade-kept": return "ADE, kept";
    case "ade-other-project": return "ADE, other project";
    default: return "Yours";
  }
}

export function buildSimulatorRows(list: AppleDeviceListResult, measured: AppleDeviceListResult | null): SimulatorRow[] {
  const bytesOf = new Map((measured?.disk?.devices ?? []).map((entry) => [entry.udid, entry.bytes]));
  const ownershipOf = new Map((measured?.ownership ?? []).map((entry) => [entry.udid, entry.ownership]));
  const ownerOf = new Map(list.owners.map((owner) => [owner.udid, owner]));
  return list.installed
    .map((sim): SimulatorRow => {
      const holder = ownerOf.get(sim.udid) ?? null;
      const ownership = ownershipOf.get(sim.udid) ?? null;
      const laneHeld = holder != null || ownership === "lane";
      const booted = sim.state.toLowerCase() === "booted";
      return {
        sim,
        bytes: bytesOf.get(sim.udid) ?? null,
        laneName: holder?.laneName ?? null,
        laneHeld,
        ownership,
        owner: simulatorOwner(holder?.laneName ?? null, laneHeld, ownership),
        deleteBlocked: laneHeld
          ? "A lane uses it. Delete it from that lane's Apple pane."
          : booted
            ? "It is running. Turn it off first."
            : null,
      };
    })
    // Biggest first: this is a list for finding space.
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.sim.name.localeCompare(b.sim.name));
}

export function useDevToolsStorage({
  pin,
  apple,
  android,
  measure = true,
}: {
  pin: OpenProjectBinding | null;
  /** Read the Apple parts (a Mac). */
  apple: boolean;
  /** Read the Android emulators. */
  android: boolean;
  /** Walk folders for sizes. Off, only the lists load. */
  measure?: boolean;
}): DevToolsStorage {
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [appleNonce, setAppleNonce] = React.useState(0);
  const [androidNonce, setAndroidNonce] = React.useState(0);
  const [simulators, setSimulators] = React.useState<DevToolsStorage["simulators"]>({ ...EMPTY, totalBytes: null, measuring: false });
  const [runtimes, setRuntimes] = React.useState<DevToolsPart<AppleRuntimeInventory>>(EMPTY);
  const [buildData, setBuildData] = React.useState<DevToolsPart<XcodeDerivedDataResult>>(EMPTY);
  const [emulators, setEmulators] = React.useState<DevToolsPart<AndroidAvd[]>>(EMPTY);

  React.useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!apple || !api) {
      setSimulators({ ...EMPTY, totalBytes: null, measuring: false });
      setRuntimes(EMPTY);
      setBuildData(EMPTY);
      return;
    }
    let cancelled = false;
    const target = pinRef.current;
    // Simulators: the list paints first; the disk walk fills sizes in after.
    setSimulators((current) => ({ ...current, loading: current.data == null, error: null }));
    void api.deviceList({ installed: true }, target)
      .then(async (list) => {
        if (cancelled) return;
        setSimulators((current) => ({
          data: buildSimulatorRows(list, null).map((row) => ({ ...row, bytes: current.data?.find((old) => old.sim.udid === row.sim.udid)?.bytes ?? null })),
          loading: false,
          error: null,
          totalBytes: current.totalBytes,
          measuring: measure && list.installed.length > 0,
        }));
        if (!measure || list.installed.length === 0) return;
        try {
          const measured = await api.deviceList({ installed: false, disk: true }, target);
          if (cancelled) return;
          setSimulators({ data: buildSimulatorRows(list, measured), loading: false, error: null, totalBytes: measured.disk?.totalBytes ?? null, measuring: false });
        } catch {
          // A failed walk costs the sizes, never the list.
          if (!cancelled) setSimulators((current) => ({ ...current, measuring: false }));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setSimulators({ data: null, loading: false, error: message(error), totalBytes: null, measuring: false });
      });
    setRuntimes((current) => ({ ...current, loading: current.data == null, error: null }));
    void api.runtimeList(target)
      .then((data) => { if (!cancelled) setRuntimes({ data, loading: false, error: null }); })
      .catch((error: unknown) => { if (!cancelled) setRuntimes({ data: null, loading: false, error: message(error) }); });
    if (typeof api.derivedDataList === "function") {
      setBuildData((current) => ({ ...current, loading: true, error: null }));
      void api.derivedDataList({ measure }, target)
        .then((data) => { if (!cancelled) setBuildData({ data, loading: false, error: null }); })
        .catch((error: unknown) => { if (!cancelled) setBuildData({ data: null, loading: false, error: message(error) }); });
    } else {
      // An older ADE on that machine has no build-data call.
      setBuildData({ data: null, loading: false, error: "Update ADE on this machine to see Xcode build data." });
    }
    return () => {
      cancelled = true;
    };
  }, [apple, appleNonce, measure, pinKey]);

  React.useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!android || !api) {
      setEmulators(EMPTY);
      return;
    }
    let cancelled = false;
    setEmulators((current) => ({ ...current, loading: current.data == null, error: null }));
    void api.listDevices({ measureSizes: measure }, pinRef.current)
      .then((result) => {
        if (cancelled) return;
        const avds = [...result.avds].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
        setEmulators({ data: avds, loading: false, error: null });
      })
      .catch((error: unknown) => { if (!cancelled) setEmulators({ data: null, loading: false, error: message(error) }); });
    return () => {
      cancelled = true;
    };
  }, [android, androidNonce, measure, pinKey]);

  const refreshApple = React.useCallback(() => setAppleNonce((value) => value + 1), []);
  const refreshAndroid = React.useCallback(() => setAndroidNonce((value) => value + 1), []);
  const refresh = React.useCallback(() => {
    refreshApple();
    refreshAndroid();
  }, [refreshAndroid, refreshApple]);

  return { simulators, runtimes, buildData, emulators, refresh, refreshApple, refreshAndroid };
}

/** The bytes each part costs, null while unknown. */
export function devToolsTotals(storage: DevToolsStorage): {
  simulators: number | null;
  runtimes: number | null;
  buildData: number | null;
  emulators: number | null;
} {
  const runtimes = storage.runtimes.data?.runtimes;
  const avds = storage.emulators.data;
  return {
    simulators: storage.simulators.totalBytes,
    runtimes: runtimes ? runtimes.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0) : null,
    buildData: storage.buildData.data?.totalBytes ?? null,
    emulators: avds && avds.some((avd) => avd.sizeBytes != null) ? avds.reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0) : null,
  };
}
