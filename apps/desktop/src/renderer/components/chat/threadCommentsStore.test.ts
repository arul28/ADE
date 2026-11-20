/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadComment } from "../../../shared/threadComments";
import {
  addLocalThreadComment,
  countCommentsForNextSend,
  countFailedThreadComments,
  countThreadCommentsReadyToSend,
  discardFailedThreadComment,
  refreshThreadComments,
  retryFailedThreadComment,
  setThreadComments,
  threadCommentClientIdsToExclude,
  threadCommentSaveError,
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

/** The chat's machine: its comments are listed there. */
const CHAT_PIN = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as const;

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

    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));

    await waitFor(() => expect(result.current.map((entry) => entry.id)).toEqual(["host-1"]));
  });

  it("does not overwrite a newer live update with an in-flight list", async () => {
    const sessionId = "store-race-session";
    let resolveList!: (rows: ChatThreadComment[]) => void;
    const list = vi.fn(() => new Promise<ChatThreadComment[]>((resolve) => { resolveList = resolve; }));
    installList(list);

    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
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
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
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
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
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

  // A create whose answer is lost may still have saved: the comment must not
  // vanish (the person's text is gone) nor be saved twice on Retry (create is
  // not idempotent), and it never rides a send while it is unsaved.
  it("keeps a failed comment for Retry and saves it once, finding a copy the lost answer already saved", async () => {
    const sessionId = "store-local-retry";
    let hostList: ChatThreadComment[] = [];
    const list = vi.fn(async () => hostList);
    const create = vi.fn(async (args: { body: string }) => ({ ...comment("created-1", sessionId), body: args.body }));
    (window as unknown as { ade: unknown }).ade = { agentChat: { threadComments: { list, create } } };
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    let landed!: ReturnType<typeof addLocalThreadComment>;
    let refused!: ReturnType<typeof addLocalThreadComment>;
    act(() => {
      landed = addLocalThreadComment(sessionId, fields("landed"));
      refused = addLocalThreadComment(sessionId, fields("refused"));
    });
    act(() => {
      landed(null, "Can't reach the computer");
      refused(null, "Can't reach the computer");
    });
    expect(result.current.map((entry) => entry.body)).toEqual(["landed", "refused"]);
    expect(threadCommentSaveError(landed.localId)).toBe("Can't reach the computer");
    expect(countFailedThreadComments(result.current)).toBe(2);
    expect(countCommentsForNextSend(result.current)).toBe(0);

    // The first one's save landed after all: Retry finds it and creates nothing.
    hostList = [{ ...comment("landed-on-host", sessionId), body: "landed", anchor: { kind: "text", quote: "landed", prefix: "", suffix: "" } }];
    await act(() => retryFailedThreadComment(sessionId, landed.localId, CHAT_PIN, String));
    expect(create).not.toHaveBeenCalled();
    // The second never landed: Retry creates it, once.
    await act(() => retryFailedThreadComment(sessionId, refused.localId, CHAT_PIN, String));
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.current.map((entry) => entry.id)).toEqual(["landed-on-host", "created-1"]);
    expect(countFailedThreadComments(result.current)).toBe(0);
    expect(countCommentsForNextSend(result.current)).toBe(2);
  });

  // A host that keeps client ids: the comment's id, not its text, says which
  // host comment is which, so a lost answer can be retried, discarded, or
  // kept out of a send without touching a twin with the same quote and body.
  function installClientIdHost(sessionId: string) {
    let next = 0;
    const host = { list: [] as ChatThreadComment[] };
    const create = vi.fn(async (args: { clientId?: string; body: string; anchor: ChatThreadComment["anchor"] }) => {
      const existing = host.list.find((entry) => entry.clientId === args.clientId);
      if (existing) return existing;
      const made = { ...comment(`host-${(next += 1)}`, sessionId), body: args.body, anchor: args.anchor, clientId: args.clientId };
      host.list = [...host.list, made];
      return made;
    });
    const list = vi.fn(async () => host.list);
    const remove = vi.fn(async (args: { commentId: string }) => {
      host.list = host.list.filter((entry) => entry.id !== args.commentId);
      return { deleted: true };
    });
    const update = vi.fn(async (args: { commentId: string; includeInNextSend?: boolean }) => {
      host.list = host.list.map((entry) => (entry.id === args.commentId ? { ...entry, includeInNextSend: args.includeInNextSend ?? entry.includeInNextSend } : entry));
      return host.list.find((entry) => entry.id === args.commentId)!;
    });
    (window as unknown as { ade: unknown }).ade = { agentChat: { threadComments: { list, create, delete: remove, update } } };
    return { host, create, remove, update };
  }

  /** A create that reached the host whose answer never came back. */
  async function lostAnswer(sessionId: string, create: ReturnType<typeof installClientIdHost>["create"], quote: string) {
    let settle!: ReturnType<typeof addLocalThreadComment>;
    act(() => { settle = addLocalThreadComment(sessionId, fields(quote)); });
    const { messageKey, messageExcerpt, anchor, body } = fields(quote);
    await create({ sessionId, messageKey, messageExcerpt, anchor, body, clientId: settle.clientId } as never);
    act(() => settle(null, "Can't reach the computer"));
    return settle;
  }

  it("retries with the same client id and never takes a twin's copy for its own", async () => {
    const sessionId = "store-client-id-retry";
    const { host, create } = installClientIdHost(sessionId);
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
    await waitFor(() => expect(result.current).toEqual([]));

    // Two comments with the same quote and body: the first landed, the second never did.
    await lostAnswer(sessionId, create, "same");
    let twin!: ReturnType<typeof addLocalThreadComment>;
    act(() => { twin = addLocalThreadComment(sessionId, fields("same")); });
    act(() => twin(null, "Can't reach the computer"));
    // The host's change event for the first one: it replaces only its own local comment.
    act(() => setThreadComments(sessionId, host.list));
    expect(result.current.map((entry) => entry.id)).toEqual(["host-1", twin.localId]);
    expect(threadCommentSaveError(twin.localId)).toBe("Can't reach the computer");

    await act(() => retryFailedThreadComment(sessionId, twin.localId, CHAT_PIN, String));
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: twin.clientId }), CHAT_PIN);
    expect(result.current.map((entry) => entry.id)).toEqual(["host-1", "host-2"]);
    expect(host.list).toHaveLength(2);
  });

  it("names failed and discarding comments in a send's exclusion list, and deletes the copy on Discard", async () => {
    const sessionId = "store-client-id-discard";
    const { host, create, remove } = installClientIdHost(sessionId);
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
    await waitFor(() => expect(result.current).toEqual([]));

    // Shown as failed, though its copy landed: the send excludes it by client
    // id, so the host keeps that copy out of the send and on its list.
    const stillFailed = await lostAnswer(sessionId, create, "still failed");
    expect(countThreadCommentsReadyToSend(sessionId)).toBe(0);
    expect(threadCommentClientIdsToExclude(sessionId)).toEqual([stillFailed.clientId]);

    // Discard: excluded until the host's copy is deleted, then gone everywhere.
    const discarded = await lostAnswer(sessionId, create, "discard me");
    let finishDelete!: () => void;
    remove.mockImplementationOnce(async (args: { commentId: string }) => {
      await new Promise<void>((resolve) => { finishDelete = resolve; });
      host.list = host.list.filter((entry) => entry.id !== args.commentId);
      return { deleted: true };
    });
    let discarding!: Promise<void>;
    act(() => { discarding = discardFailedThreadComment(sessionId, discarded.localId, CHAT_PIN, String); });
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ sessionId, commentId: "host-2" }, CHAT_PIN));
    // The discard's list read showed the first one's landed copy: it is now the
    // saved comment the person sees, and goes with the next send like any other.
    expect(result.current.map((entry) => entry.id)).toEqual(["host-1"]);
    expect(threadCommentClientIdsToExclude(sessionId)).toEqual([discarded.clientId]);
    await act(async () => { finishDelete(); await discarding; });
    expect(host.list.map((entry) => entry.id)).toEqual(["host-1"]);
    expect(threadCommentClientIdsToExclude(sessionId)).toEqual([]);
    expect(countThreadCommentsReadyToSend(sessionId)).toBe(1);
  });

  it("keeps a comment whose Discard could not reach the host, marked, for another Discard", async () => {
    const sessionId = "store-client-id-discard-fails";
    const { host, create, remove } = installClientIdHost(sessionId);
    const { result } = renderHook(() => useThreadComments(sessionId, CHAT_PIN));
    await waitFor(() => expect(result.current).toEqual([]));

    const failed = await lostAnswer(sessionId, create, "discard me");
    remove.mockRejectedValueOnce(new Error("offline"));
    await act(() => discardFailedThreadComment(sessionId, failed.localId, CHAT_PIN, (error) => (error as Error).message));
    await waitFor(() => expect(result.current.map((entry) => entry.id)).toEqual([failed.localId]));
    expect(threadCommentSaveError(failed.localId)).toBe("offline");
    // Its host copy is still there: sends keep excluding it.
    expect(threadCommentClientIdsToExclude(sessionId)).toEqual([failed.clientId]);

    await act(() => discardFailedThreadComment(sessionId, failed.localId, CHAT_PIN, String));
    expect(host.list).toEqual([]);
    expect(result.current).toEqual([]);
  });
});
