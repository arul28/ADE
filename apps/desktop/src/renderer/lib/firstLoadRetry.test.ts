/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteRuntimeConnectionSnapshot } from "../../shared/types";

const sentry = vi.hoisted(() => ({ captureProblem: vi.fn(), forwardSignalToSentry: vi.fn() }));
vi.mock("../../shared/sentry/capture", async (actual) => ({
  ...(await actual<object>()),
  captureProblem: sentry.captureProblem,
}));
vi.mock("../../shared/sentry/logBridge", async (actual) => ({
  ...(await actual<object>()),
  forwardSignalToSentry: sentry.forwardSignalToSentry,
}));

import { runFirstLoadWithRetry } from "./firstLoadRetry";

type SnapshotListener = (snapshot: RemoteRuntimeConnectionSnapshot) => void;

const TARGET_ID = "machine-1";
let connectionState: string;
let snapshotListeners: Set<SnapshotListener>;

function snapshot(state: string): RemoteRuntimeConnectionSnapshot {
  return { updatedAt: 1, connections: [{ target: { id: TARGET_ID }, state }] } as unknown as RemoteRuntimeConnectionSnapshot;
}

function failingLoads() {
  const rejects: Array<(error: Error) => void> = [];
  const load = vi.fn(() => new Promise<void>((_resolve, reject) => rejects.push(reject)));
  return { load, rejects };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("runFirstLoadWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sentry.captureProblem.mockClear();
    sentry.forwardSignalToSentry.mockClear();
    connectionState = "connected";
    snapshotListeners = new Set();
    Object.assign(window, {
      ade: {
        analytics: { capture: vi.fn(async () => ({ accepted: true })) },
        remoteRuntime: {
          getConnectionSnapshot: async () => snapshot(connectionState),
          onConnectionSnapshotChanged: (listener: SnapshotListener) => {
            snapshotListeners.add(listener);
            return () => snapshotListeners.delete(listener);
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps trying until a load works, then stops, and a first success starts nothing", async () => {
    const healthyLoad = vi.fn(async () => {});
    const healthyRetrying = vi.fn();
    runFirstLoadWithRetry({ surface: "sessions", targetId: TARGET_ID, load: healthyLoad, onRetryingChange: healthyRetrying });
    await advance(0);
    expect(healthyLoad).toHaveBeenCalledTimes(1);
    expect(healthyRetrying).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(snapshotListeners.size).toBe(0);

    connectionState = "error";
    let failuresLeft = 3;
    const load = vi.fn(async () => {
      if (failuresLeft-- > 0) throw new Error("not yet");
    });
    const retrying = vi.fn();
    runFirstLoadWithRetry({ surface: "sessions", targetId: TARGET_ID, load, onRetryingChange: retrying });
    await advance(0);
    expect(retrying).toHaveBeenLastCalledWith(true);

    await advance(60_000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(retrying).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(snapshotListeners.size).toBe(0);
    expect(sentry.forwardSignalToSentry.mock.calls.map(([event]) => event)).toEqual(["work.first_load_recovered"]);
  });

  it("retries as soon as an attempt ends when the machine reconnected during it, and cancel stops everything", async () => {
    connectionState = "connecting";
    const { load, rejects } = failingLoads();
    const cancel = runFirstLoadWithRetry({ surface: "lanes", targetId: TARGET_ID, load });
    rejects[0]!(new Error("first"));
    await advance(1_000);
    expect(load).toHaveBeenCalledTimes(2);

    for (const listener of snapshotListeners) listener(snapshot("connected"));
    expect(load).toHaveBeenCalledTimes(2);
    rejects[1]!(new Error("second"));
    await advance(0);
    expect(load).toHaveBeenCalledTimes(3);

    cancel();
    rejects[2]!(new Error("third"));
    await advance(120_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(snapshotListeners.size).toBe(0);
  });

  it("opens one issue only once the machine is connected, and never sends the error's text", async () => {
    connectionState = "error";
    const load = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 100.117.1.2:22 on studio.tailnet.ts.net: timed out");
    });
    const cancel = runFirstLoadWithRetry({ surface: "sessions", targetId: TARGET_ID, load });
    await advance(120_000);
    expect(sentry.captureProblem).not.toHaveBeenCalled();
    const waiting = sentry.forwardSignalToSentry.mock.calls.filter(([event]) => event === "work.first_load_waiting");
    expect(waiting).toHaveLength(1);

    connectionState = "connected";
    await advance(120_000);
    cancel();
    expect(sentry.captureProblem).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify([sentry.captureProblem.mock.calls, sentry.forwardSignalToSentry.mock.calls]);
    expect(sent).toContain('"errorClass":"timeout"');
    expect(sent).not.toContain("100.117.1.2");
    expect(sent).not.toContain("studio.tailnet");
  });
});
