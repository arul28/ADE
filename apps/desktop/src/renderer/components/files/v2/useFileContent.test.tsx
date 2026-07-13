// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../../../../shared/types";
import { invalidateFileContent, primeFileContent, updateCachedFileContentText, useFileContent } from "./useFileContent";

function textContent(text: string): FileContent {
  return {
    content: text,
    encoding: "utf-8",
    size: text.length,
    languageId: "markdown",
    isBinary: false,
  };
}

const readFile = vi.fn(async () => textContent("from-disk"));

beforeEach(() => {
  readFile.mockClear();
  invalidateFileContent("ws-1", "notes.md");
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { files: { readFile } },
  });
});

describe("useFileContent saved-text sync", () => {
  it("updates a cached-first hook with the just-saved text", () => {
    primeFileContent("ws-1", "notes.md", textContent("v1"));
    const { result } = renderHook(() => useFileContent("ws-1", "notes.md"));
    expect(result.current).toMatchObject({ status: "ready", content: { content: "v1" } });

    act(() => updateCachedFileContentText("ws-1", "notes.md", "v2-saved"));
    expect(result.current).toMatchObject({ status: "ready", content: { content: "v2-saved" } });
  });

  it("reaches mounted state even when a forced reload bypassed the cache", async () => {
    // reloadToken > 0 skips the cache short-circuit, so the state must be
    // patched directly — a save after a watcher reload previously rendered
    // stale pre-save text until the next watcher echo.
    primeFileContent("ws-1", "notes.md", textContent("stale-cache"));
    const { result } = renderHook(() => useFileContent("ws-1", "notes.md", 1));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", content: { content: "from-disk" } }));

    act(() => updateCachedFileContentText("ws-1", "notes.md", "v3-saved"));
    expect(result.current).toMatchObject({ status: "ready", content: { content: "v3-saved" } });
  });

  it("ignores saved-text updates for other files and non-text payloads", async () => {
    const { result } = renderHook(() => useFileContent("ws-1", "notes.md", 1));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => updateCachedFileContentText("ws-1", "other.md", "unrelated"));
    expect(result.current).toMatchObject({ content: { content: "from-disk" } });

    readFile.mockResolvedValueOnce({ ...textContent("chunk"), isPartial: true, nextOffset: 5 });
    const partial = renderHook(() => useFileContent("ws-1", "big.md", 1));
    await waitFor(() => expect(partial.result.current.status).toBe("ready"));
    act(() => updateCachedFileContentText("ws-1", "big.md", "must-not-apply"));
    expect(partial.result.current).toMatchObject({ content: { content: "chunk", isPartial: true } });
  });
});
