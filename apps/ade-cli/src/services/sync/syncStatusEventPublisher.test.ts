import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSyncStatusEventPublisher } from "./syncStatusEventPublisher";

type Snapshot = { mode: string; peers?: number };

describe("createSyncStatusEventPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the first status immediately", () => {
    const emit = vi.fn();
    const publisher = createSyncStatusEventPublisher<Snapshot>({ emit, intervalMs: 250 });

    publisher.publish({ mode: "host" });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ mode: "host" });
    publisher.dispose();
  });

  it("drops a snapshot identical to the one already published", () => {
    // The sync service re-reports its status on transitions that did not
    // change it. Each republish costs a full ~5 KB snapshot on the wire to
    // tell every client what it already knows.
    const emit = vi.fn();
    const publisher = createSyncStatusEventPublisher<Snapshot>({ emit, intervalMs: 250 });

    publisher.publish({ mode: "host", peers: 1 });
    vi.advanceTimersByTime(5_000);
    publisher.publish({ mode: "host", peers: 1 });
    vi.advanceTimersByTime(5_000);

    expect(emit).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("collapses a storm to one event per window, carrying the newest snapshot", () => {
    // This is the shape that took the paired transport down: a reconnect loop
    // reported hundreds of status transitions a second, every one a full
    // snapshot, onto a runtime event stream a remote desktop drains over
    // `rpc_data` — a required send the host buffers rather than drops.
    const emit = vi.fn();
    const publisher = createSyncStatusEventPublisher<Snapshot>({ emit, intervalMs: 250 });

    publisher.publish({ mode: "host", peers: 0 });
    expect(emit).toHaveBeenCalledTimes(1);

    for (let peers = 1; peers <= 200; peers += 1) {
      publisher.publish({ mode: "host", peers });
    }
    // Still one: the 200 that arrived inside the window replaced each other
    // rather than queueing.
    expect(emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(emit).toHaveBeenCalledTimes(2);
    // And what lands is the newest, not the oldest of the batch.
    expect(emit).toHaveBeenLastCalledWith({ mode: "host", peers: 200 });
    publisher.dispose();
  });

  it("does not flush a trailing snapshot that the last publish already matched", () => {
    const emit = vi.fn();
    const publisher = createSyncStatusEventPublisher<Snapshot>({ emit, intervalMs: 250 });

    publisher.publish({ mode: "host", peers: 0 });
    publisher.publish({ mode: "host", peers: 1 });
    // Flaps back to what is already on the wire before the window ends.
    publisher.publish({ mode: "host", peers: 0 });
    vi.advanceTimersByTime(1_000);

    expect(emit).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("stops publishing once disposed", () => {
    const emit = vi.fn();
    const publisher = createSyncStatusEventPublisher<Snapshot>({ emit, intervalMs: 250 });

    publisher.publish({ mode: "host", peers: 0 });
    publisher.publish({ mode: "host", peers: 1 });
    publisher.dispose();
    vi.advanceTimersByTime(1_000);
    publisher.publish({ mode: "viewer" });

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
