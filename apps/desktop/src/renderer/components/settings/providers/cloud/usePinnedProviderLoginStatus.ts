/**
 * One machine's sign-in read (`providerLogins.status`), kept under the pin's
 * key. It reads on open, on the pin's `providerLogins.onChanged` and on `refresh`. No
 * timer and no poll. A result for an old key is dropped, so a page that
 * changes machine never shows the last machine's sign-ins.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../../../shared/types";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";

type Read = { key: string | null; status: ProviderLoginStatus | null; failed: boolean };

export type PinnedProviderLoginStatus = {
  /** The read for the pin's key, or null before it. */
  status: ProviderLoginStatus | null;
  /** The last read for this key failed, or the bridge has no status read. A failed read keeps the status before it. */
  failed: boolean;
  /** A write's answer for the key it started with (the read keeps it only while the pin has that key). */
  apply: (key: string | null, status: ProviderLoginStatus) => void;
  /** Read again. */
  refresh: () => void;
  /** Read once now; resolves when the read is in (Re-check). */
  reload: () => Promise<void>;
};

export function usePinnedProviderLoginStatus({
  provider,
  pin,
  enabled = true,
  warning,
}: {
  /** One provider's rows, or every provider. */
  provider?: ProviderLoginProvider;
  pin: OpenProjectBinding | null;
  /** False: no read and no listener. */
  enabled?: boolean;
  /** The console line when a read fails; none when left out. */
  warning?: string;
}): PinnedProviderLoginStatus {
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [read, setRead] = useState<Read | null>(null);
  const [tick, setTick] = useState(0);
  const bridge = typeof window === "undefined" ? undefined : window.ade?.providerLogins;
  const available = typeof bridge?.status === "function";

  // The change events of the pin's machine: a sign-in saved or applied there
  // reads again at once. Without the pin they would be the tab machine's.
  useEffect(() => {
    if (!enabled) return undefined;
    const off = bridge?.onChanged?.(() => setTick((value) => value + 1), pinRef.current);
    return () => off?.();
  }, [bridge, enabled, pinKey]);

  const readOnce = useCallback(async (stale: () => boolean) => {
    const status = bridge?.status;
    if (typeof status !== "function") return;
    const key = pinRef.current?.key ?? null;
    try {
      const next = await status(provider ? { provider } : {}, pinRef.current);
      if (stale() || !next) return;
      setRead({ key, status: next, failed: false });
    } catch (error) {
      if (warning) console.warn(warning, error);
      if (!stale()) setRead((current) => ({ key, status: current?.key === key ? current.status : null, failed: true }));
    }
  }, [bridge, provider, warning]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void readOnce(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [enabled, pinKey, readOnce, tick]);

  const apply = useCallback((key: string | null, status: ProviderLoginStatus) => {
    if (mountedRef.current) setRead({ key, status, failed: false });
  }, []);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const reload = useCallback(() => {
    const key = pinRef.current?.key ?? null;
    return readOnce(() => !mountedRef.current || (pinRef.current?.key ?? null) !== key);
  }, [readOnce]);

  const current = read && read.key === pinKey ? read : null;
  return { status: current?.status ?? null, failed: (current?.failed ?? false) || !available, apply, refresh, reload };
}
