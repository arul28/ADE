/**
 * Reads of the machine-local provider account registry.
 *
 * Three surfaces need three different slices of the same registry — the
 * Accounts panel wants one provider's instances and settings, the provider list
 * wants a count per provider, and the model picker wants only "is smart balance
 * on" — so each gets its own narrow hook instead of one fat one every caller
 * over-fetches from. All of them tolerate a missing bridge: the browser preview
 * and the older hosts have no `providerInstances` at all, and a settings page
 * that throws there is worse than a page with one panel missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PROVIDER_INSTANCE_SETTINGS,
  PROVIDER_INSTANCE_PROVIDERS,
  type ProviderInstance,
  type ProviderInstanceProvider,
  type ProviderInstanceSettings,
} from "../../../../../shared/types/providerInstances";
import { providerActionMessage } from "../providerErrorMessage";

function bridge() {
  return window.ade?.providerInstances ?? null;
}

export type ProviderInstancesState = {
  instances: ProviderInstance[];
  settings: ProviderInstanceSettings;
  /** True while the first read is in flight. Later reloads keep the rows up. */
  loading: boolean;
  /** Host is too old, or this window has no bridge. The panel stays hidden. */
  bridgeMissing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Optimistic settings write; reverts to the host's answer either way. */
  saveSettings: (patch: Partial<ProviderInstanceSettings>) => Promise<void>;
};

export function useProviderInstances(provider: ProviderInstanceProvider): ProviderInstancesState {
  const [instances, setInstances] = useState<ProviderInstance[]>([]);
  const [settings, setSettings] = useState<ProviderInstanceSettings>(DEFAULT_PROVIDER_INSTANCE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const api = bridge();
    if (!api) {
      setBridgeMissing(true);
      setLoading(false);
      return;
    }
    try {
      const [list, loaded] = await Promise.all([
        api.list({ provider }),
        api.getSettings({ provider }),
      ]);
      if (!aliveRef.current) return;
      setInstances(list);
      setSettings(loaded);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(providerActionMessage(err, "Could not read this provider's accounts."));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const saveSettings = useCallback(
    async (patch: Partial<ProviderInstanceSettings>) => {
      const api = bridge();
      if (!api) return;
      const previous = settings;
      setSettings({ ...previous, ...patch });
      try {
        const next = await api.setSettings({ provider, settings: patch });
        if (aliveRef.current) {
          setSettings(next);
          setError(null);
        }
      } catch (err) {
        if (!aliveRef.current) return;
        setSettings(previous);
        setError(providerActionMessage(err, "That switch could not be saved."));
      }
    },
    [provider, settings],
  );

  return { instances, settings, loading, bridgeMissing, error, reload, saveSettings };
}

/**
 * How many accounts each multi-account provider has, for the list page.
 *
 * One read, every provider, because the list page renders all of them at once
 * and a per-row read would be ten round trips for two answers.
 */
export function useProviderAccountCounts(): Partial<Record<ProviderInstanceProvider, number>> {
  const [counts, setCounts] = useState<Partial<Record<ProviderInstanceProvider, number>>>({});

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.list();
        if (cancelled) return;
        const next: Partial<Record<ProviderInstanceProvider, number>> = {};
        for (const instance of list) {
          next[instance.provider] = (next[instance.provider] ?? 0) + 1;
        }
        setCounts(next);
      } catch {
        // A count is decoration on a row that already works. Say nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}

/**
 * The providers currently balancing new chats across accounts.
 *
 * Read once per mount and never polled: the picker is a transient surface, and
 * the setting only changes from Settings, which is not open at the same time.
 */
export function useSmartBalanceProviders(): ReadonlySet<ProviderInstanceProvider> {
  const [enabled, setEnabled] = useState<ProviderInstanceProvider[]>([]);

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const results = await Promise.all(
          PROVIDER_INSTANCE_PROVIDERS.map(async (provider) => {
            const settings = await api.getSettings({ provider });
            return settings.smartBalance ? provider : null;
          }),
        );
        if (cancelled) return;
        setEnabled(results.filter((value): value is ProviderInstanceProvider => value != null));
      } catch {
        // No note is the honest default when the registry cannot be read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => new Set(enabled), [enabled]);
}
