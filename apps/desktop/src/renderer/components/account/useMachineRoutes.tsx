import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AdeAccountMachine, MachineConnectionRoutes } from "../../../shared/types";
import { machineRouteItems, type MachineRouteItem } from "./machineRouteModel";
import { MachineRoutesPanel, RelayOffDialog, type RelaySwitchModel } from "./MachineRoutes";
import { PrivateNetworkSection } from "./PrivateNetworkSection";
import { Banner } from "../ui/notice";

export type MachineRoutesState =
  | { status: "loading"; routes: MachineConnectionRoutes | null }
  | { status: "ready"; routes: MachineConnectionRoutes }
  | { status: "error"; routes: MachineConnectionRoutes | null; message: string };

/** The parts of a "Your computers" row the route controls read. */
export type RoutesRow = {
  key: string;
  name: string;
  thisMac: boolean;
  /** This window holds a live channel to it. */
  connected: boolean;
  accountMachine: AdeAccountMachine | null;
};

/** True where this ADE can read computers' routes (not the hosted web client). */
export function routesAvailable(): boolean {
  return typeof window.ade?.account?.getConnectionRoutes === "function";
}

/** This computer's routes are read through its own brain; the key is "local". */
const LOCAL_ROUTES_KEY = "local";
const ROUTES_REFRESH_MS = 30_000;

function accountApi() {
  return window.ade?.account;
}

function routesKey(row: RoutesRow): string | null {
  return row.thisMac ? LOCAL_ROUTES_KEY : row.accountMachine?.machineKey ?? null;
}

/**
 * Live routes per computer, read from each computer itself, plus the relay
 * switch that changes them. `load(null)` reads this computer; a machine key
 * reads another over its paired connection. A per-key generation keeps an
 * older read from landing on top of a newer one (or of a switch change).
 */
function useMachineRoutesState() {
  const [byKey, setByKey] = useState<Record<string, MachineRoutesState>>({});
  const generation = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const begin = useCallback((key: string): number => {
    const next = (generation.current.get(key) ?? 0) + 1;
    generation.current.set(key, next);
    return next;
  }, []);
  const isLatest = (key: string, attempt: number) => mounted.current && generation.current.get(key) === attempt;

  const load = useCallback(async (machineKey: string | null, options?: { refresh?: boolean }) => {
    const getRoutes = accountApi()?.getConnectionRoutes;
    if (!getRoutes) return;
    const key = machineKey ?? LOCAL_ROUTES_KEY;
    const attempt = begin(key);
    setByKey((previous) => ({ ...previous, [key]: { status: "loading", routes: previous[key]?.routes ?? null } }));
    try {
      const routes = await getRoutes({ machineKey, ...(options?.refresh ? { refresh: true } : {}) });
      if (isLatest(key, attempt)) setByKey((previous) => ({ ...previous, [key]: { status: "ready", routes } }));
    } catch (error) {
      if (!isLatest(key, attempt)) return;
      const message = error instanceof Error && error.message ? error.message : "Routes unavailable right now.";
      setByKey((previous) => ({ ...previous, [key]: { status: "error", routes: previous[key]?.routes ?? null, message } }));
    }
  }, [begin]);

  const setRelayEnabled = useCallback(async (machineKey: string | null, enabled: boolean) => {
    const setRelay = accountApi()?.setRelayEnabled;
    if (!setRelay) throw new Error("This ADE can't change ADE Relay.");
    const key = machineKey ?? LOCAL_ROUTES_KEY;
    const attempt = begin(key);
    const routes = await setRelay({ machineKey, enabled });
    if (isLatest(key, attempt)) setByKey((previous) => ({ ...previous, [key]: { status: "ready", routes } }));
  }, [begin]);

  return { byKey, load, setRelayEnabled };
}

/**
 * Everything the Account page shows about how computers connect: the
 * Private network section, each row's route pills and details, the ADE Relay
 * switch and its warning. `YourMacsCard` only places what this returns.
 */
