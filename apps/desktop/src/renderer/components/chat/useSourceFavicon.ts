import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/**
 * Favicons for Sources rows, from the brain's `chat.resolveSourceFavicons`
 * (a first-party fetch from the site itself, cached on disk there). The
 * renderer keeps its own in-memory answer per domain for the session, asks
 * only for rows that are on screen, and batches every row that asks in the
 * same tick into one call. Until an icon arrives — or when there is none, the
 * call fails, or no runtime is bound — the row keeps its domain initial.
 */

const MAX_REMEMBERED = 500;
const MAX_DOMAINS_PER_CALL = 32;

/** domain → data URL, or null once the brain answered "none" (or failed). */
const resolved = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Set<string>();
const queued = new Set<string>();
let flushScheduled = false;

function notify(domain: string): void {
  for (const listener of listeners.get(domain) ?? []) listener();
}

function remember(domain: string, icon: string | null): void {
  resolved.delete(domain);
  resolved.set(domain, icon);
  while (resolved.size > MAX_REMEMBERED) {
    const oldest = resolved.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    resolved.delete(oldest);
  }
  notify(domain);
}

async function fetchBatch(domains: string[]): Promise<void> {
  let icons: Record<string, string | null> = {};
  try {
    const resolve = typeof window !== "undefined" ? window.ade?.agentChat?.resolveSourceFavicons : undefined;
    if (resolve) icons = (await resolve({ domains }))?.icons ?? {};
  } catch {
    // No icon is the fallback; the initial stays.
  }
  for (const domain of domains) {
    pending.delete(domain);
    const icon = icons[domain];
    remember(domain, typeof icon === "string" && icon.startsWith("data:image/") ? icon : null);
  }
}

function flush(): void {
  flushScheduled = false;
  const domains = [...queued];
  queued.clear();
  for (let start = 0; start < domains.length; start += MAX_DOMAINS_PER_CALL) {
    const batch = domains.slice(start, start + MAX_DOMAINS_PER_CALL);
    for (const domain of batch) pending.add(domain);
    void fetchBatch(batch);
  }
}

function request(domain: string): void {
  if (resolved.has(domain) || pending.has(domain) || queued.has(domain)) return;
  queued.add(domain);
  if (!flushScheduled) {
    flushScheduled = true;
    // Rows that mount (or scroll into view) together land in one call.
    queueMicrotask(flush);
  }
}

/** Whether the element has been on screen. Environments without IntersectionObserver count as visible. */
export function useSeenOnScreen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * The favicon for a Sources domain as a data URL, or null (draw the initial).
 * Nothing is requested until `visible` is true.
 */
export function useSourceFavicon(domain: string | null | undefined, visible: boolean): string | null {
  const key = domain?.trim().toLowerCase() || null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => undefined;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(key);
    };
  }, [key]);
  const getSnapshot = useCallback(() => (key ? resolved.get(key) ?? null : null), [key]);
  const icon = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (key && visible) request(key);
  }, [key, visible]);
  return icon;
}

export function resetSourceFaviconCacheForTests(): void {
  resolved.clear();
  listeners.clear();
  pending.clear();
  queued.clear();
  flushScheduled = false;
}
