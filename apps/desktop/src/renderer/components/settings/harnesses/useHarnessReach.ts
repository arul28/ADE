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
  const requestSeqRef = useRef(0);
  const pinKey = pin?.key ?? "";

  const loadCatalog = useCallback(async (seq = ++requestSeqRef.current, binding = pinRef.current) => {
    const list = window.ade?.ai?.listHarnessRoutes;
    if (typeof list !== "function") {
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

  const loadProxy = useCallback(async (seq = ++requestSeqRef.current, binding = pinRef.current) => {
    const status = proxyBridge()?.status;
    if (typeof status !== "function") {
      if (seq === requestSeqRef.current) setProxyLogins(null);
      return;
    }
    try {
      const result = await status(binding);
      const signedIn = new Set(
        (result?.logins ?? [])
          .filter((login) => login && login.disabled !== true)
          .map((login) => String(login.provider).toLowerCase()),
      );
      if (seq === requestSeqRef.current) setProxyLogins(signedIn);
    } catch {
      if (seq === requestSeqRef.current) setProxyLogins(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const binding = pinRef.current;
    setLoading(true);
    try {
      const [, , accountRows] = await Promise.all([
        loadCatalog(seq, binding),
        loadProxy(seq, binding),
        loadHarnessAccounts(binding),
      ]);
      if (seq === requestSeqRef.current) setAccounts(accountRows);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
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

  const proxySignIn = useCallback(async (provider: HarnessPresetAccountProvider) => {
    const signIn = proxyBridge()?.signIn;
    if (typeof signIn !== "function") return;
    const seq = requestSeqRef.current;
    const binding = pinRef.current;
    setProxySigningIn(provider);
    try {
      await signIn({ provider }, binding);
    } finally {
      if (seq === requestSeqRef.current) setProxySigningIn(null);
      await loadProxy(seq, binding);
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
