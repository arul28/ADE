/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadComment } from "../../../shared/threadComments";
import {
  addLocalThreadComment,
  countCommentsForNextSend,
  refreshThreadComments,
  setThreadComments,
  useThreadComments,
} from "./threadCommentsStore";

afterEach(() => {
  delete (window as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

function comment(id: string, sessionId: string): ChatThreadComment {
  return {
    id,
    sessionId,
    messageKey: "message:1",
    messageExcerpt: "reply",
    anchor: { kind: "text", quote: id, prefix: "", suffix: "" },
    body: id,
    includeInNextSend: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function installList(list: (args: { sessionId: string }, pin: unknown) => Promise<ChatThreadComment[]>) {
  (window as unknown as { ade: unknown }).ade = {
    agentChat: { threadComments: { list } },
  };
}

describe("threadCommentsStore.refreshThreadComments", () => {
  it("applies the host list when no live update lands while it is out", async () => {
    const sessionId = "store-apply-session";
    const fromHost = comment("host-1", sessionId);
    installList(vi.fn(async () => [fromHost]));

    const { result } = renderHook(() => useThreadComments(sessionId, null));

    await waitFor(() => expect(result.current.map((entry) => entry.id)).toEqual(["host-1"]));
  });

  it("does not overwrite a newer live update with an in-flight list", async () => {
    const sessionId = "store-race-session";
    let resolveList!: (rows: ChatThreadComment[]) => void;
    const list = vi.fn(() => new Promise<ChatThreadComment[]>((resolve) => { resolveList = resolve; }));
    installList(list);

    const { result } = renderHook(() => useThreadComments(sessionId, null));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // A live update reaches the store while the list call is still out.
    act(() => setThreadComments(sessionId, [comment("live-1", sessionId)]));
    expect(result.current.map((entry) => entry.id)).toEqual(["live-1"]);

    // The older list resolves with different data; it must be ignored.
    await act(async () => {
      resolveList([comment("stale-1", sessionId)]);
      await Promise.resolve();
    });
    expect(result.current.map((entry) => entry.id)).toEqual(["live-1"]);
  });

  it("ignores a refresh when this client has no comment API", async () => {
    await expect(refreshThreadComments("store-no-api-session", null)).resolves.toBeUndefined();
  });
});

describe("threadCommentsStore.addLocalThreadComment", () => {
  const fields = (quote: string) => ({
    messageKey: "message:1",
    messageExcerpt: "reply",
    anchor: { kind: "text" as const, quote, prefix: "", suffix: "" },
    body: quote,
  });

  it("shows a comment at once, keeps it through host lists, and confirms it once", async () => {
    const sessionId = "store-local-success";
    installList(vi.fn(async () => []));
    const { result } = renderHook(() => useThreadComments(sessionId, null));
    await waitFor(() => expect(result.current).toEqual([]));

    let settle!: ReturnType<typeof addLocalThreadComment>;
    act(() => { settle = addLocalThreadComment(sessionId, fields("new")); });
    expect(result.current.map((entry) => entry.body)).toEqual(["new"]);
    expect(countCommentsForNextSend(result.current)).toBe(1);

    // A host list from before the save (another comment's event) replaces the
    // host half of the store; the comment still being saved stays visible.
    act(() => setThreadComments(sessionId, [comment("other", sessionId)]));
    expect(result.current.map((entry) => entry.body)).toEqual(["other", "new"]);

    // The host's change event lands before the save call answers.
    const saved = { ...comment("saved-1", sessionId), body: "new" };
    act(() => setThreadComments(sessionId, [comment("other", sessionId), saved]));
    act(() => settle(saved));
    expect(result.current.map((entry) => entry.id)).toEqual(["other", "saved-1"]);
  });

  it("joins the saved comment when its answer beats the host event, and drops a failed one", async () => {
    const sessionId = "store-local-settle";
    installList(vi.fn(async () => []));
    const { result } = renderHook(() => useThreadComments(sessionId, null));
    await waitFor(() => expect(result.current).toEqual([]));

    let settleSaved!: ReturnType<typeof addLocalThreadComment>;
    let settleFailed!: ReturnType<typeof addLocalThreadComment>;
    act(() => {
      settleSaved = addLocalThreadComment(sessionId, fields("kept"));
      settleFailed = addLocalThreadComment(sessionId, fields("refused"));
    });
    expect(result.current.map((entry) => entry.body)).toEqual(["kept", "refused"]);

    const saved = { ...comment("saved-2", sessionId), body: "kept" };
    act(() => settleSaved(saved));
    act(() => settleFailed(null));
    expect(result.current.map((entry) => entry.id)).toEqual(["saved-2"]);
    expect(countCommentsForNextSend(result.current)).toBe(1);
  });
});
