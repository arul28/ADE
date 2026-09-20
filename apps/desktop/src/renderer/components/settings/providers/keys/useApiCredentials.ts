/**
 * Reads of the provider key store for one provider page.
 *
 * A page can care about more than one store id: the OpenCode page lists both
 * its own keys and the key behind every custom provider block, each filed under
 * its own id. So this takes a list and filters one read rather than firing a
 * request per id.
 *
 * A missing bridge is a first-class state, not an error. The Vite-only preview
 * and older hosts have no `apiCredentials` at all, and a settings page that
 * throws there is worse than a page with one panel missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiCredentialStoreArgs,
  ApiCredentialSummary,
} from "../../../../../shared/types/apiCredentials";
import { providerActionMessage } from "../providerErrorMessage";

function bridge() {
  return window.ade?.apiCredentials ?? null;
}

export type ApiCredentialsState = {
  credentials: ApiCredentialSummary[];
  /** True while the first read is in flight. Later reloads keep the rows up. */
  loading: boolean;
  /** Host is too old, or this window has no bridge. The panel stays hidden. */
  bridgeMissing: boolean;
  error: string | null;
  reload: () => Promise<void>;
  store: (args: ApiCredentialStoreArgs) => Promise<void>;
  remove: (provider: string, credentialId: string) => Promise<void>;
};

export function useApiCredentials(providers: readonly string[]): ApiCredentialsState {
  const [credentials, setCredentials] = useState<ApiCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // The caller usually builds this array inline, so identity is not stable.
  // Joining it is what keeps the effect below from reloading on every render.
  const key = providers.join(",");
  const wanted = useMemo(() => new Set(key.split(",").filter(Boolean)), [key]);

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
      const rows = await api.list({});
      if (!aliveRef.current) return;
      setCredentials(rows.filter((row) => wanted.has(row.provider)));
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(providerActionMessage(err, "Could not read this provider's saved keys."));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [wanted]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const store = useCallback(async (args: ApiCredentialStoreArgs) => {
    const api = bridge();
    if (!api) throw new Error("This window cannot save API keys.");
    await api.store(args);
    await reload();
  }, [reload]);

  const remove = useCallback(async (provider: string, credentialId: string) => {
    const api = bridge();
    if (!api) throw new Error("This window cannot remove API keys.");
    await api.remove({ provider, credentialId });
    await reload();
  }, [reload]);

  return { credentials, loading, bridgeMissing, error, reload, store, remove };
}
