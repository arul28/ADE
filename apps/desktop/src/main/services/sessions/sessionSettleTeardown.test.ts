import { describe, expect, it, vi } from "vitest";
import { createSessionSettleTeardown, residueCountBucket } from "./sessionSettleTeardown";
import type { SessionActiveWork, SessionSettleTeardownDeps } from "./sessionSettleTeardown";

/**
 * R5 and the teardown contract itself. The race matrix drives the settle path
 * through a hand-written seam; this drives the REAL seam, which is where the
 * "cannot confirm the stop" decision (design 3d, option 3) actually lives.
 */
describe("session settle teardown", () => {
  const neverAborted = { isAborted: () => false };

  function harness(overrides: Partial<SessionSettleTeardownDeps> = {}) {
    const interrupt = vi.fn(async () => {});
    // Instant polling: the confirmation budget is real time in production, and
    // a test that actually slept 5s per case would be deleted within a month.
    let clock = 0;
    const run = createSessionSettleTeardown({
      interrupt,
      readActiveWork: async () => null,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      // Never fires unless a test asks for it, so an ordinary provider call is
      // never mistaken for a hung one.
      expireProviderCall: () => new Promise<void>(() => {}),
      ...overrides,
    });
    return { run, interrupt };
  }

  const work = (over: Partial<SessionActiveWork> = {}): SessionActiveWork => ({
    active: false,
    backgroundTaskCount: 0,
    provider: "claude",
    ...over,
  });

  it("does not stop anything for a session with no work", async () => {
    const { run, interrupt } = harness({ readActiveWork: async () => work() });

    const outcome = await run("session-1", neverAborted);

    // A settle with nothing to tear down must not interrupt the session: that
    // would be a visible side effect on a row the user only meant to file.
    expect(interrupt).not.toHaveBeenCalled();
    expect(outcome.residue).toEqual([]);
  });

  it("stops background work and reports no residue once the session goes quiet", async () => {
    const states = [work({ backgroundTaskCount: 2 }), work({ backgroundTaskCount: 2 }), work()];
    const readActiveWork = vi.fn(async () => states.shift() ?? work());
    const { run, interrupt } = harness({ readActiveWork });

    const outcome = await run("session-1", neverAborted);

    expect(interrupt).toHaveBeenCalledWith("session-1");
    // The stop is asynchronous inside the provider, so a single read straight
    // after `interrupt` would call work that was already stopping "residue".
    expect(outcome.residue, "work that drained must not be reported as residue").toEqual([]);
  });

  /**
   * R5. The stop is attempted, the work does not go away, and the settle still
   * lands — but never silently: the residue is returned for the row and the
   * analytics hook fires exactly once.
   */
  it("R5: reports residue when the stop never confirms, rather than blocking the settle", async () => {
    const { run } = harness({
      readActiveWork: async () => work({ backgroundTaskCount: 3 }),
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue).toEqual([{
      kind: "background_tasks",
      reason: "timeout",
      count: 3,
      detail: "3 jobs on claude could not be stopped",
    }]);
    // The provider rides along for the analytics dimension. Reporting happens in
    // the settle path, not here, so an abandoned settle cannot claim residue.
    expect(outcome.provider).toBe("claude");
  });

  it("R5: reports a surviving turn separately from surviving background jobs", async () => {
    const { run } = harness({
      readActiveWork: async () => work({ active: true, backgroundTaskCount: 2 }),
    });

    const outcome = await run("session-1", neverAborted);

    // Two facts, two items. Folded together, the count would read "3 jobs" and
    // the running turn would disappear into the background-task bucket.
    expect(outcome.residue).toEqual([
      { kind: "background_tasks", reason: "timeout", count: 2, detail: "2 jobs on claude could not be stopped" },
      { kind: "active_turn", reason: "timeout", count: 1, detail: "the running turn on claude could not be stopped" },
    ]);
  });

  it("R5: calls out a provider that has no stop control at all", async () => {
    const { run } = harness({
      // A Codex chat cannot stop an individual subagent. That is a different
      // fact from "the stop failed", and the field exists to keep them apart.
      readActiveWork: async () => work({ backgroundTaskCount: 1, provider: "codex" }),
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue[0]?.reason).toBe("no_stop_control");
  });

  it("R5: distinguishes a stop the provider rejected from one that timed out", async () => {
    const { run } = harness({
      interrupt: vi.fn(async () => { throw new Error("provider refused"); }),
      readActiveWork: async () => work({ backgroundTaskCount: 1 }),
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue[0]?.reason).toBe("rejected");
  });

  /**
   * §3c: an accepted turn beats the settle, never the reverse. The abort is
   * checked BEFORE each step, so the work that won the race keeps running.
   */
  it("stops issuing stop calls the moment a turn aborts the settle", async () => {
    const { run, interrupt } = harness({
      readActiveWork: async () => work({ active: true }),
    });

    const outcome = await run("session-1", { isAborted: () => true });

    expect(interrupt, "an aborted settle must not stop the work that won the race").not.toHaveBeenCalled();
    expect(outcome.residue).toEqual([]);
  });

  it("does not report residue for a session the user reclaimed mid-teardown", async () => {
    let aborted = false;
    const { run } = harness({
      interrupt: vi.fn(async () => { aborted = true; }),
      readActiveWork: async () => work({ active: true, backgroundTaskCount: 1 }),
    });

    const outcome = await run("session-1", { isAborted: () => aborted });

    // The settle is being abandoned, so there is no settled row to hang a
    // "1 job could not be stopped" marker on. Reporting it would label a
    // session that is actively working as one that failed to stop.
    expect(outcome.residue).toEqual([]);
  });

  it("does not hang the settling window on a provider call that never resolves", async () => {
    const { run } = harness({
      // A control call that never settles. Without a per-call ceiling the
      // settling window never closes and the row is unsettleable for the life
      // of the process.
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      readActiveWork: async () => work({ backgroundTaskCount: 1 }),
      expireProviderCall: async () => {},
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue[0]?.reason).toBe("rejected");
  });

  it("resolves instead of blocking the settle when a liveness read hangs", async () => {
    const readActiveWork = vi.fn(() => new Promise<SessionActiveWork>(() => {}));
    const { run, interrupt } = harness({
      readActiveWork,
      expireProviderCall: async () => {},
    });

    // The first read never resolves. Without a per-call ceiling this awaits
    // forever inside the settling window, and the row can never be settled
    // again for the life of the process.
    const outcome = await run("session-1", neverAborted);

    expect(readActiveWork).toHaveBeenCalledTimes(1);
    // Unknown liveness is not licence to start stopping things...
    expect(interrupt).not.toHaveBeenCalled();
    // ...but it is also not licence to claim a clean teardown. A timed-out read
    // is indistinguishable from "not a chat session" unless it says so, and
    // silently settling over running work is the one outcome residue exists to
    // prevent.
    expect(outcome.residue).toEqual([{
      kind: "background_tasks",
      reason: "timeout",
      count: 1,
      detail: "could not read what this session was running, so nothing was stopped",
    }]);
  });

  it("buckets residue counts so a large fleet cannot widen the analytics dimension", () => {
    expect(residueCountBucket(1)).toBe("1");
    expect(residueCountBucket(5)).toBe("2_5");
    expect(residueCountBucket(40)).toBe("6_plus");
  });
});
