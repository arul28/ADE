/**
 * The inputs `buildReachableGroups` needs, read once per surface.
 *
 * Settings and the composer picker both mount this. Every call carries the
 * surface's machine (`pin`, null = the tab's binding), because the sources are
 * machine facts: which OpenCode providers are signed in, which keys are stored,
 * which subscriptions the proxy holds.
 *
 * Tolerant by design: an older preload without `listHarnessRoutes` or without
 * `proxy` yields empty groups, never an exception.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { HarnessPresetBody } from "../../../../shared/harnessPresets";
import {
  harnessRouteSourceKey,
  type HarnessRouteCatalog,
  type HarnessRouteSource,
  type HarnessRouteTestResult,
} from "../../../../shared/harnessRoutes";
import { useRuntimeCatalogForFamily } from "../../shared/ModelPicker/useRuntimeCatalogForFamily";
import { DEFAULT_RUNTIME_CATALOG_SCOPE } from "../../shared/ModelPicker/runtimeCatalogCache";
import { loadHarnessAccounts, type HarnessAccountSource } from "./harnessSources";
import { nativeModelsForProvider, type HarnessReachInputs } from "./harnessReach";
import { isAdeAvailable } from "../../../lib/adeAvailability";

export type HarnessRouteTestState =
  | { status: "testing" }
  | { status: "ok"; latencyMs: number | null }
  | { status: "failed"; error: string };

export type HarnessReach = HarnessReachInputs & {
  loading: boolean;
  /** Whether this host can run ADE's proxy (and therefore lend an account to another harness). */
  proxyAvailable: boolean;
  refresh: () => Promise<void>;
  /** One-token live check. Re-reads the catalog after, so the route tag follows the verdict. */
  testRoute: (harness: HarnessPresetBody, source: HarnessRouteSource["source"], model: string) => Promise<HarnessRouteTestResult | null>;
  testState: Readonly<Record<string, HarnessRouteTestState>>;
};

/** The key the test state is filed under. */
export function routeTestKey(harness: string, source: HarnessRouteSource["source"], model: string): string {
  return `${harness}\u0000${harnessRouteSourceKey(source)}\u0000${model}`;
}

export function useHarnessReach({
  enabled,
  pin = null,
  catalogScopeKey = DEFAULT_RUNTIME_CATALOG_SCOPE,
}: {
  enabled: boolean;
  pin?: OpenProjectBinding | null;
  catalogScopeKey?: string;
}): HarnessReach {
  const [catalog, setCatalog] = useState<HarnessRouteCatalog | null>(null);
  const [accounts, setAccounts] = useState<HarnessAccountSource[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [testState, setTestState] = useState<Record<string, HarnessRouteTestState>>({});
  // The binding object is a routing payload; its key is the reactive input.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const requestSeqRef = useRef(0);
  const pinKey = pin?.key ?? "";

  const loadCatalog = useCallback(async (seq = ++requestSeqRef.current, binding = pinRef.current) => {
    const list = window.ade?.ai?.listHarnessRoutes;
    if (!isAdeAvailable(list)) {
      if (seq === requestSeqRef.current) setCatalog({ sources: [], proxyAvailable: false });
      return;
    }
    try {
      const result = await list(binding);
      if (seq === requestSeqRef.current) setCatalog(result);
    } catch {
      if (seq === requestSeqRef.current) setCatalog((current) => current ?? { sources: [], proxyAvailable: false });
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const binding = pinRef.current;
    setLoading(true);
    try {
      const [, accountRows] = await Promise.all([
        loadCatalog(seq, binding),
        loadHarnessAccounts(binding),
      ]);
      if (seq === requestSeqRef.current) setAccounts(accountRows);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [loadCatalog]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, pinKey, refresh]);

  const { catalog: claudeCatalog } = useRuntimeCatalogForFamily(enabled, "anthropic", catalogScopeKey, "sdk");
  const { catalog: codexCatalog } = useRuntimeCatalogForFamily(enabled, "openai", catalogScopeKey, "sdk");
  const nativeModels = useMemo(
    () => ({
      claude: nativeModelsForProvider("claude", claudeCatalog, catalogScopeKey),
      codex: nativeModelsForProvider("codex", codexCatalog, catalogScopeKey),
    }),
    [catalogScopeKey, claudeCatalog, codexCatalog],
  );

  const testRoute = useCallback(async (
    harness: HarnessPresetBody,
    source: HarnessRouteSource["source"],
    model: string,
  ): Promise<HarnessRouteTestResult | null> => {
    const test = window.ade?.ai?.testHarnessRoute;
    if (!isAdeAvailable(test)) return null;
    const key = routeTestKey(harness, source, model);
    const seq = requestSeqRef.current;
    const binding = pinRef.current;
    setTestState((prev) => ({ ...prev, [key]: { status: "testing" } }));
    try {
      const result = await test({ harness, source, model }, binding);
      if (seq === requestSeqRef.current) {
        setTestState((prev) => ({
          ...prev,
          [key]: result.ok
            ? { status: "ok", latencyMs: result.latencyMs }
            : { status: "failed", error: result.error?.trim() || "The model did not answer." },
        }));
      }
      // The verdict is recorded by main; re-read so the row's route follows it.
      void loadCatalog(seq, binding);
      return result;
    } catch (error) {
      if (seq === requestSeqRef.current) {
        setTestState((prev) => ({
          ...prev,
          [key]: { status: "failed", error: error instanceof Error ? error.message : "The check could not run." },
        }));
      }
      return null;
    }
  }, [loadCatalog]);

  const proxyAvailable = Boolean(catalog?.proxyAvailable);

  return {
    catalog,
    accounts,
    nativeModels,
    loading,
    proxyAvailable,
    refresh,
    testRoute,
    testState,
  };
}
