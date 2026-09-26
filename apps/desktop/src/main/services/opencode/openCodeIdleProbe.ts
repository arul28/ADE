/**
 * A quiet-stream probe for OpenCode turns.
 *
 * OpenCode ends a turn with one `session.idle` on its SSE stream, and the
 * stream replays nothing: OpenCode publishes no event ids, so an idle that
 * lands while the socket is between connections is simply gone. The consuming
 * loop then waits forever, and the chat shows "Working" long after the model
 * printed its last line. On 2026-09-21 two dev-loop turns in one chat did
 * exactly that: OpenCode's own log has `exiting loop` for both, and the ADE
 * transcript has no `done` for either.
 *
 * The fix does not trust the stream alone. While no event arrives for
 * `quietMs`, the probe asks the server directly (`GET /session/status`), and
 * when the sessions the loop still waits for are not `busy`, it yields a
 * synthetic `session.idle` for each so the loop finishes the way it would
 * have. A session that is genuinely busy (a long tool call, a ten-minute CI
 * poll) reports `busy` and nothing is synthesized. A probe that fails, or a
 * client without the endpoint, is bounded: after `probeFailureLimit` consecutive
 * unusable answers the wrapper yields a probe-failure event so the turn ends
 * visibly instead of waiting forever on a server that is gone.
 */

export type OpenCodeIdleProbeStatus = "idle" | "busy" | "retry" | "unknown";

export type OpenCodeIdleProbeDeps<TEvent> = {
  /** Session ids the consumer still waits on. Read on every probe. */
  waitingOn: () => readonly string[];
  /** Live status by session id. Missing ids are `idle`: OpenCode drops finished sessions from the map. */
  probe: () => Promise<Record<string, OpenCodeIdleProbeStatus> | null>;
  makeIdleEvent: (sessionID: string) => TEvent;
  /** How long the stream may stay silent before a probe. */
  quietMs: number;
  /**
   * How long one status probe may take before it counts as unusable. A server
   * that accepts the connection but never answers would otherwise park the
   * generator in `await probe()` and the turn would never end — the exact
   * unbounded wait this wrapper exists to remove. Defaults to 10s.
   */
  probeTimeoutMs?: number;
  onSynthesized?: (sessionIDs: readonly string[]) => void;
  /**
   * Consecutive probes that failed outright or answered with nothing usable
   * (`null`, or only `unknown` statuses) before the turn is failed. A `busy` or
   * `retry` answer is a decision and resets the count — a genuine long tool
   * call must never be killed. Defaults to 3.
   */
  probeFailureLimit?: number;
  /**
   * Event yielded once `probeFailureLimit` consecutive probes failed. The turn
   * loop maps it onto a `session.error` so the turn terminates visibly instead
   * of waiting on a server that is gone or answering garbage.
   */
  makeProbeFailureEvent?: (sessionIDs: readonly string[]) => TEvent;
  onProbeFailed?: (sessionIDs: readonly string[]) => void;
  /** Test seam. */
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
};

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
}

/**
 * Wraps an event stream so silence is checked against the server.
 *
 * The pending `next()` is kept across probes: a real event that arrives late
 * is still delivered after any synthetic idle, and the source is never read
 * twice for one wait.
 */
export async function* withOpenCodeIdleProbe<TEvent>(
  source: AsyncIterator<TEvent> | AsyncIterable<TEvent>,
  deps: OpenCodeIdleProbeDeps<TEvent>,
): AsyncGenerator<TEvent> {
  const iterator: AsyncIterator<TEvent> = Symbol.asyncIterator in (source as object)
    ? (source as AsyncIterable<TEvent>)[Symbol.asyncIterator]()
    : (source as AsyncIterator<TEvent>);
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const synthesized = new Set<string>();
  const probeFailureLimit = Math.max(1, deps.probeFailureLimit ?? 3);
  const probeTimeoutMs = Math.max(1, deps.probeTimeoutMs ?? 10_000);
  let consecutiveProbeFailures = 0;
  let pending: Promise<IteratorResult<TEvent>> | null = null;
  /** A probe that never resolves counts as unusable, like one that throws. */
  const probeWithTimeout = async (): Promise<Record<string, OpenCodeIdleProbeStatus> | null> => {
    let clearTimer: () => void = () => {};
    const timedOut = new Promise<null>((resolve) => {
      const handle = setTimer(() => resolve(null), probeTimeoutMs);
      clearTimer = () => handle.clear();
    });
    try {
      return await Promise.race([deps.probe().catch(() => null), timedOut]);
    } finally {
      clearTimer();
    }
  };
  try {
    while (true) {
      pending ??= iterator.next();
      const quiet = new Promise<"quiet">((resolve) => {
        const timer = setTimer(() => resolve("quiet"), deps.quietMs);
        void pending?.finally(() => timer.clear());
      });
      const outcome = await Promise.race([pending, quiet]);
      if (outcome !== "quiet") {
        pending = null;
        if (outcome.done) return;
        // Any real event is liveness: the transport is delivering, so a prior
        // run of unusable probes does not carry over to the next quiet window.
        consecutiveProbeFailures = 0;
        yield outcome.value;
        continue;
      }
      const currentWaiting = deps.waitingOn();
      // Forget ids the consumer no longer waits on, so a session id that leaves
      // the wait set and later returns (a task_id-resumed child) can be
      // synthesized again instead of being permanently marked.
      for (const id of [...synthesized]) {
        if (!currentWaiting.includes(id)) synthesized.delete(id);
      }
      const waiting = currentWaiting.filter((id) => !synthesized.has(id));
      if (waiting.length === 0) continue;
      const statuses = await probeWithTimeout();
      const idle = statuses
        ? waiting.filter((id) => (statuses?.[id] ?? "idle") === "idle")
        : [];
      if (idle.length > 0) {
        consecutiveProbeFailures = 0;
        for (const id of idle) synthesized.add(id);
        deps.onSynthesized?.(idle);
        for (const id of idle) yield deps.makeIdleEvent(id);
        continue;
      }
      if (statuses && waiting.some((id) => statuses[id] === "busy" || statuses[id] === "retry")) {
        // A real decision: the server says these sessions are still working.
        consecutiveProbeFailures = 0;
        continue;
      }
      // The probe told us nothing usable: failed outright, or answered only
      // `unknown` statuses. A not-busy-but-unreadable server must not hold the
      // turn forever, so a bounded run of these fails the turn.
      consecutiveProbeFailures += 1;
      if (consecutiveProbeFailures < probeFailureLimit) continue;
      consecutiveProbeFailures = 0;
      for (const id of waiting) synthesized.add(id);
      deps.onProbeFailed?.(waiting);
      if (deps.makeProbeFailureEvent) {
        // One terminal event per waited-on session: a single event would fail
        // only the first and leave the rest marked synthesized but never told,
        // which hangs the loop exactly as before.
        for (const id of waiting) yield deps.makeProbeFailureEvent([id]);
      } else {
        for (const id of waiting) yield deps.makeIdleEvent(id);
      }
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // The source is being abandoned either way.
    }
  }
}

/** Maps the SDK's `/session/status` answer onto the probe's status set. */
export function readOpenCodeSessionStatuses(
  raw: unknown,
): Record<string, OpenCodeIdleProbeStatus> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, OpenCodeIdleProbeStatus> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const type = value && typeof value === "object" ? (value as { type?: unknown }).type : null;
    out[id] = type === "idle" || type === "busy" || type === "retry" ? type : "unknown";
  }
  return out;
}
