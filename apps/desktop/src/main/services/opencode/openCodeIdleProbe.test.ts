import { describe, expect, it } from "vitest";
import { readOpenCodeSessionStatuses, withOpenCodeIdleProbe } from "./openCodeIdleProbe";

type Ev = { type: string; sessionID: string };

/** A source whose events are pushed by the test and which otherwise waits. */
function pushSource() {
  const queue: Ev[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const iterator: AsyncIterator<Ev> = {
    async next() {
      while (true) {
        if (queue.length) return { value: queue.shift()!, done: false };
        if (closed) return { value: undefined as unknown as Ev, done: true };
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async return() {
      closed = true;
      waiters.splice(0).forEach((w) => w());
      return { value: undefined as unknown as Ev, done: true };
    },
  };
  return {
    iterator,
    push: (ev: Ev) => { queue.push(ev); waiters.splice(0).forEach((w) => w()); },
    close: () => { closed = true; waiters.splice(0).forEach((w) => w()); },
  };
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending: Array<{ fn: () => void; cleared: boolean }> = [];
  return {
    setTimer: (fn: () => void) => {
      const entry = { fn, cleared: false };
      pending.push(entry);
      return { clear: () => { entry.cleared = true; } };
    },
    fire: () => {
      const live = pending.splice(0).filter((entry) => !entry.cleared);
      live.forEach((entry) => entry.fn());
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("withOpenCodeIdleProbe", () => {
  it("synthesizes the parent's idle when the stream is quiet and the server says idle", async () => {
    // The 2026-09-21 shape: OpenCode logged `exiting loop`, the SSE idle was
    // lost between connections, and the turn waited forever.
    const source = pushSource();
    const timers = manualTimers();
    const synthesized: string[][] = [];
    const stream = withOpenCodeIdleProbe<Ev>(source.iterator, {
      waitingOn: () => ["parent"],
      probe: async () => ({}),
      makeIdleEvent: (sessionID) => ({ type: "session.idle", sessionID }),
      quietMs: 1_000,
      setTimer: timers.setTimer,
      onSynthesized: (ids) => synthesized.push([...ids]),
    });
    const first = stream.next();
    await tick();
    timers.fire();
    expect(await first).toEqual({ value: { type: "session.idle", sessionID: "parent" }, done: false });
    expect(synthesized).toEqual([["parent"]]);
    await stream.return(undefined);
  });

  it("leaves a busy session alone, however long it is quiet", async () => {
    const source = pushSource();
    const timers = manualTimers();
    let probes = 0;
    const stream = withOpenCodeIdleProbe<Ev>(source.iterator, {
      waitingOn: () => ["parent"],
      probe: async () => { probes += 1; return { parent: "busy" }; },
      makeIdleEvent: (sessionID) => ({ type: "session.idle", sessionID }),
      quietMs: 1_000,
      setTimer: timers.setTimer,
    });
    const next = stream.next();
    await tick(); timers.fire(); await tick();
    await tick(); timers.fire(); await tick();
    expect(probes).toBe(2);
    // The real event still arrives through the same pending read.
    source.push({ type: "message.updated", sessionID: "parent" });
    expect(await next).toEqual({ value: { type: "message.updated", sessionID: "parent" }, done: false });
    await stream.return(undefined);
  });

  it("bounds a failing probe: it waits, then ends the turn after the limit", async () => {
    // A server that stops answering must not hold the chat on "Working"
    // forever: failures are counted and the turn is failed visibly.
    const source = pushSource();
    const timers = manualTimers();
    const failed: string[][] = [];
    const stream = withOpenCodeIdleProbe<Ev>(source.iterator, {
      waitingOn: () => ["parent"],
      probe: async () => { throw new Error("no status endpoint"); },
      makeIdleEvent: (sessionID) => ({ type: "session.idle", sessionID }),
      makeProbeFailureEvent: (sessionIDs) => ({ type: "session.error", sessionID: sessionIDs[0]! }),
      probeFailureLimit: 2,
      quietMs: 1_000,
      setTimer: timers.setTimer,
      onProbeFailed: (ids) => failed.push([...ids]),
    });
    // One pending read for the whole sequence: a second `next()` issues a
    // queued request that would not settle on this yield.
    const next = stream.next();
    await tick(); timers.fire(); await tick();
    // One failure is not a decision; the probe is retried.
    expect(failed).toEqual([]);
    await tick(); timers.fire(); await tick();
    expect(await next).toEqual({
      value: { type: "session.error", sessionID: "parent" },
      done: false,
    });
    expect(failed).toEqual([["parent"]]);
    await stream.return(undefined);
  });

  it("counts a status call that never answers as unusable", async () => {
    // A TCP-alive but wedged server used to park the generator in
    // `await probe()` forever; the probe timeout turns it into a failure.
    const source = pushSource();
    const timers = manualTimers();
    const stream = withOpenCodeIdleProbe<Ev>(source.iterator, {
      waitingOn: () => ["parent"],
      probe: () => new Promise(() => {}),
      makeIdleEvent: (sessionID) => ({ type: "session.idle", sessionID }),
      makeProbeFailureEvent: (sessionIDs) => ({ type: "session.error", sessionID: sessionIDs[0]! }),
      probeFailureLimit: 1,
      probeTimeoutMs: 500,
      quietMs: 1_000,
      setTimer: timers.setTimer,
    });
    const next = stream.next();
    await tick(); timers.fire(); await tick();
    timers.fire(); await tick();
    expect(await next).toEqual({
      value: { type: "session.error", sessionID: "parent" },
      done: false,
    });
    await stream.return(undefined);
  });

  it("synthesizes each waited-on session once and passes real events through unchanged", async () => {
    const source = pushSource();
    const timers = manualTimers();
    const waiting = ["parent", "child"];
    const stream = withOpenCodeIdleProbe<Ev>(source.iterator, {
      waitingOn: () => waiting,
      probe: async () => ({ parent: "idle" }),
      makeIdleEvent: (sessionID) => ({ type: "session.idle", sessionID }),
      quietMs: 1_000,
      setTimer: timers.setTimer,
    });
    source.push({ type: "message.updated", sessionID: "parent" });
    expect((await stream.next()).value).toEqual({ type: "message.updated", sessionID: "parent" });
    const a = stream.next();
    await tick(); timers.fire();
    expect((await a).value).toEqual({ type: "session.idle", sessionID: "parent" });
    expect((await stream.next()).value).toEqual({ type: "session.idle", sessionID: "child" });
    // A second quiet period does not repeat them.
    const c = stream.next();
    await tick(); timers.fire(); await tick();
    source.push({ type: "session.diff", sessionID: "parent" });
    expect((await c).value).toEqual({ type: "session.diff", sessionID: "parent" });
    await stream.return(undefined);
  });
});

describe("readOpenCodeSessionStatuses", () => {
  it("maps the status map and marks unknown shapes", () => {
    expect(readOpenCodeSessionStatuses({
      a: { type: "idle" },
      b: { type: "busy" },
      c: { type: "retry", attempt: 2 },
      d: { type: "later" },
    })).toEqual({ a: "idle", b: "busy", c: "retry", d: "unknown" });
    expect(readOpenCodeSessionStatuses(null)).toBeNull();
  });
});
