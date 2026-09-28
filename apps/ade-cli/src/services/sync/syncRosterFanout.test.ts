import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncRosterProject } from "../../../../desktop/src/shared/types";
import { createSyncRosterFanout, createSyncRosterPeerState } from "./syncRosterFanout";

describe("sync roster fanout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one follow-up build when a dirty mark arrives during a flush", async () => {
    vi.useFakeTimers();
    let releaseFirstFlush!: (projects: SyncRosterProject[]) => void;
    const firstFlush = new Promise<SyncRosterProject[]>((resolve) => {
      releaseFirstFlush = resolve;
    });
    let buildCount = 0;
    const project = (name: string): SyncRosterProject => ({
      projectId: "project-1",
      displayName: name,
      booted: false,
      runningCount: 0,
      attentionCount: 0,
      lanes: [],
      chats: [],
    });
    const peer = { ...createSyncRosterPeerState() };
    const fanout = createSyncRosterFanout({
      provider: {
        buildSnapshot: () => {
          buildCount += 1;
          if (buildCount === 1) return Promise.resolve([project("initial")]);
          if (buildCount === 2) return firstFlush;
          return Promise.resolve([project("updated")]);
        },
      },
      subscribers: () => [peer],
      send: (_peer, _type, _payload) => true,
      isDisposed: () => false,
      logger: { warn: vi.fn() },
      buildFailedLogEvent: "roster.build_failed",
    });

    await fanout.subscribe(peer, "subscribe-1");
    fanout.markDirty();
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(2);

    fanout.markDirty();
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(2);

    releaseFirstFlush([project("first flush")]);
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(3);
    expect(peer.rosterSeq).toBe(3);
    fanout.dispose();
  });
});
