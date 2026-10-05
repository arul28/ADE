import { describe, expect, it } from "vitest";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type {
  AppControlEventPayload,
  AppControlScreencastFrame,
  AppControlSession,
} from "../../../../desktop/src/shared/types/appControl";
import {
  APP_CONTROL_STREAM_SUBSCRIPTION_LIMIT_CODE,
  AppControlSyncStreamError,
  createAppControlSyncStream,
  type AppControlSyncStreamSink,
} from "./appControlSyncStream";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function sink(): AppControlSyncStreamSink {
  return {
    connectionId: "conn-1",
    sendFrame: () => true,
    sendEnded: () => undefined,
    pendingBytes: () => 0,
  };
}

describe("createAppControlSyncStream", () => {
  it("leaves no subscription when unsubscribe or release lands during the status read", async () => {
    let resolveStatus: (value: { activeSession: null }) => void = () => undefined;
    const stream = createAppControlSyncStream({
      logger,
      source: {
        getStatus: () => new Promise((resolve) => {
          resolveStatus = resolve;
        }),
        subscribeEvents: () => () => undefined,
      },
    });

    const pending = stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink(),
    });
    stream.unsubscribe("sub-1", "conn-1");
    resolveStatus({ activeSession: null });
    await pending;
    expect(stream.subscriptionCount()).toBe(0);

    let resolveReleased: (value: { activeSession: null }) => void = () => undefined;
    const released = createAppControlSyncStream({
      logger,
      source: {
        getStatus: () => new Promise((resolve) => {
          resolveReleased = resolve;
        }),
        subscribeEvents: () => () => undefined,
      },
    });
    const second = released.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-2",
      connectionId: "conn-1",
      sink: sink(),
    });
    released.releaseConnection("conn-1");
    resolveReleased({ activeSession: null });
    await second;
    expect(released.subscriptionCount()).toBe(0);
  });

  it("caps a connection at 8 subscriptions and 2 per lane", async () => {
    const stream = createAppControlSyncStream({
      logger,
      source: {
        getStatus: async () => ({ activeSession: null }),
        subscribeEvents: () => () => undefined,
      },
    });
    await stream.subscribe({ laneId: "lane-1", subscriptionId: "a", connectionId: "conn-1", sink: sink() });
    await stream.subscribe({ laneId: "lane-1", subscriptionId: "b", connectionId: "conn-1", sink: sink() });
    await expect(stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "c",
      connectionId: "conn-1",
      sink: sink(),
    })).rejects.toMatchObject({ code: APP_CONTROL_STREAM_SUBSCRIPTION_LIMIT_CODE });

    for (let index = 0; index < 6; index += 1) {
      await stream.subscribe({
        laneId: `lane-${index + 2}`,
        subscriptionId: `extra-${index}`,
        connectionId: "conn-1",
        sink: sink(),
      });
    }
    expect(stream.subscriptionCount()).toBe(8);
    await expect(stream.subscribe({
      laneId: "lane-9",
      subscriptionId: "ninth",
      connectionId: "conn-1",
      sink: sink(),
    })).rejects.toBeInstanceOf(AppControlSyncStreamError);
    expect(stream.subscriptionCount()).toBe(8);
  });

  it("tells the service which lanes it has viewers for", async () => {
    const demand: string[][] = [];
    const stream = createAppControlSyncStream({
      logger,
      source: {
        getStatus: async () => ({ activeSession: null }),
        subscribeEvents: () => () => undefined,
        setFrameDemand: (_sourceId, laneIds) => demand.push([...laneIds].sort()),
      },
    });
    await stream.subscribe({ laneId: "lane-1", subscriptionId: "a", connectionId: "conn-1", sink: sink() });
    await stream.subscribe({ laneId: "lane-2", subscriptionId: "b", connectionId: "conn-1", sink: sink() });
    expect(demand.at(-1)).toEqual(["lane-1", "lane-2"]);
    stream.unsubscribe("a", "conn-1");
    expect(demand.at(-1)).toEqual(["lane-2"]);
    stream.releaseConnection("conn-1");
    expect(demand.at(-1)).toEqual([]);
  });

  it("gives a new viewer a fresh picture instead of a frame from before the lane was paused", async () => {
    let clock = 0;
    let emit: (event: AppControlEventPayload) => void = () => undefined;
    const session = { id: "app-1", laneId: "lane-1" } as AppControlSession;
    const frame = (data: string) => ({ sessionId: "app-1", laneId: "lane-1", data, mimeType: "image/jpeg", width: 2, height: 2 }) as AppControlScreencastFrame;
    const sent: string[] = [];
    const timers: Array<() => void> = [];
    const stream = createAppControlSyncStream({
      logger,
      now: () => clock,
      setTimer: (callback) => { timers.push(callback); return timers.length; },
      clearTimer: () => undefined,
      source: {
        getStatus: async () => ({ activeSession: session, sessions: [session] }),
        subscribeEvents: (listener) => { emit = listener; return () => undefined; },
        getLatestFrame: async () => frame("fresh"),
      },
    });
    emit({ type: "frame", laneId: "lane-1", frame: frame("from before the pause") });
    clock = 60_000;

    await stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "viewer",
      connectionId: "conn-1",
      sink: { ...sink(), sendFrame: (payload) => { sent.push(payload.data); return true; } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    while (timers.length > 0) timers.shift()!();
    expect(sent).toEqual(["fresh"]);
  });
});

