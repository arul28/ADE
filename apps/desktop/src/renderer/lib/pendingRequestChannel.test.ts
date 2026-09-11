import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedPendingStore, createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * The rule every hand-rolled copy of this re-learned in a comment: a request is
 * broadcast AND held, and a live consumer must clear the hold or the next
 * surface to mount reopens something nobody asked for.
 */
describe("createPendingRequestChannel", () => {
  let channel: ReturnType<typeof createPendingRequestChannel<{ tool: string }>>;

  beforeEach(() => {
    channel = createPendingRequestChannel<{ tool: string }>("test");
    channel.resetForTests();
  });

  it("broadcasts to live listeners and holds for the ones that mount later", () => {
    const listener = vi.fn();
    channel.subscribe(listener);
    channel.request({ tool: "browser" });
    expect(listener).toHaveBeenCalledWith({ tool: "browser", nonce: "test-1" });
    expect(channel.takePending()).toEqual({ tool: "browser", nonce: "test-1" });
    // Draining is one-shot.
    expect(channel.takePending()).toBeNull();
  });

  it("delivers one request to every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    channel.subscribe(first);
    channel.subscribe(second);
    const sent = channel.request({ tool: "browser" });
    expect(first).toHaveBeenCalledWith(sent);
    expect(second).toHaveBeenCalledWith(sent);
  });

  it("mints a fresh nonce so asking twice is two requests, not one duplicate", () => {
    const first = channel.request({ tool: "git" });
    const second = channel.request({ tool: "git" });
    expect(first.nonce).toBe("test-1");
    expect(second.nonce).toBe("test-2");
  });

  it("keeps a nonce the caller already minted, and counts it once", () => {
    // filesOpenRequests assembles the whole request before sending it, so the
    // nonce comes from nextNonce rather than from request().
    const minted = channel.nextNonce();
    expect(minted).toBe("test-1");
    const sent = channel.request({ tool: "files", nonce: minted } as { tool: string });
    expect(sent.nonce).toBe("test-1");
    expect(channel.request({ tool: "files" }).nonce).toBe("test-2");
  });

  it("lets a live consumer drop the hold it already acted on", () => {
    channel.request({ tool: "files" });
    channel.clearPending();
    expect(channel.takePending()).toBeNull();
  });

  it("stops delivering to an unsubscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = channel.subscribe(listener);
    unsubscribe();
    channel.request({ tool: "pr" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("drops listeners, the hold and the nonce counter on reset", () => {
    const listener = vi.fn();
    channel.subscribe(listener);
    channel.request({ tool: "ios" });
    channel.resetForTests();
    expect(channel.takePending()).toBeNull();
    expect(channel.request({ tool: "ios" }).nonce).toBe("test-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps two channels' nonces and holds apart", () => {
    const other = createPendingRequestChannel<{ path: string }>("other");
    channel.request({ tool: "ios" });
    expect(other.takePending()).toBeNull();
    expect(other.request({ path: "/a" }).nonce).toBe("other-1");
  });
});

describe("createKeyedPendingStore", () => {
  let store: ReturnType<typeof createKeyedPendingStore<{ line: number }>>;

  beforeEach(() => {
    store = createKeyedPendingStore<{ line: number }>();
  });

  it("parks a value for the surface that owns the key", () => {
    store.set("src/a.ts", { line: 12 });
    expect(store.take("src/a.ts")).toEqual({ line: 12 });
    // Claiming is one-shot.
    expect(store.take("src/a.ts")).toBeNull();
  });

  it("keeps keys independent and reports a miss as null", () => {
    store.set("src/a.ts", { line: 1 });
    expect(store.take("src/b.ts")).toBeNull();
    expect(store.take("src/a.ts")).toEqual({ line: 1 });
  });

  it("peeks without consuming", () => {
    store.set("src/a.ts", { line: 3 });
    expect(store.peek("src/a.ts")).toEqual({ line: 3 });
    expect(store.peek("src/a.ts")).toEqual({ line: 3 });
    expect(store.take("src/a.ts")).toEqual({ line: 3 });
    expect(store.peek("src/a.ts")).toBeNull();
  });

  it("replaces rather than queues a second value for the same key", () => {
    store.set("src/a.ts", { line: 1 });
    store.set("src/a.ts", { line: 2 });
    expect(store.take("src/a.ts")).toEqual({ line: 2 });
  });

  it("drops everything parked on reset", () => {
    store.set("src/a.ts", { line: 1 });
    store.resetForTests();
    expect(store.take("src/a.ts")).toBeNull();
  });
});
