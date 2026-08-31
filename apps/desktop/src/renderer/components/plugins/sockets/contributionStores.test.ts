/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sources store's load lifecycle, and the one thing it must never do:
 * bank a FAILED host read as a successful "no plugins".
 *
 * The P1 this pins was two minutes of dead UI on every cold launch. The plugin
 * host lives in the ade-cli daemon, so the renderer's first `plugin.list`
 * refuses with the typed `plugins_unavailable`; `listInstalledPlugins()`
 * collapses that refusal into `[]`; and the store used to clear its `stale`
 * flag BEFORE the read, so the empty answer settled forever. Menu rows drew,
 * presses resolved against an empty registry, and nothing — no spinner, no
 * toast, no error — said why. Recovery depended on an unrelated
 * `plugin_changed` event happening to arrive later.
 *
 * So the two halves are asserted together, because either one alone is a bug:
 * a read that FAILED must stay retryable, and a read that SUCCEEDED with zero
 * plugins must settle rather than spin the host forever.
 *
 * These go through the real `window.ade.plugins` bridge rather than a mocked
 * module, because the collapse that caused the bug happened inside
 * `pluginRuntimeBridge` — a test that mocked the loader would have passed
 * against the broken code.
 */

type ChangeListener = (event: { kind: string }) => void;

const host = {
  list: vi.fn(),
  listeners: [] as ChangeListener[],
};

/** The typed refusal a host with no plugin runtime bound answers with. */
function unavailable(): Error {
  const error = new Error("plugins_unavailable: no plugin host on this machine yet");
  (error as unknown as { code: string }).code = "plugins_unavailable";
  return error;
}

function installedRecord(pluginId = "risk") {
  return {
    pluginId,
    version: "1.0.0",
    enabled: true,
    displayName: "Risk",
    icon: "",
    accent: null,
    source: "registry",
    disabledContributions: [],
  };
}

/** Publish the plugin namespace this build is supposed to have. */
function installHost(): void {
  (window as unknown as { ade?: unknown }).ade = {
    plugins: {
      list: () => host.list(),
      getManifest: async () => ({ name: "risk", sockets: [] }),
      onChanged: (listener: ChangeListener) => {
        host.listeners.push(listener);
        return () => {};
      },
    },
  };
}

/**
 * A FRESH copy of the store, because the singleton is the thing under test.
 *
 * `sourcesStore` is module-level on purpose — six surfaces share one read — so
 * without a new module graph the second test in this file would assert against
 * the first one's latch. `resetPluginBridgeAvailability` clears the sibling
 * latch inside the runtime bridge for the same reason.
 */
async function loadStores() {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  return import("./contributionStores");
}

/** Let a settled promise chain drain without asserting on a specific tick. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  host.list.mockReset();
  host.listeners = [];
  installHost();
});

afterEach(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("the plugin sources store on a cold launch", () => {
  it("retries after a host read that refused, and the sources arrive", async () => {
    // The exact cold-launch sequence: the daemon has not bound a plugin host
    // yet, so the first list refuses; a moment later it can answer.
    host.list
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce([installedRecord()]);
    const { sourcesStore } = await loadStores();

    sourcesStore.ensureLoaded();
    await vi.waitFor(() => expect(host.list).toHaveBeenCalledTimes(1));
    // Settled to `ready`, so the surface draws its empty state rather than a
    // spinner that never stops — but it must NOT have banked the answer.
    await vi.waitFor(() => expect(sourcesStore.getSnapshot().status).toBe("ready"));
    expect(sourcesStore.getSnapshot().sources).toEqual([]);

    // Before the fix this second call was a no-op, forever: `stale` had been
    // cleared before the read, so nothing short of an unrelated plugin_changed
    // event ever asked the host again.
    sourcesStore.ensureLoaded();
    await vi.waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sourcesStore.getSnapshot().sources).toHaveLength(1));
    expect(sourcesStore.getSnapshot().sources[0]?.pluginId).toBe("risk");
    expect(sourcesStore.getSnapshot().status).toBe("ready");
  });

  it("stops asking once the host answers that there are genuinely no plugins", async () => {
    // The other half of the fix. "The host could not answer" and "the host
    // answered, and there are none" look identical in the snapshot; only one of
    // them may be retried, or a machine with no plugins re-reads on every
    // render of every surface forever.
    host.list.mockResolvedValue([]);
    const { sourcesStore } = await loadStores();

    sourcesStore.ensureLoaded();
    await vi.waitFor(() => expect(sourcesStore.getSnapshot().status).toBe("ready"));
    expect(host.list).toHaveBeenCalledTimes(1);

    sourcesStore.ensureLoaded();
    await tick();
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(sourcesStore.getSnapshot().sources).toEqual([]);
  });

  it("keeps the plugins it already has when a later read fails", async () => {
    host.list
      .mockResolvedValueOnce([installedRecord()])
      .mockRejectedValueOnce(unavailable());
    const { sourcesStore } = await loadStores();

    sourcesStore.ensureLoaded();
    await vi.waitFor(() => expect(sourcesStore.getSnapshot().sources).toHaveLength(1));

    // An install event marks the data stale; the next reveal re-reads. This is
    // the window where the daemon can be mid-restart and refuse.
    expect(host.listeners).toHaveLength(1);
    for (const listener of host.listeners) listener({ kind: "installs" });

    sourcesStore.ensureLoaded();
    await vi.waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sourcesStore.getSnapshot().status).toBe("ready"));

    // Blanking here is what turned a transient refusal into an empty Plugins
    // tab: what the store already knows is better than nothing, and the read
    // that failed proved nothing about it.
    expect(sourcesStore.getSnapshot().sources).toHaveLength(1);
    expect(sourcesStore.getSnapshot().sources[0]?.pluginId).toBe("risk");
  });

  it("settles empty and never retries on a build with no plugin namespace", async () => {
    // Deliberately NOT the retry case. A hosted web client or an older host
    // publishes no `window.ade.plugins` and never will inside this session —
    // that is a fact about the build, not a runtime that has yet to bind, and
    // retrying it would spin a surface that can never be served.
    delete (window as unknown as { ade?: unknown }).ade;
    const { sourcesStore } = await loadStores();

    sourcesStore.ensureLoaded();
    expect(sourcesStore.getSnapshot()).toEqual({ status: "ready", sources: [] });

    installHost();
    host.list.mockResolvedValue([installedRecord()]);
    sourcesStore.ensureLoaded();
    await tick();

    expect(host.list).not.toHaveBeenCalled();
    expect(sourcesStore.getSnapshot()).toEqual({ status: "ready", sources: [] });
  });
});
