/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import { resetModelPickerRuntimeCatalogForTests } from "./runtimeCatalogCache";
import { useRuntimeCatalogForFamily } from "./useRuntimeCatalogForFamily";

function catalogAt(fetchedAt: string): AgentChatModelCatalog {
  return {
    fetchedAt,
    groups: [
      {
        key: "cursor",
        providers: [
          {
            key: "cursor",
            subsections: [
              { models: [{ id: "cursor/composer-9", displayName: "Composer 9", groupKey: "cursor" }] },
            ],
          },
        ],
      },
    ],
  } as unknown as AgentChatModelCatalog;
}

/** A promise whose resolution this test controls, so "in flight" is a real state. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const modelCatalog = vi.fn<[unknown], Promise<AgentChatModelCatalog>>();

function installBridge(): void {
  window.ade = { agentChat: { modelCatalog } } as unknown as typeof window.ade;
}

describe("useRuntimeCatalogForFamily", () => {
  beforeEach(() => {
    resetModelPickerRuntimeCatalogForTests();
    modelCatalog.mockReset();
    installBridge();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "ade");
    resetModelPickerRuntimeCatalogForTests();
    vi.clearAllMocks();
  });

  it("reports the live catalog and stops loading once it arrives", async () => {
    modelCatalog.mockResolvedValue(catalogAt("2026-01-01T00:00:00.000Z"));

    const { result } = renderHook(() => useRuntimeCatalogForFamily(true, "cursor"));

    await waitFor(() => expect(result.current.catalog).not.toBeNull());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalog?.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(modelCatalog).toHaveBeenCalled();
  });

  it("does not ask an older host that has no catalog bridge", async () => {
    Reflect.deleteProperty(window, "ade");

    const { result } = renderHook(() => useRuntimeCatalogForFamily(true, "cursor"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalog).toBeNull();
    expect(modelCatalog).not.toHaveBeenCalled();
  });

  it("clears loading when the control leaves the screen while a fetch is open", async () => {
    // The original bug: an early return left `loading` set, so the model select
    // came back from another wizard step still reading "Loading models…" over a
    // list that had already arrived.
    const pending = deferred<AgentChatModelCatalog>();
    modelCatalog.mockReturnValue(pending.promise);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRuntimeCatalogForFamily(enabled, "cursor"),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.loading).toBe(false));

    pending.resolve(catalogAt("2026-01-02T00:00:00.000Z"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("keeps loading set for the run that replaced a cancelled one", async () => {
    // The inverse bug: a cancelled run's `finally` cleared the flag belonging to
    // the newer run, so the select read "No models reported yet" over a list
    // that was still arriving.
    const cached = deferred<AgentChatModelCatalog>();
    const refreshed = deferred<AgentChatModelCatalog>();
    modelCatalog.mockReturnValueOnce(cached.promise).mockReturnValueOnce(refreshed.promise);

    const initialProps: { family: "cursor" | "opencode" } = { family: "cursor" };
    const { result, rerender } = renderHook(
      ({ family }: { family: "cursor" | "opencode" }) => useRuntimeCatalogForFamily(true, family),
      { initialProps },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    // The second run shares the first run's in-flight request, so cancelling
    // the first does not cancel the fetch — it only decides who may speak for
    // the result.
    rerender({ family: "opencode" });
    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      cached.resolve(catalogAt("2026-01-03T00:00:00.000Z"));
      await cached.promise;
    });
    // A second call proves the cancelled run's leg settled and the live run
    // moved on to its own refresh, so the flag below is read after the moment
    // the old `finally` would have cleared it.
    await waitFor(() => expect(modelCatalog).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      refreshed.resolve(catalogAt("2026-01-04T00:00:00.000Z"));
      await refreshed.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
