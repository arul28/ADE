import type {
  AccountLiveQuotaFetcher,
  AccountRollupFetcher,
  UsageTrackingProjectScope,
  UsageTrackingProjectScopeInput,
  UsageTrackingService,
} from "./usageTrackingService";

/**
 * One `T` per key, shared by every attachment: the first attach makes it, and
 * the last release disposes it. Keyed by ADE home for the machine-level
 * services (the quota poller here, the usage research uploader).
 */
export type SharedByKeyRegistry<T> = Map<string, { value: T; attachments: number }>;

export function attachSharedByKey<T>(
  registry: SharedByKeyRegistry<T>,
  key: string,
  make: () => T,
  dispose: (value: T) => void,
): { value: T; release: () => void } {
  let entry = registry.get(key);
  if (!entry) {
    entry = { value: make(), attachments: 0 };
    registry.set(key, entry);
  }
  const shared = entry;
  shared.attachments += 1;
  let released = false;
  return {
    value: shared.value,
    release: (): void => {
      if (released) return;
      released = true;
      shared.attachments -= 1;
      if (shared.attachments > 0) return;
      if (registry.get(key) === shared) registry.delete(key);
      dispose(shared.value);
    },
  };
}

/**
 * Provider quota is a machine fact, not a project fact.
 *
 * One process used to build one tracker per open project scope: two projects
 * meant two 120 s poll timers on different phases, two demand leases and two
 * `lastSnapshot`s, so two windows on one computer showed two different meters
 * and one of them was always behind. The shared instance is created once per
 * ADE home and every project scope attaches to it.
 *
 * Mirrors `getSharedProductAnalyticsService`, with a scope count instead of a
 * bare get: the poller belongs to the process, so it must outlive any single
 * project and shut down when the last one detaches.
 */
const sharedUsageTrackingServices: SharedByKeyRegistry<UsageTrackingService> = new Map();

export function attachSharedUsageTrackingScope(
  key: string,
  make: () => UsageTrackingService,
  scope: UsageTrackingProjectScopeInput,
): UsageTrackingProjectScope {
  const shared = attachSharedByKey(sharedUsageTrackingServices, key, make, (service) => service.dispose());
  if (sharedAccountRollupFetcher) shared.value.setAccountRollupFetcher(sharedAccountRollupFetcher);
  if (sharedAccountLiveQuotaFetcher) shared.value.setAccountLiveQuotaFetcher(sharedAccountLiveQuotaFetcher);
  const attached = shared.value.attachProjectScope(scope);
  let released = false;
  return {
    ...attached,
    dispose: (): void => {
      if (released) return;
      released = true;
      attached.dispose();
      shared.release();
    },
  };
}

/**
 * The process's own way to ask the account's other machines for their usage
 * rollups. The brain installs one built on its agents' paired connections;
 * every shared tracker, existing or made later, gets it, so account-scoped
 * reads pull the other machines whether or not a desktop window is pushing.
 */
let sharedAccountRollupFetcher: AccountRollupFetcher | null = null;

export function setSharedAccountRollupFetcher(fetcher: AccountRollupFetcher | null): void {
  sharedAccountRollupFetcher = fetcher;
  for (const entry of sharedUsageTrackingServices.values()) entry.value.setAccountRollupFetcher(fetcher);
}

/** Same as the rollup fetcher, for the quota-only pull the limits view uses. */
let sharedAccountLiveQuotaFetcher: AccountLiveQuotaFetcher | null = null;

export function setSharedAccountLiveQuotaFetcher(fetcher: AccountLiveQuotaFetcher | null): void {
  sharedAccountLiveQuotaFetcher = fetcher;
  for (const entry of sharedUsageTrackingServices.values()) entry.value.setAccountLiveQuotaFetcher(fetcher);
}

export function peekSharedUsageTrackingService(key: string): UsageTrackingService | undefined {
  return sharedUsageTrackingServices.get(key)?.value;
}

export function clearSharedUsageTrackingServicesForTesting(): void {
  for (const entry of sharedUsageTrackingServices.values()) entry.value.dispose();
  sharedUsageTrackingServices.clear();
}
