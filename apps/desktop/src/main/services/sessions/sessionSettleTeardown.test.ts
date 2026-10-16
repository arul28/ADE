import { describe, expect, it, vi } from "vitest";
import {
  createSessionSettleTeardown,
  residueCountBucket,
  settleSourceMayInterruptActiveTurn,
} from "./sessionSettleTeardown";
import type { SessionActiveWork, SessionSettleTeardownDeps } from "./sessionSettleTeardown";

/**
 * R5 and the teardown contract itself. The race matrix drives the settle path
 * through a hand-written seam; this drives the REAL seam, which is where the
 * "cannot confirm the stop" decision (design 3d, option 3) actually lives.
 */
describe("session settle teardown", () => {
  const neverAborted = { isAborted: () => false, mayInterruptActiveTurn: true };

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

  it("R5: calls a hung stop a timeout, not a rejection", async () => {
    const { run } = harness({
      // Never answers. The provider did not refuse — it did not reply at all,
      // and filing that as an explicit rejection is exactly the conflation the
      // reason field exists to prevent.
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      readActiveWork: async () => work({ backgroundTaskCount: 1, provider: "codex" }),
      expireProviderCall: async () => {},
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue[0]?.reason).toBe("timeout");
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

    const outcome = await run("session-1", { isAborted: () => true, mayInterruptActiveTurn: true });

    expect(interrupt, "an aborted settle must not stop the work that won the race").not.toHaveBeenCalled();
    expect(outcome.residue).toEqual([]);
  });

  /**
   * A machine-initiated settle must never cancel a turn a person is watching.
   * `interrupt` stops the turn and the background work together, so the only
   * way to honor that is to make no call at all and give the settle up.
   */
  it("abandons a machine settle rather than interrupting an active turn", async () => {
    const { run, interrupt } = harness({
      readActiveWork: async () => work({ active: true, backgroundTaskCount: 2 }),
    });

    const outcome = await run("session-1", { isAborted: () => false, mayInterruptActiveTurn: false });

    expect(interrupt, "a poller must not stop the user's running turn").not.toHaveBeenCalled();
    // Aborted, not settled-with-residue: nothing was stopped, so nothing may be
    // filed. The caller reports the abort and retries later.
    expect(outcome.abortedBy).toBe("turn_start");
    expect(outcome.confirmed).toBe(false);
  });

  it("still stops background work for a machine settle when no turn is running", async () => {
    const states = [work({ backgroundTaskCount: 2 }), work()];
    const { run, interrupt } = harness({
      readActiveWork: vi.fn(async () => states.shift() ?? work()),
    });

    const outcome = await run("session-1", { isAborted: () => false, mayInterruptActiveTurn: false });

    // Nobody is watching background work end, and closing it out is what a
    // settle is for. Only a live turn is protected.
    expect(interrupt).toHaveBeenCalledWith("session-1");
    expect(outcome.abortedBy).toBeUndefined();
    expect(outcome.residue).toEqual([]);
  });

  it("still interrupts an active turn for a user-initiated settle", async () => {
    const states = [work({ active: true }), work()];
    const { run, interrupt } = harness({
      readActiveWork: vi.fn(async () => states.shift() ?? work()),
    });

    const outcome = await run("session-1", neverAborted);

    expect(interrupt, "a person who asked for the settle has already decided").toHaveBeenCalledWith("session-1");
    expect(outcome.abortedBy).toBeUndefined();
    expect(outcome.confirmed).toBe(true);
  });

  it("classifies every settle source, and only the PR poller is held back", () => {
    expect(settleSourceMayInterruptActiveTurn("user")).toBe(true);
    expect(settleSourceMayInterruptActiveTurn("operator")).toBe(true);
    expect(settleSourceMayInterruptActiveTurn("agent_explicit")).toBe(true);
    expect(settleSourceMayInterruptActiveTurn("pr_merge")).toBe(false);
    // An unlabelled settle is the user's, which is what the row already records.
    expect(settleSourceMayInterruptActiveTurn(undefined)).toBe(true);
  });

  it("does not report residue for a session the user reclaimed mid-teardown", async () => {
    let aborted = false;
    const { run } = harness({
      interrupt: vi.fn(async () => { aborted = true; }),
      readActiveWork: async () => work({ active: true, backgroundTaskCount: 1 }),
    });

    const outcome = await run("session-1", { isAborted: () => aborted, mayInterruptActiveTurn: true });

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

    // A provider that never answered did not REFUSE. This said "rejected" and
    // was encoding the misclassification: every hung call would reach both the
    // user-visible residue and the analytics dimension as an explicit provider
    // rejection.
    expect(outcome.residue[0]?.reason).toBe("timeout");
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

  it("abandons a MACHINE settle when the liveness read times out", async () => {
    const readActiveWork = vi.fn(() => new Promise<SessionActiveWork>(() => {}));
    const { run, interrupt } = harness({
      readActiveWork,
      expireProviderCall: async () => {},
    });

    const outcome = await run("session-1", { isAborted: () => false, mayInterruptActiveTurn: false });

    // The refusal above triggers on `before.active`, which only exists for a
    // read that ANSWERED — so a hung host was the one way a poller filed a
    // session over a running turn, consuming the merge that asked for it.
    // Residue still describes what happened; `abortedBy` is what stops the file.
    expect(interrupt).not.toHaveBeenCalled();
    expect(outcome.abortedBy, "unknown liveness must not settle a machine settle").toBe("teardown_failed");
    expect(outcome.confirmed).toBe(false);
    expect(outcome.residue[0]?.reason).toBe("timeout");
  });

  it("does not claim a clean teardown when the CONFIRMATION read times out", async () => {
    let call = 0;
    let armed = false;
    const { run } = harness({
      // The first read succeeds, so teardown proceeds and interrupts. The read
      // that is supposed to CONFIRM the stop then hangs — and a timeout is not
      // confirmation, however much it looks like one.
      readActiveWork: vi.fn(async () => {
        call += 1;
        if (call === 1) return work({ backgroundTaskCount: 1 });
        armed = true;
        return await new Promise<SessionActiveWork>(() => {});
      }),
      expireProviderCall: () => armed ? Promise.resolve() : new Promise<void>(() => {}),
    });

    const outcome = await run("session-1", neverAborted);

    expect(outcome.residue, "an unconfirmed stop must never report as clean").not.toEqual([]);
    expect(outcome.residue[0]?.reason).toBe("timeout");
  });

  it("never claims confirmation for a settle that was aborted mid-confirmation", async () => {
    let aborted = false;
    let reads = 0;
    const { run } = harness({
      // The abort must trip INSIDE the confirmation loop, not before it. Tripped
      // earlier, an already-correct early return handles it and this test would
      // pass against the very bug it is written for.
      readActiveWork: async () => {
        reads += 1;
        if (reads >= 2) aborted = true;
        return work({ backgroundTaskCount: 1 });
      },
    });

    const outcome = await run("session-1", { isAborted: () => aborted, mayInterruptActiveTurn: true });

    expect(reads, "the confirmation loop must actually have run").toBeGreaterThan(1);

    // `confirmed` gates whether a previous residue record may be ERASED, so a
    // teardown that confirmed nothing must never report true — this is the one
    // shape the flag exists to make impossible.
    expect(outcome.confirmed).toBe(false);
  });

  it("keeps the provider on a confirmation-read timeout", async () => {
    let call = 0;
    // Armed only AFTER the first read lands. An always-immediate expire races
    // the first read on the microtask queue and can time it out instead, which
    // would pass this test for the wrong reason.
    let armed = false;
    const { run } = harness({
      readActiveWork: vi.fn(async () => {
        call += 1;
        if (call === 1) return work({ backgroundTaskCount: 1, provider: "codex" });
        armed = true;
        return await new Promise<SessionActiveWork>(() => {});
      }),
      expireProviderCall: () => armed
        ? Promise.resolve()
        : new Promise<void>(() => {}),
    });

    const outcome = await run("session-1", neverAborted);

    // The provider was already read; dropping it loses the analytics dimension
    // for exactly the residue worth attributing.
    expect(outcome.provider).toBe("codex");
  });

  it("buckets residue counts so a large fleet cannot widen the analytics dimension", () => {
    expect(residueCountBucket(1)).toBe("1");
    expect(residueCountBucket(5)).toBe("2_5");
    expect(residueCountBucket(40)).toBe("6_plus");
  });
});
