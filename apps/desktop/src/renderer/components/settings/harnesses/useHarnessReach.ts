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
import type { HarnessPresetAccountProvider, HarnessPresetBody } from "../../../../shared/harnessPresets";
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

export type HarnessRouteTestState =
  | { status: "testing" }
  | { status: "ok"; latencyMs: number | null }
  | { status: "failed"; error: string };

export type HarnessReach = HarnessReachInputs & {
  loading: boolean;
  /** Whether this host can run ADE's proxy (and therefore sign a subscription in). */
  proxyAvailable: boolean;
  refresh: () => Promise<void>;
  /** One-token live check. Re-reads the catalog after, so the route tag follows the verdict. */
  testRoute: (harness: HarnessPresetBody, source: HarnessRouteSource["source"], model: string) => Promise<HarnessRouteTestResult | null>;
  testState: Readonly<Record<string, HarnessRouteTestState>>;
  proxySignIn: (provider: HarnessPresetAccountProvider) => Promise<void>;
  proxySigningIn: HarnessPresetAccountProvider | null;
};

type ProxyBridge = {
  status?: (pin?: OpenProjectBinding | null) => Promise<{ installed?: boolean; logins?: Array<{ provider: string; disabled?: boolean }> }>;
  signIn?: (args: { provider: HarnessPresetAccountProvider }, pin?: OpenProjectBinding | null) => Promise<{ status: string; error?: string }>;
};

function proxyBridge(): ProxyBridge | undefined {
  return (window as unknown as { ade?: { proxy?: ProxyBridge } }).ade?.proxy;
}

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
  const [proxyLogins, setProxyLogins] = useState<ReadonlySet<string> | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [testState, setTestState] = useState<Record<string, HarnessRouteTestState>>({});
  const [proxySigningIn, setProxySigningIn] = useState<HarnessPresetAccountProvider | null>(null);
  // The binding object is a routing payload; its key is the reactive input.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? "";

  const loadCatalog = useCallback(async () => {
    const list = window.ade?.ai?.listHarnessRoutes;
    if (typeof list !== "function") {
      setCatalog({ sources: [], proxyAvailable: false });
      return;
    }
    try {
      setCatalog(await list(pinRef.current));
    } catch {
      setCatalog((current) => current ?? { sources: [], proxyAvailable: false });
    }
  }, []);

  const loadProxy = useCallback(async () => {
    const status = proxyBridge()?.status;
    if (typeof status !== "function") {
      setProxyLogins(null);
      return;
    }
    try {
      const result = await status(pinRef.current);
      const signedIn = new Set(
        (result?.logins ?? [])
          .filter((login) => login && login.disabled !== true)
          .map((login) => String(login.provider).toLowerCase()),
      );
      setProxyLogins(signedIn);
    } catch {
      setProxyLogins(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [, , accountRows] = await Promise.all([loadCatalog(), loadProxy(), loadHarnessAccounts(pinRef.current)]);
      setAccounts(accountRows);
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadProxy]);

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
    if (typeof test !== "function") return null;
    const key = routeTestKey(harness, source, model);
    setTestState((prev) => ({ ...prev, [key]: { status: "testing" } }));
    try {
      const result = await test({ harness, source, model }, pinRef.current);
      setTestState((prev) => ({
        ...prev,
        [key]: result.ok
          ? { status: "ok", latencyMs: result.latencyMs }
          : { status: "failed", error: result.error?.trim() || "The model did not answer." },
      }));
      // The verdict is recorded by main; re-read so the row's route follows it.
      void loadCatalog();
      return result;
    } catch (error) {
      setTestState((prev) => ({
        ...prev,
        [key]: { status: "failed", error: error instanceof Error ? error.message : "The check could not run." },
      }));
      return null;
    }
  }, [loadCatalog]);

  const proxySignIn = useCallback(async (provider: HarnessPresetAccountProvider) => {
    const signIn = proxyBridge()?.signIn;
    if (typeof signIn !== "function") return;
    setProxySigningIn(provider);
    try {
      await signIn({ provider }, pinRef.current);
    } finally {
      setProxySigningIn(null);
      await loadProxy();
    }
  }, [loadProxy]);

  const proxyAvailable = Boolean(catalog?.proxyAvailable) && typeof proxyBridge()?.signIn === "function";

  return {
    catalog,
    accounts,
    proxyLogins,
    nativeModels,
    loading,
    proxyAvailable,
    refresh,
    testRoute,
    testState,
    proxySignIn,
    proxySigningIn,
  };
}
