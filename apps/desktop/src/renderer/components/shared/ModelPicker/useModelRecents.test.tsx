/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { __resetModelRecentsForTests, useModelRecents } from "./useModelRecents";

const getRecents = vi.fn<[], Promise<{ recents: string[] }>>();
const pushRecent = vi.fn<[string], Promise<{ recents: string[] }>>();

describe("useModelRecents", () => {
  beforeEach(() => {
    window.localStorage.clear();
    getRecents.mockResolvedValue({ recents: ["remote/model"] });
    pushRecent.mockImplementation(async (modelId) => ({ recents: [modelId] }));
    window.ade = {
      modelPicker: {
        getRecents,
        pushRecent,
      },
    } as unknown as typeof window.ade;
    __resetModelRecentsForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "ade");
    window.localStorage.clear();
    vi.clearAllMocks();
    __resetModelRecentsForTests();
  });

  it("uses cached recents without hydrating when disabled", async () => {
    window.localStorage.setItem("ade.modelPicker.recents.v1", JSON.stringify(["cached/model"]));
    __resetModelRecentsForTests();

    const { result } = renderHook(() => useModelRecents({ hydrate: false }));

    expect(result.current.recents).toEqual(["cached/model"]);
    await Promise.resolve();
    expect(getRecents).not.toHaveBeenCalled();
  });

  it("hydrates from the runtime when enabled", async () => {
    const { result } = renderHook(() => useModelRecents({ hydrate: true }));

    await waitFor(() => {
      expect(result.current.recents).toEqual(["remote/model"]);
    });
    expect(getRecents).toHaveBeenCalledTimes(1);
  });

  it("hydrates after the option changes from disabled to enabled", async () => {
    const { result, rerender } = renderHook(
      ({ hydrate }) => useModelRecents({ hydrate }),
      { initialProps: { hydrate: false } },
    );

    expect(result.current.recents).toEqual([]);
    expect(getRecents).not.toHaveBeenCalled();

    rerender({ hydrate: true });

    await waitFor(() => {
      expect(result.current.recents).toEqual(["remote/model"]);
    });
    expect(getRecents).toHaveBeenCalledTimes(1);
  });

  it("records usage optimistically even when hydration is disabled", async () => {
    const { result } = renderHook(() => useModelRecents({ hydrate: false }));

    act(() => {
      result.current.recordUsage("local/model");
    });

    expect(result.current.recents).toEqual(["local/model"]);
    expect(pushRecent).toHaveBeenCalledWith("local/model");
    await waitFor(() => {
      expect(window.localStorage.getItem("ade.modelPicker.recents.v1")).toBe(JSON.stringify(["local/model"]));
    });
  });
});
