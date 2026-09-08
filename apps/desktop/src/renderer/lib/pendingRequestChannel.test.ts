import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * The rule four hand-rolled copies of this each re-learned in a comment: a
 * request is broadcast AND held, and a live consumer must clear the hold or the
 * next surface to mount reopens something nobody asked for.
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

  it("mints a fresh nonce so asking twice is two requests, not one duplicate", () => {
    const first = channel.request({ tool: "git" });
    const second = channel.request({ tool: "git" });
    expect(first.nonce).not.toBe(second.nonce);
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

  it("keeps two channels' nonces and holds apart", () => {
    const other = createPendingRequestChannel<{ path: string }>("other");
    channel.request({ tool: "ios" });
    expect(other.takePending()).toBeNull();
    expect(other.request({ path: "/a" }).nonce).toBe("other-1");
  });
});
