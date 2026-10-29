import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineConnectionRoutes } from "../../../shared/types";
import { parseMachineConnectionRoutes } from "../../../shared/machineConnectionRoutes";

export type MachineRoutesState =
  | { status: "loading"; routes: MachineConnectionRoutes | null }
  | { status: "ready"; routes: MachineConnectionRoutes }
  | { status: "error"; routes: MachineConnectionRoutes | null; message: string };

type RoutesBridge = {
  getConnectionRoutes?: (args?: { machineKey?: string | null; refresh?: boolean }) => Promise<MachineConnectionRoutes>;
  setRelayEnabled?: (args: { machineKey?: string | null; enabled: boolean }) => Promise<MachineConnectionRoutes>;
};

function routesBridge(): RoutesBridge | undefined {
  return (window.ade as typeof window.ade & { account?: RoutesBridge } | undefined)?.account;
}

/** This computer's routes are read through its own brain; the key is "local". */
export const LOCAL_ROUTES_KEY = "local";

export function routesAvailable(): boolean {
  return typeof routesBridge()?.getConnectionRoutes === "function";
}

/**
 * Live connection routes per computer, read from each computer itself.
 *
 * `load(null)` reads this computer; `load(machineKey)` reads another over its
 * paired connection. Nothing polls here: the caller decides when a read is
 * worth it (page open, focus, expanding a row, a "Check again" press).
 */
export function useMachineRoutes() {
  const [byKey, setByKey] = useState<Record<string, MachineRoutesState>>({});
  const inFlight = useRef(new Map<string, Promise<MachineConnectionRoutes | null>>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const put = useCallback((key: string, next: MachineRoutesState) => {
    if (!mounted.current) return;
    setByKey((previous) => ({ ...previous, [key]: next }));
  }, []);

  const load = useCallback(
    async (machineKey: string | null, options?: { refresh?: boolean }): Promise<MachineConnectionRoutes | null> => {
      const bridge = routesBridge();
      const key = machineKey ?? LOCAL_ROUTES_KEY;
      if (!bridge?.getConnectionRoutes) return null;
      const existing = inFlight.current.get(key);
      if (existing && !options?.refresh) return await existing;
      setByKey((previous) => {
        const prior = previous[key];
        return { ...previous, [key]: { status: "loading", routes: prior?.routes ?? null } };
      });
      const request = (async () => {
        try {
          const raw = await bridge.getConnectionRoutes!({
            machineKey,
            ...(options?.refresh ? { refresh: true } : {}),
          });
          const routes = parseMachineConnectionRoutes(raw);
          if (!routes) throw new Error("ADE couldn't read this computer's routes.");
          put(key, { status: "ready", routes });
          return routes;
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : "Routes unavailable right now.";
          setByKey((previous) => ({
            ...previous,
            [key]: { status: "error", routes: previous[key]?.routes ?? null, message },
          }));
          return null;
        } finally {
          inFlight.current.delete(key);
        }
      })();
      inFlight.current.set(key, request);
      return await request;
    },
    [put],
  );

  const setRelayEnabled = useCallback(
    async (machineKey: string | null, enabled: boolean): Promise<void> => {
      const bridge = routesBridge();
      if (!bridge?.setRelayEnabled) throw new Error("This ADE can't change ADE Relay.");
      const key = machineKey ?? LOCAL_ROUTES_KEY;
      const raw = await bridge.setRelayEnabled({ machineKey, enabled });
      const routes = parseMachineConnectionRoutes(raw);
      if (routes) put(key, { status: "ready", routes });
      // The relay connection opens or closes within a second or two; read
      // again so the row says "Connected" rather than "Connecting".
      if (enabled) {
        window.setTimeout(() => void load(machineKey), 2_500);
      }
    },
    [load, put],
  );

  return { byKey, load, setRelayEnabled };
}
