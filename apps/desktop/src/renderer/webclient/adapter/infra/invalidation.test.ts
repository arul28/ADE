import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./eventBus";
import {
  ALL_INVALIDATION_DOMAINS,
  createInvalidationScheduler,
  type InvalidationEvent,
  type InvalidationEvents,
} from "./invalidation";

function collectDomains(tables: string[]): InvalidationDomainsResult {
  const bus = new EventBus<InvalidationEvents>();
  const events: InvalidationEvent[] = [];
  bus.on("invalidation", (event) => events.push(event));
  const emitters: Array<(tables: Set<string>) => void> = [];
  const dispose = createInvalidationScheduler(
    (listener) => {
      emitters.push(listener);
      return () => {};
    },
    bus,
    0,
  );
  for (const emit of emitters) emit(new Set(tables));
  vi.advanceTimersByTime(1);
  dispose();
  return { domains: events[0]?.domains ?? [] };
}

type InvalidationDomainsResult = { domains: readonly string[] };

describe("plugin table invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes every replicated plugin table to the plugins domain and nothing else", () => {
    // The point of the dedicated domain: a plugin writing a collection row must
    // not trigger a lanes/sessions/chats refetch, which is exactly what the
    // unclassified fallback would have done on a metered relay link.
    for (const table of ["plugin_presence", "plugin_panels", "plugin_collections", "plugin_contributions"]) {
      expect(collectDomains([table]).domains).toEqual(["plugins"]);
    }
  });

  it("keeps `plugins` in the full-refresh domain list", () => {
    // A project rebind emits ALL_INVALIDATION_DOMAINS; a domain missing from it
    // would leave plugin surfaces stale after every project switch.
    expect(ALL_INVALIDATION_DOMAINS).toContain("plugins");
  });

  it("does not classify an unrelated table as plugin traffic", () => {
    // Guards against someone replacing the exact entries with a `plugin` prefix
    // rule — the same mistake that once made a lock heartbeat wipe the Files
    // cache.
    expect(collectDomains(["pluginish_table"]).domains).not.toContain("plugins");
  });
});
