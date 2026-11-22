import { describe, expect, it } from "vitest";
import { backgroundJobFingerprint, createBackgroundActionJobs } from "./backgroundActionJobs";

function gate<T>() {
  let open: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe("background action jobs", () => {
  const createLane = backgroundJobFingerprint("lane", "create", { name: "work" });

  it("runs a followed action once, however often its call is sent again, and keeps its outcome", async () => {
    const jobs = createBackgroundActionJobs();
    const work = gate<{ laneId: string }>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return work.promise;
    };

    // The first call and two sent again after drops, while the work runs.
    await expect(jobs.run({ key: "p\u0000job-1", fingerprint: createLane, waitMs: 0, start })).resolves.toEqual({ state: "running" });
    await expect(jobs.run({ key: "p\u0000job-1", fingerprint: createLane, waitMs: 0, start })).resolves.toEqual({ state: "running" });
    const waiting = jobs.run({ key: "p\u0000job-1", fingerprint: createLane, waitMs: 10_000, start });
    work.open({ laneId: "lane-7" });
    await expect(waiting).resolves.toEqual({ state: "done", value: { laneId: "lane-7" } });

    // The answer of the last call was lost; the next one gets the same outcome.
    await expect(jobs.run({ key: "p\u0000job-1", fingerprint: createLane, waitMs: 0, start })).resolves.toEqual({
      state: "done",
      value: { laneId: "lane-7" },
    });
    expect(starts).toBe(1);
  });

  it("gives every call of a failed job the same failure, and never starts it again", async () => {
    const jobs = createBackgroundActionJobs();
    const work = gate<never>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return work.promise;
    };
    const first = jobs.run({ key: "p\u0000job-2", fingerprint: createLane, waitMs: 10_000, start });
    work.fail(new Error("Branch 'work' already exists."));
    await expect(first).rejects.toThrow("already exists");
    await expect(jobs.run({ key: "p\u0000job-2", fingerprint: createLane, waitMs: 0, start })).rejects.toThrow("already exists");
    expect(starts).toBe(1);
  });

  it("refuses a job id sent again for another action", async () => {
    const jobs = createBackgroundActionJobs();
    const start = () => new Promise<never>(() => {});
    await jobs.run({ key: "p\u0000job-3", fingerprint: createLane, waitMs: 0, start });
    await expect(jobs.run({
      key: "p\u0000job-3",
      fingerprint: backgroundJobFingerprint("lane", "delete", { laneId: "lane-1" }),
      waitMs: 0,
      start,
    })).rejects.toThrow(/another action/);
  });
});
