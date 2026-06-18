import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_LAUNCH_TIMEOUT_MS,
  MAX_DRAFT_LAUNCH_TERMINAL_JOBS,
  isDraftLaunchJobTerminal,
  pruneDraftLaunchJobs,
  withDraftLaunchTimeout,
  type DraftLaunchJob,
  type DraftLaunchJobStatus,
} from "./draftLaunchJobs";

// pruneDraftLaunchJobs / the timeout helper only read a few fields, so a minimal
// partial job is sufficient and avoids constructing a full DraftLaunchSnapshot.
function makeJob(id: string, status: DraftLaunchJobStatus): DraftLaunchJob {
  return { id, status, createdAtMs: 0 } as unknown as DraftLaunchJob;
}

describe("withDraftLaunchTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a resolved value straight through and clears its timer", async () => {
    const promise = withDraftLaunchTimeout(Promise.resolve("ready"), "Lane setup");
    await expect(promise).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the original rejection rather than a timeout error", async () => {
    const original = new Error("create failed");
    const promise = withDraftLaunchTimeout(Promise.reject(original), "Session start");
    await expect(promise).rejects.toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a labeled timeout error and fires onTimeout when the call never settles", async () => {
    const onTimeout = vi.fn();
    const promise = withDraftLaunchTimeout(new Promise<never>(() => {}), "Session start", onTimeout);
    // Attach the rejection handler before advancing so the rejection is not unhandled.
    const expectation = expect(promise).rejects.toThrow(/Session start timed out/);
    await vi.advanceTimersByTimeAsync(DRAFT_LAUNCH_TIMEOUT_MS);
    await expectation;
    // onTimeout lets the caller raise its abort flag so the detached promise
    // cannot perform a late irreversible step.
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fire onTimeout when the call settles before the timeout", async () => {
    const onTimeout = vi.fn();
    await expect(
      withDraftLaunchTimeout(Promise.resolve("ok"), "Lane setup", onTimeout),
    ).resolves.toBe("ok");
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("pruneDraftLaunchJobs", () => {
  it("never drops active (non-terminal) jobs, however many there are", () => {
    // The durability of an in-flight launch depends on active jobs surviving
    // every prune pass; only completed/failed notices are capped.
    const active = Array.from({ length: MAX_DRAFT_LAUNCH_TERMINAL_JOBS + 5 }, (_, i) =>
      makeJob(`active-${i}`, "naming-lane"),
    );
    const pruned = pruneDraftLaunchJobs(active);
    expect(pruned).toHaveLength(active.length);
    expect(pruned.every((job) => !isDraftLaunchJobTerminal(job.status))).toBe(true);
  });

  it("caps retained terminal notices while keeping every active job", () => {
    const jobs = [
      makeJob("active-0", "sending-prompt"),
      makeJob("active-1", "creating-lane"),
      ...Array.from({ length: MAX_DRAFT_LAUNCH_TERMINAL_JOBS + 10 }, (_, i) =>
        makeJob(`done-${i}`, "ready"),
      ),
    ];
    const pruned = pruneDraftLaunchJobs(jobs);
    const active = pruned.filter((job) => !isDraftLaunchJobTerminal(job.status));
    const terminal = pruned.filter((job) => isDraftLaunchJobTerminal(job.status));
    expect(active).toHaveLength(2);
    expect(terminal.length).toBeLessThanOrEqual(MAX_DRAFT_LAUNCH_TERMINAL_JOBS);
  });
});
