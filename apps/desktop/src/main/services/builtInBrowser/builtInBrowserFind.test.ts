import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { awaitFoundInPage, type BuiltInBrowserFindWaiters } from "./builtInBrowserFind";

/**
 * Stand-in for the `found-in-page` half of a `WebContents`. `findInPage`
 * returns ids from a queue and can emit synchronously — the race the waiter
 * exists to survive.
 */
function fakeWebContents(options: {
  ids?: number[];
  emitOnFind?: (emit: (result: Record<string, unknown>) => void, requestId: number) => void;
} = {}) {
  const emitter = new EventEmitter();
  const ids = [...(options.ids ?? [1])];
  const stopCalls: string[] = [];
  const findCalls: Array<{ text: string; findNext?: boolean; forward?: boolean; matchCase?: boolean }> = [];
  const emit = (result: Record<string, unknown>): void => {
    emitter.emit("found-in-page", {}, result);
  };
  const wc = {
    on: (event: string, fn: (...a: unknown[]) => void) => emitter.on(event, fn),
    removeListener: (event: string, fn: (...a: unknown[]) => void) => emitter.removeListener(event, fn),
    stopFindInPage: (action: string) => {
      stopCalls.push(action);
    },
    findInPage: (text: string, opts: Record<string, unknown>) => {
      const id = ids.shift() ?? 1;
      findCalls.push({ text, ...opts });
      options.emitOnFind?.(emit, id);
      return id;
    },
    listenerCount: (event: string) => emitter.listenerCount(event),
  };
  return { wc: wc as unknown as WebContents, emit, stopCalls, findCalls, raw: wc };
}

const waiters = (): BuiltInBrowserFindWaiters => new Set<(requestId: number) => void>();

const findArgs = (over: Partial<Parameters<typeof awaitFoundInPage>[2]> = {}) => ({
  text: "hello",
  forward: true,
  matchCase: false,
  findNext: false,
  timeoutMs: 1_000,
  ...over,
});

describe("awaitFoundInPage", () => {
  it("resolves on the first result for its own request and drops other ids", async () => {
    const { wc, emit } = fakeWebContents({ ids: [7] });
    const pending = awaitFoundInPage(wc, waiters(), findArgs());
    emit({ requestId: 6, matches: 99, activeMatchOrdinal: 1 });
    emit({ requestId: 7, matches: 3, activeMatchOrdinal: 1, finalUpdate: false });
    await expect(pending).resolves.toMatchObject({ requestId: 7, matches: 3 });
  });

  // Chromium can emit synchronously from inside `findInPage`, before the caller
  // has an id to compare against.
  it("replays a result that arrived before the request id was known", async () => {
    const { wc } = fakeWebContents({
      ids: [11],
      emitOnFind: (emit) => emit({ requestId: 11, matches: 2, activeMatchOrdinal: 1 }),
    });
    await expect(awaitFoundInPage(wc, waiters(), findArgs()))
      .resolves.toMatchObject({ requestId: 11, matches: 2 });
  });

  // A find under 4 characters is delayed 400ms and the NEXT find resets the
  // delayed task, discarding the earlier id. The in-flight waiter follows.
  it("adopts the request id of a find that supersedes it", async () => {
    const shared = waiters();
    const { wc, emit } = fakeWebContents({ ids: [1, 2] });
    const first = awaitFoundInPage(wc, shared, findArgs({ text: "ab" }));
    const second = awaitFoundInPage(wc, shared, findArgs({ text: "abc" }));
    emit({ requestId: 2, matches: 5, activeMatchOrdinal: 1 });
    await expect(first).resolves.toMatchObject({ requestId: 2, matches: 5 });
    await expect(second).resolves.toMatchObject({ requestId: 2, matches: 5 });
  });

  it("clears the selection for a new search and keeps it for find-next", async () => {
    const fresh = fakeWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(fresh.wc, waiters(), findArgs({ findNext: false }));
    expect(fresh.stopCalls).toEqual(["clearSelection"]);

    const next = fakeWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(next.wc, waiters(), findArgs({ findNext: true }));
    expect(next.stopCalls).toEqual([]);
    // Every find we issue starts a Chromium session; `findNext` selects whether
    // the selection was cleared first, not what is sent.
    expect(next.findCalls[0]).toMatchObject({ findNext: true, forward: true, matchCase: false });
  });

  it("returns the last result it saw rather than a timeout error", async () => {
    vi.useFakeTimers();
    try {
      const { wc, emit } = fakeWebContents({ ids: [4] });
      const pending = awaitFoundInPage(wc, waiters(), findArgs({ timeoutMs: 500 }));
      emit({ requestId: 4, matches: 8, activeMatchOrdinal: 2, finalUpdate: false });
      await expect(pending).resolves.toMatchObject({ matches: 8 });

      const silent = fakeWebContents({ ids: [5] });
      const timingOut = awaitFoundInPage(silent.wc, waiters(), findArgs({ timeoutMs: 500 }));
      const assertion = expect(timingOut).rejects.toThrow(/Timed out waiting for browser find results/);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches its listener however it settles", async () => {
    const settled = fakeWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(settled.wc, waiters(), findArgs());
    expect(settled.raw.listenerCount("found-in-page")).toBe(0);

    const throwing = fakeWebContents({ ids: [1] });
    throwing.raw.findInPage = () => {
      throw new Error("tab is gone");
    };
    await expect(awaitFoundInPage(throwing.wc, waiters(), findArgs())).rejects.toThrow(/tab is gone/);
    expect(throwing.raw.listenerCount("found-in-page")).toBe(0);
  });
});
