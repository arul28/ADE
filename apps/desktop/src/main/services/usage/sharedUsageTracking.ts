import type {
  UsageTrackingProjectScope,
  UsageTrackingProjectScopeInput,
  UsageTrackingService,
} from "./usageTrackingService";

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
const sharedUsageTrackingServices = new Map<
  string,
  { service: UsageTrackingService; scopeCount: number }
>();

export function attachSharedUsageTrackingScope(
  key: string,
  make: () => UsageTrackingService,
  scope: UsageTrackingProjectScopeInput,
): UsageTrackingProjectScope {
  let entry = sharedUsageTrackingServices.get(key);
  if (!entry) {
    entry = { service: make(), scopeCount: 0 };
    sharedUsageTrackingServices.set(key, entry);
  }
  const shared = entry;
  shared.scopeCount += 1;
  const attached = shared.service.attachProjectScope(scope);
  let released = false;
  return {
    ...attached,
    dispose: (): void => {
      if (released) return;
      released = true;
      attached.dispose();
      shared.scopeCount -= 1;
      if (shared.scopeCount > 0) return;
      if (sharedUsageTrackingServices.get(key) === shared) {
        sharedUsageTrackingServices.delete(key);
      }
      shared.service.dispose();
    },
  };
}

export function peekSharedUsageTrackingService(key: string): UsageTrackingService | undefined {
  return sharedUsageTrackingServices.get(key)?.service;
}

export function clearSharedUsageTrackingServicesForTesting(): void {
  for (const entry of sharedUsageTrackingServices.values()) entry.service.dispose();
  sharedUsageTrackingServices.clear();
}
