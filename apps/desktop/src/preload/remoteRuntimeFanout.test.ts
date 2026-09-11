import { describe, expect, it, vi } from "vitest";
import {
  createRemoteRuntimeFanout,
  dispatchRemoteRuntimeFanouts,
  hasRemoteRuntimeFanoutSubscribers,
} from "./remoteRuntimeFanout";

describe("createRemoteRuntimeFanout", () => {
  it("delivers the wrapped event to every subscriber and reports the match", () => {
    const fanout = createRemoteRuntimeFanout<{ id: string }>({
      eventType: "lane_port_event",
      label: "lane port",
    });
    const first = vi.fn();
    const second = vi.fn();
    fanout.subscribe(first);
    fanout.subscribe(second);

    expect(fanout.dispatch({ type: "lane_port_event", event: { id: "a" } })).toBe(true);
    expect(fanout.dispatch({ type: "lane_env_event", event: { id: "b" } })).toBe(false);

    expect(first).toHaveBeenCalledWith({ id: "a" });
    expect(second).toHaveBeenCalledWith({ id: "a" });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("tracks subscriber liveness so the event pump can stand down", () => {
    const fanout = createRemoteRuntimeFanout<unknown>({ eventType: "pr_event", label: "PR" });
    expect(fanout.hasSubscribers).toBe(false);
    expect(hasRemoteRuntimeFanoutSubscribers([fanout])).toBe(false);

    const unsubscribe = fanout.subscribe(vi.fn());
    expect(fanout.hasSubscribers).toBe(true);
    expect(hasRemoteRuntimeFanoutSubscribers([fanout])).toBe(true);

    unsubscribe();
    expect(fanout.hasSubscribers).toBe(false);
    expect(hasRemoteRuntimeFanoutSubscribers([fanout])).toBe(false);
  });

  it("runs the pump hook on every subscribe", () => {
    const onSubscribe = vi.fn();
    const fanout = createRemoteRuntimeFanout<unknown>({
      eventType: "review_event",
      label: "review",
      onSubscribe,
    });
    fanout.subscribe(vi.fn());
    fanout.subscribe(vi.fn());
    expect(onSubscribe).toHaveBeenCalledTimes(2);
  });

  it("invalidates caches on a matched event even with nobody listening", () => {
    // The cache belongs to the domain, not the subscriber: a read taken after
    // an unwatched event must not serve state that event already superseded.
    const invalidate = vi.fn();
    const fanout = createRemoteRuntimeFanout<unknown>({
      eventType: "file_change",
      label: "file change",
      invalidate,
    });

    fanout.dispatch({ type: "file_change", event: {} });
    expect(invalidate).toHaveBeenCalledTimes(1);

    fanout.dispatch({ type: "pr_event", event: {} });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("honours a per-event delivery filter without losing the match", () => {
    const seen = vi.fn();
    const fanout = createRemoteRuntimeFanout<{ ptyId: string }>({
      eventType: "pty_data",
      label: "pty data",
      shouldDeliver: (event) => event.ptyId === "watched",
    });
    fanout.subscribe(seen);

    expect(fanout.dispatch({ type: "pty_data", event: { ptyId: "other" } })).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    fanout.dispatch({ type: "pty_data", event: { ptyId: "watched" } });
    expect(seen).toHaveBeenCalledWith({ ptyId: "watched" });
  });

  it("uses a custom extractor for domains that are not `{ type, event }`", () => {
    const seen = vi.fn();
    const fanout = createRemoteRuntimeFanout<{ snapshot: unknown }>({
      eventType: "sync-status",
      label: "sync",
      extract: (payload) => (payload.type === "sync-status" ? (payload as { snapshot: unknown }) : null),
    });
    fanout.subscribe(seen);

    fanout.dispatch({ type: "sync-status", snapshot: { role: "host" } });
    expect(seen).toHaveBeenCalledWith({ type: "sync-status", snapshot: { role: "host" } });
  });

  it("keeps one throwing listener from stopping the rest", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fanout = createRemoteRuntimeFanout<unknown>({
      eventType: "conflict_event",
      label: "conflict",
    });
    const after = vi.fn();
    fanout.subscribe(() => {
      throw new Error("boom");
    });
    fanout.subscribe(after);

    fanout.dispatch({ type: "conflict_event", event: {} });

    expect(after).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("offers one payload to every domain rather than stopping at the first match", () => {
    const a = createRemoteRuntimeFanout<unknown>({ eventType: "pr_event", label: "PR" });
    const b = createRemoteRuntimeFanout<unknown>({
      eventType: "pr_event",
      label: "PR mirror",
    });
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.subscribe(seenA);
    b.subscribe(seenB);

    dispatchRemoteRuntimeFanouts([a, b], { type: "pr_event", event: {} });

    expect(seenA).toHaveBeenCalledTimes(1);
    expect(seenB).toHaveBeenCalledTimes(1);
  });
});
