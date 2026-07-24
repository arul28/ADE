/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrlInAdeBrowser } from "./openExternal";

describe("openUrlInAdeBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back immediately when in-app navigation rejects", async () => {
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => {
      throw new Error("profile migration failed");
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: { openExternal },
        builtInBrowser: { navigate },
      },
    });

    openUrlInAdeBrowser("https://example.test/docs");

    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test/docs",
      newTab: true,
    });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("falls back on a short deadline instead of waiting for a delayed rejection", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: { openExternal },
        builtInBrowser: { navigate },
      },
    });

    openUrlInAdeBrowser("https://example.test/docs");
    expect(openExternal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
  });
});
