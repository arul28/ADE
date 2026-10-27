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
    // The snapshot's seq starts a per-socket epoch; each delta adds one.
    const snapshotSeq = peer.rosterSeq;
    fanout.markDirty();
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(2);

    fanout.markDirty();
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(2);

    releaseFirstFlush([project("first flush")]);
    await vi.advanceTimersByTimeAsync(250);
    expect(buildCount).toBe(3);
    expect(peer.rosterSeq).toBe(snapshotSeq + 2);
    fanout.dispose();
  });

  it.each([
    { name: "closed", leave: () => {} },
    { name: "unsubscribed first", leave: (fanout: { unsubscribe(peer: never): void }, peer: unknown) => fanout.unsubscribe(peer as never) },
  ])("resumes a reconnecting device by seq after its old socket $name", async ({ leave }) => {
    const project = (runningCount: number): SyncRosterProject => ({
      projectId: "project-1",
      displayName: "Project",
      booted: false,
      runningCount,
      attentionCount: 0,
      lanes: [],
      chats: [],
    });
    let projects = [project(0)];
    const sent: Array<{ peer: unknown; type: string; payload: { seq?: number } }> = [];
    const oldSocket = { ...createSyncRosterPeerState() };
    const newSocket = { ...createSyncRosterPeerState() };
    let live = [oldSocket];
    const fanout = createSyncRosterFanout({
      provider: { buildSnapshot: async () => projects },
      subscribers: () => live.filter((peer) => peer.rosterSubscribed),
      send: (peer, type, payload) => {
        sent.push({ peer, type, payload: payload as { seq?: number } });
        return true;
      },
      isDisposed: () => false,
      logger: { warn: vi.fn() },
      buildFailedLogEvent: "roster.build_failed",
      // Both sockets belong to the same paired device.
      resumeIdentity: () => "device-1",
    });

    await fanout.subscribe(oldSocket, "subscribe-old");
    const lastSeq = oldSocket.rosterSeq;
    leave(fanout, oldSocket);
    live = [newSocket];
    projects = [project(2)];

    await fanout.subscribe(newSocket, "subscribe-new", lastSeq);
    const reply = sent.filter((entry) => entry.peer === newSocket);
    // Only what changed since lastSeq, continuing its seq.
    expect(reply.map((entry) => entry.type)).toEqual(["roster_delta"]);
    expect(reply[0]!.payload.seq).toBe(lastSeq + 1);
    fanout.dispose();
  });
});
