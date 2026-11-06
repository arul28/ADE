import { afterEach, describe, expect, it, vi } from "vitest";

/** One page load: a fresh module (its in-memory latch resets), the tab's sessionStorage kept. */
async function loadPage(storage: Map<string, string>, { web = true } = {}) {
  const reload = vi.fn();
  vi.stubGlobal("window", {
    __adeWebClient: web,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    location: { reload },
  });
  vi.resetModules();
  const { reloadForStaleChunk } = await import("./staleChunkReload");
  return { reloadForStaleChunk, reload };
}

describe("reloadForStaleChunk", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // After a deploy the host answers a removed chunk with index.html, and each
  // browser words the failure its own way.
  it.each([
    ["Safari", "'text/html' is not a valid JavaScript MIME type."],
    ["Chrome", "Failed to fetch dynamically imported module: https://app.ade-app.dev/assets/WorkPage-3f9a.js"],
    ["Firefox", "error loading dynamically imported module: https://app.ade-app.dev/assets/WorkPage-3f9a.js"],
  ])("reloads a %s tab into the new build once, and never loops", async (_browser, message) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T05:00:00Z"));
    const storage = new Map<string, string>();

    const desktop = await loadPage(storage, { web: false });
    expect(desktop.reloadForStaleChunk(new Error(message))).toBe(false);
    expect(desktop.reload).not.toHaveBeenCalled();

    const first = await loadPage(storage);
    expect(first.reloadForStaleChunk(new Error("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(first.reloadForStaleChunk(new Error(message))).toBe(true);
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The new build is missing the file too: the error shows instead of a reload loop.
    vi.setSystemTime(new Date("2026-11-06T05:00:20Z"));
    const reloaded = await loadPage(storage);
    expect(reloaded.reloadForStaleChunk(new Error(message))).toBe(false);
    expect(reloaded.reload).not.toHaveBeenCalled();

    // A later deploy, past the guard, reloads again.
    vi.setSystemTime(new Date("2026-11-06T05:01:30Z"));
    const later = await loadPage(storage);
    expect(later.reloadForStaleChunk(new Error(message))).toBe(true);
    expect(later.reload).toHaveBeenCalledTimes(1);
  });
});