export function useMachineRoutesControl(args: {
  enabled: boolean;
  rows: RoutesRow[];
  machines: AdeAccountMachine[];
  /** Machine keys this window reaches through ADE Relay right now. */
  relayRoutedKeys: ReadonlySet<string>;
  /** Re-read the account directory (its endpoints follow a relay change). */
  reloadMachines: () => void;
}) {
  const { enabled, rows, machines, relayRoutedKeys, reloadMachines } = args;
  const { byKey, load, setRelayEnabled } = useMachineRoutesState();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [pendingOff, setPendingOff] = useState<RoutesRow | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);
  const later = useCallback((run: () => void, ms: number) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  // This computer: on open, on focus, and every 30 seconds while visible. The
  // brain caches Tailscale's answer for a minute, so this is one local RPC.
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(null);
    };
    refresh();
    const interval = window.setInterval(refresh, ROUTES_REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, load]);

  // A computer this window holds a live channel to reports its own routes,
  // including whether its owner turned ADE Relay off. Read once per
  // connection; expanding the row reads again.
  const connectedKeys = useMemo(
    () => rows
      .filter((row) => !row.thisMac && row.connected && row.accountMachine)
      .map((row) => row.accountMachine!.machineKey)
      .sort()
      .join(","),
    [rows],
  );
  useEffect(() => {
    if (!enabled || !connectedKeys) return;
    for (const machineKey of connectedKeys.split(",")) void load(machineKey);
  }, [connectedKeys, enabled, load]);

  const stateFor = useCallback((row: RoutesRow) => {
    const key = routesKey(row);
    return key ? byKey[key] : undefined;
  }, [byKey]);

  const changeRelay = useCallback(async (row: RoutesRow, on: boolean) => {
    const machineKey = row.thisMac ? null : row.accountMachine?.machineKey ?? null;
    if (!row.thisMac && !machineKey) return;
    setBusyKey(row.key);
    setRelayError(null);
    try {
      await setRelayEnabled(machineKey, on);
      setPendingOff(null);
      // The relay connection opens within a second or two, and the directory
      // drops or regains the relay endpoint on the machine's next publish.
      if (on) later(() => void load(machineKey), 2_500);
      later(reloadMachines, 4_000);
    } catch (error) {
      setRelayError(error instanceof Error && error.message ? error.message : "Couldn't change ADE Relay.");
    } finally {
      setBusyKey(null);
    }
  }, [later, load, reloadMachines, setRelayEnabled]);

  const routeItemsFor = useCallback((row: RoutesRow): MachineRouteItem[] =>
    row.accountMachine ? machineRouteItems(row.accountMachine, enabled ? stateFor(row)?.routes ?? null : null) : [],
  [enabled, stateFor]);

  const relaySwitchFor = useCallback((row: RoutesRow): RelaySwitchModel | null => {
    const machine = row.accountMachine;
    if (!enabled || !machine) return null;
    const state = stateFor(row);
    const routes = state?.routes ?? null;
    return {
      machineLabel: row.thisMac ? "this computer" : row.name,
      enabled: routes?.relay.enabled ?? machine.reachableEndpoints.some((endpoint) => endpoint.kind === "relay"),
      unavailableReason: !row.thisMac && !row.connected
        ? "Connect to this computer to change its relay setting."
        : routes
          ? null
          : state?.status === "error" ? state.message : "Checking this computer…",
      busy: busyKey === row.key,
      onChange: (on) => {
        setRelayError(null);
        if (on) void changeRelay(row, true);
        else setPendingOff(row);
      },
    };
  }, [busyKey, changeRelay, enabled, stateFor]);

  /** The Connection block of an expanded row. */
  const routesPanelFor = useCallback((row: RoutesRow): ReactNode => {
    const items = routeItemsFor(row);
    if (items.length === 0) return null;
    const live = enabled && stateFor(row)?.routes != null;
    return (
      <>
        <MachineRoutesPanel
          items={items}
          relay={relaySwitchFor(row)}
          note={live || row.thisMac || row.connected ? null : "From your account. Connect to this computer for live details."}
        />
        {relayError && pendingOff == null && busyKey == null ? (
          <Banner
            layout="inline"
            model={{ id: "relay-switch-error", tone: "error", title: relayError, report: { surface: "account_relay_switch" } }}
          />
        ) : null}
      </>
    );
  }, [busyKey, enabled, pendingOff, relayError, relaySwitchFor, routeItemsFor, stateFor]);

  const onExpand = useCallback((row: RoutesRow) => {
    if (enabled && (row.thisMac || row.connected)) void load(routesKey(row) === LOCAL_ROUTES_KEY ? null : row.accountMachine?.machineKey ?? null);
  }, [enabled, load]);

  const privateNetwork = enabled ? (
    <PrivateNetworkSection
      state={byKey[LOCAL_ROUTES_KEY]}
      machines={machines}
      onRecheck={() => {
        void load(null, { refresh: true });
        reloadMachines();
      }}
    />
  ) : null;

  const pendingRoutes = pendingOff ? stateFor(pendingOff)?.routes ?? null : null;
  const relayDialog = pendingOff ? (
    <RelayOffDialog
      machineName={pendingOff.name}
      isThisComputer={pendingOff.thisMac}
      connectedViaRelay={!pendingOff.thisMac && relayRoutedKeys.has(pendingOff.accountMachine?.machineKey ?? "")}
      httpsReady={pendingRoutes?.tailnetHttps.state === "published"}
      tailscaleReady={pendingRoutes?.tailscale.state === "running"}
      busy={busyKey === pendingOff.key}
      error={relayError}
      onConfirm={() => void changeRelay(pendingOff, false)}
      onCancel={() => {
        setPendingOff(null);
        setRelayError(null);
      }}
    />
  ) : null;

  return { privateNetwork, relayDialog, routeItemsFor, routesPanelFor, onExpand };
}
