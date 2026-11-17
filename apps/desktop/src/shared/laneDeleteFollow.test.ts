import { describe, expect, it } from "vitest";
import { deleteLaneAndFollow } from "./laneDeleteFollow";
import type { DeleteLaneResult, LaneDeleteProgress } from "./types/lanes";

const LOST = "Remote ADE service connection was interrupted before ADE could confirm the action result. ADE reconnected to the machine; retry the action if it is still needed.";

type Answer<T> = T | Error;

function progress(overallStatus: LaneDeleteProgress["overallStatus"], extra: Partial<LaneDeleteProgress> = {}): LaneDeleteProgress {
  return { laneId: "lane-1", steps: [], startedAt: "2026-11-16T00:00:00.000Z", overallStatus, cancellable: false, ...extra };
}

/** A machine behind a link that answers each call from a script, in order. */
function scriptedMachine(starts: Answer<DeleteLaneResult>[], reads: Answer<LaneDeleteProgress[]>[]) {
  const sent = { starts: 0, reads: 0 };
  const next = <T>(script: Answer<T>[], index: number): Promise<T> => {
    const answer = script[Math.min(index, script.length - 1)]!;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  let clock = 0;
  return {
    sent,
    run: () => deleteLaneAndFollow({
      laneId: "lane-1",
      start: () => next(starts, sent.starts++),
      readProgress: () => next(reads, sent.reads++),
      wait: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }),
  };
}

const accepted: DeleteLaneResult = { leftoverWorktree: null, savedWork: null, accepted: true };

describe("deleteLaneAndFollow", () => {
  it.each([
    {
      name: "a start whose answer was lost is sent again, then followed to the end",
      starts: [new Error(LOST), accepted],
      reads: [[progress("running")], new Error("socket closed"), [progress("completed")]],
      sentStarts: 2,
    },
    {
      name: "an older machine that ignores background answers when done; nothing is read",
      starts: [{ leftoverWorktree: null, savedWork: null }],
      reads: [],
      sentStarts: 1,
    },
    {
      name: "an older machine answers the re-sent start as already running, and is followed",
      starts: [new Error(LOST), new Error("Lane delete is already running: lane-1")],
      reads: [[progress("completed_with_warnings")]],
      sentStarts: 2,
    },
    {
      name: "a record dropped while the link was down: asking again finds the lane gone",
      starts: [accepted, { leftoverWorktree: null, savedWork: null, alreadyDeleted: true }],
      reads: [[]],
      sentStarts: 2,
    },
    {
      name: "a start that finds no lane counts as deleted, on an older machine too",
      starts: [new Error("Lane not found: lane-1")],
      reads: [],
      sentStarts: 1,
    },
  ])("resolves: $name", async ({ starts, reads, sentStarts }) => {
    const machine = scriptedMachine(starts, reads);
    await expect(machine.run()).resolves.toMatchObject({ leftoverWorktree: null });
    expect(machine.sent.starts).toBe(sentStarts);
  });

  it.each([
    {
      name: "the machine's reason for a failed delete",
      starts: [accepted],
      reads: [[progress("failed", { errorMessage: "ADE could not save this lane's unsaved work." })]],
      error: /could not save this lane's unsaved work/,
      sentStarts: 1,
    },
    {
      name: "a refusal from the checks, without sending it again",
      starts: [new Error("1 changed file. Enable force delete after confirming warnings."), accepted],
      reads: [],
      error: /Enable force delete/,
      sentStarts: 1,
    },
    {
      name: "an unknown outcome once the machine stays out of reach",
      starts: [accepted],
      reads: [new Error("socket closed")],
      error: /before ADE could confirm the action result/,
      sentStarts: 1,
    },
    {
      // An answer was lost, then the machine stopped answering at all until
      // the start budget ran out: the delete may have started there.
      name: "an unknown outcome when the start cannot be confirmed",
      starts: [new Error(LOST), new Error("Remote target is not connected")],
      reads: [],
      error: /before ADE could confirm the action result/,
      sentStarts: 41,
    },
  ])("rejects with $name", async ({ starts, reads, error, sentStarts }) => {
    const machine = scriptedMachine(starts, reads);
    await expect(machine.run()).rejects.toThrow(error);
    expect(machine.sent.starts).toBe(sentStarts);
  });
});
