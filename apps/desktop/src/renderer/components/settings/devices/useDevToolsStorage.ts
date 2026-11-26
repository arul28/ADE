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
 * look at and clean up a Mac Studio. When the machine changes, everything
 * read from the last one is dropped at once: a row on screen always belongs
 * to the machine named above it, so its Delete goes where the person thinks.
 *
 * The reads that walk folders (simulator sizes, build data, emulator sizes)
 * run only with `measure`, once when the page opens and again after a change
 * or on Refresh; nothing here polls. Each part loads and fails on its own.
 */

export type DevToolsPart<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

/** One simulator as the storage list shows it: who it belongs to and what it costs. */
export type SimulatorRow = {
  sim: AppleInstalledSimulator;
  bytes: number | null;
  laneHeld: boolean;
  ownership: AppleSimulatorOwnershipInfo["ownership"] | null;
  /** Who it belongs to, in a word or two. */
  owner: string;
  /** Why it cannot be deleted here, or null when it can. */
  deleteBlocked: string | null;
};

export type DevToolsStorage = {
  simulators: DevToolsPart<SimulatorRow[]> & {
    /** Every byte under CoreSimulator's device store, once measured. */
    totalBytes: number | null;
    measuring: boolean;
    /** The size walk failed: the list stands, its sizes do not. */
    measureFailed: boolean;
  };
  runtimes: DevToolsPart<AppleRuntimeInventory>;
  buildData: DevToolsPart<XcodeDerivedDataResult>;
  emulators: DevToolsPart<AndroidAvd[]>;
  refresh: () => void;
  refreshApple: () => void;
  refreshAndroid: () => void;
};

/** What one part costs, and whether that number can be trusted yet. */
export type DevToolsPartSize = { bytes: number | null; state: "unmeasured" | "measuring" | "ready" | "failed" };

const EMPTY = { data: null, loading: false, error: null };
const EMPTY_SIMULATORS: DevToolsStorage["simulators"] = { ...EMPTY, totalBytes: null, measuring: false, measureFailed: false };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Who a simulator belongs to, in the words the list uses. */
function simulatorOwner(laneName: string | null, laneHeld: boolean, ownership: AppleSimulatorOwnershipInfo["ownership"] | null): string {
  if (laneHeld) return laneName ? `Lane: ${laneName}` : "A lane";
  switch (ownership) {
    case "ade-orphan": return "ADE, no lane";
    case "ade-kept": return "ADE, kept";
    case "ade-other-project": return "ADE, other project";
    default: return "Yours";
  }
}

