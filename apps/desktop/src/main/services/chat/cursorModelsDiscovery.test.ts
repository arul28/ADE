import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cursorModelsListMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

import {
  clearCursorCliModelsCache,
  discoverCursorSdkModelDescriptors,
  listCursorModelsFromSdk,
  parseCursorCliModelsStdout,
  probeCursorSdkModelDiscovery,
} from "./cursorModelsDiscovery";

beforeEach(() => {
  cursorModelsListMock.mockReset();
  clearCursorCliModelsCache();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseCursorCliModelsStdout", () => {
  it("parses table lines with optional (current) suffix", () => {
    const raw = [
      "\x1b[2mLoading models…\x1b[0m",
      "Available models",
      "",
      "auto - Auto  (current)",
      "composer-2 - Composer 2",
      "claude-4.6-sonnet-medium - Sonnet 4.6 1M",
    ].join("\n");

    const rows = parseCursorCliModelsStdout(raw);
    expect(rows.map((r) => r.id)).toEqual(["auto", "composer-2", "claude-4.6-sonnet-medium"]);
    expect(rows[0]?.displayName).toBe("Auto");
    expect(rows[1]?.displayName).toBe("Composer 2");
  });

  it("dedupes repeated ids", () => {
    const rows = parseCursorCliModelsStdout("auto - Auto\nauto - Auto");
    expect(rows).toHaveLength(1);
  });

  it("returns safe Cursor SDK fallbacks immediately while warming exact models", async () => {
    let resolveModels!: (rows: Array<{ id: string; displayName?: string }>) => void;
    cursorModelsListMock.mockReturnValue(new Promise<Array<{ id: string; displayName?: string }>>((resolve) => {
      resolveModels = resolve;
    }));

    const initial = await discoverCursorSdkModelDescriptors("crsr_test");

    expect(initial.map((descriptor) => descriptor.id)).toEqual(["cursor/auto", "cursor/composer-2"]);
    await vi.waitFor(() => {
      expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    });

    resolveModels([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "auto", displayName: "Auto" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmed = await discoverCursorSdkModelDescriptors("crsr_test");
    expect(warmed.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
    ]);
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);
  });

  it("can warm exact Cursor SDK models without returning fallback rows", async () => {
    let resolveModels!: (rows: Array<{ id: string; displayName?: string }>) => void;
    cursorModelsListMock.mockReturnValue(new Promise<Array<{ id: string; displayName?: string }>>((resolve) => {
      resolveModels = resolve;
    }));

    const initial = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-only" });

    expect(initial).toEqual([]);
    await vi.waitFor(() => {
      expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    });

    resolveModels([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "auto", displayName: "Auto" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmed = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-only" });
    expect(warmed.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
    ]);
  });

  it("probes exact Cursor SDK models when requested", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "composer-2", displayName: "Composer 2" },
      { id: "auto", displayName: "Auto" },
    ]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
      "cursor/composer-2",
    ]);
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
  });

  it("falls back to Cursor's official models API when SDK model listing fails", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("SDK model listing failed"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: ["claude-4-sonnet-thinking", "o3", "claude-4-opus-thinking"],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "cursor/claude-4-opus-thinking",
      "cursor/claude-4-sonnet-thinking",
      "cursor/o3",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cursor.com/v0/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer crsr_test",
        }),
      }),
    );
  });

  it("uses only conservative fallback rows when Cursor model APIs cannot enumerate", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("SDK model listing failed"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["cursor/auto", "cursor/composer-2"]);
  });

  it("does not show fallback models when Cursor rejects agent/model auth", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));

    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [],
      failureKind: "auth",
    });

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    expect(descriptors).toEqual([]);
  });

  it("does not reuse cached Cursor SDK rows for explicit probe verification", async () => {
    cursorModelsListMock.mockResolvedValueOnce([{ id: "cached-model", name: "Cached Model" }]);
    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [{ id: "cached-model" }],
      failureKind: null,
    });

    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));

    const freshProbe = await probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 });
    expect(freshProbe).toMatchObject({
      rows: [],
      failureKind: "auth",
    });
    expect(freshProbe.fromCache).toBeUndefined();
  });

  it("suppresses fallback rows after a warm auth failure", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const initial = await discoverCursorSdkModelDescriptors("crsr_test");
    expect(initial.map((descriptor) => descriptor.id)).toEqual(["cursor/auto", "cursor/composer-2"]);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterFailure = await discoverCursorSdkModelDescriptors("crsr_test");
    expect(afterFailure).toEqual([]);
  });

  it("bounds direct Cursor SDK model list discovery with a timeout", async () => {
    vi.useFakeTimers();
    cursorModelsListMock.mockReturnValue(new Promise(() => undefined));

    const rowsPromise = listCursorModelsFromSdk("crsr_test", { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(26);

    await expect(rowsPromise).resolves.toEqual([]);
  });
});