function buildSimulatorRows(list: AppleDeviceListResult, measured: AppleDeviceListResult | null): SimulatorRow[] {
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
        laneHeld,
        ownership,
        owner: simulatorOwner(holder?.laneName ?? null, laneHeld, ownership),
        deleteBlocked: laneHeld
          ? "A lane uses it. Delete it from that lane's Apple pane."
          : ownership === "ade-other-project"
            ? "ADE made it for another project, whose lane may use it. Delete it from that project."
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
  /** Walk folders for sizes. Off, only the lists load (cheap). */
  measure?: boolean;
}): DevToolsStorage {
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [appleNonce, setAppleNonce] = React.useState(0);
  const [androidNonce, setAndroidNonce] = React.useState(0);
  const [simulators, setSimulators] = React.useState<DevToolsStorage["simulators"]>(EMPTY_SIMULATORS);
  const [runtimes, setRuntimes] = React.useState<DevToolsPart<AppleRuntimeInventory>>(EMPTY);
  const [buildData, setBuildData] = React.useState<DevToolsPart<XcodeDerivedDataResult>>(EMPTY);
  const [emulators, setEmulators] = React.useState<DevToolsPart<AndroidAvd[]>>(EMPTY);
  // Which machine the parts on screen came from; another one empties them first.
  const appleLoadedFor = React.useRef<string | null | undefined>(undefined);
  const androidLoadedFor = React.useRef<string | null | undefined>(undefined);

  React.useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!apple || !api) {
      setSimulators(EMPTY_SIMULATORS);
      setRuntimes(EMPTY);
      setBuildData(EMPTY);
      appleLoadedFor.current = undefined;
      return;
    }
    let cancelled = false;
    const target = pinRef.current;
    const sameMachine = appleLoadedFor.current === pinKey;
    appleLoadedFor.current = pinKey;
    // A refresh keeps the rows (no flash); a new machine starts from nothing.
    setSimulators((current) => (sameMachine ? { ...current, loading: current.data == null, error: null } : { ...EMPTY_SIMULATORS, loading: true }));
    setRuntimes((current) => (sameMachine ? { ...current, loading: current.data == null, error: null } : { ...EMPTY, loading: true }));
    setBuildData((current) => (sameMachine ? { ...current, loading: true, error: null } : { ...EMPTY, loading: true }));

    // Simulators: the list paints first; the disk walk fills sizes in after.
    void api.deviceList({ installed: true }, target)
      .then(async (list) => {
        if (cancelled) return;
        const walk = measure && list.installed.length > 0;
        setSimulators((current) => ({
          data: buildSimulatorRows(list, null).map((row) => ({ ...row, bytes: current.data?.find((old) => old.sim.udid === row.sim.udid)?.bytes ?? null })),
          loading: false,
          error: null,
          // Nothing installed costs nothing; that is a size, not a wait.
          totalBytes: list.installed.length === 0 ? 0 : current.totalBytes,
          measuring: walk,
          measureFailed: false,
        }));
        if (!walk) return;
        try {
          const measured = await api.deviceList({ installed: false, disk: true }, target);
          if (cancelled) return;
          setSimulators({ data: buildSimulatorRows(list, measured), loading: false, error: null, totalBytes: measured.disk?.totalBytes ?? null, measuring: false, measureFailed: measured.disk == null });
        } catch (error) {
          // A failed walk costs the sizes, never the list.
          console.warn("[settings] simulator sizes could not be read", message(error));
          if (!cancelled) setSimulators((current) => ({ ...current, measuring: false, measureFailed: true }));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setSimulators({ ...EMPTY_SIMULATORS, error: message(error) });
      });
    void api.runtimeList(target)
      .then((data) => { if (!cancelled) setRuntimes({ data, loading: false, error: null }); })
      .catch((error: unknown) => { if (!cancelled) setRuntimes({ data: null, loading: false, error: message(error) }); });
    void api.derivedDataList({ measure }, target)
      .then((data) => { if (!cancelled) setBuildData({ data, loading: false, error: null }); })
      .catch((error: unknown) => { if (!cancelled) setBuildData({ data: null, loading: false, error: message(error) }); });
    return () => {
      cancelled = true;
    };
  }, [apple, appleNonce, measure, pinKey]);

  React.useEffect(() => {
    const api = window.ade?.androidEmulator;
    if (!android || !api) {
      setEmulators(EMPTY);
      androidLoadedFor.current = undefined;
      return;
    }
    let cancelled = false;
    const sameMachine = androidLoadedFor.current === pinKey;
    androidLoadedFor.current = pinKey;
    setEmulators((current) => (sameMachine ? { ...current, loading: current.data == null, error: null } : { ...EMPTY, loading: true }));
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

/**
 * What each part costs. An empty or absent part is 0 (a size, not a wait); a
 * part that errored, or whose walk failed, is `failed` so a page never shows
 * "Measuring…" for something that will not come.
 */
export function devToolsSizes(storage: DevToolsStorage, measured = true): {
  simulators: DevToolsPartSize;
  runtimes: DevToolsPartSize;
  buildData: DevToolsPartSize;
  emulators: DevToolsPartSize;
} {
  if (!measured) {
    // Lists only: a part not sized yet waits for the person's Measure, not for a walk.
    const sized = devToolsSizes(storage, true);
    const wait = (part: DevToolsPartSize, error: string | null): DevToolsPartSize =>
      part.state === "ready" || error ? part : { bytes: null, state: "unmeasured" };
    return {
      simulators: wait(sized.simulators, storage.simulators.error),
      runtimes: sized.runtimes,
      buildData: wait(sized.buildData, storage.buildData.error),
      emulators: wait(sized.emulators, storage.emulators.error),
    };
  }
  const { simulators, runtimes, buildData, emulators } = storage;
  const sims: DevToolsPartSize = simulators.error || simulators.measureFailed
    ? { bytes: null, state: "failed" }
    : simulators.totalBytes != null
      ? { bytes: simulators.totalBytes, state: "ready" }
      : { bytes: null, state: "measuring" };
  // Runtimes and the old downloads macOS still keeps: both take the disk.
  const runtimeSizes = runtimes.data ? [...runtimes.data.runtimes, ...(runtimes.data.leftovers ?? [])].map((entry) => entry.sizeBytes) : null;
  const rts: DevToolsPartSize = runtimes.error
    ? { bytes: null, state: "failed" }
    : runtimeSizes
      ? { bytes: runtimeSizes.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0), state: runtimeSizes.every((bytes) => bytes != null) ? "ready" : "failed" }
      : { bytes: null, state: "measuring" };
  const build = buildData.data;
  const bd: DevToolsPartSize = buildData.error
    ? { bytes: null, state: "failed" }
    : build && (!build.exists || build.entries.length === 0)
      ? { bytes: 0, state: "ready" }
      : build?.totalBytes != null
        ? { bytes: build.totalBytes, state: "ready" }
        : buildData.loading
          ? { bytes: null, state: "measuring" }
          : { bytes: null, state: build ? "failed" : "measuring" };
  const avds = emulators.data;
  const emu: DevToolsPartSize = emulators.error
    ? { bytes: null, state: "failed" }
    : avds
      ? { bytes: avds.reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0), state: avds.every((avd) => avd.sizeBytes != null) ? "ready" : "failed" }
      : { bytes: null, state: "measuring" };
  return { simulators: sims, runtimes: rts, buildData: bd, emulators: emu };
}
