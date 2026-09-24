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
 * client without the endpoint, is treated as unknown and the wait continues.
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
  onSynthesized?: (sessionIDs: readonly string[]) => void;
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
  let pending: Promise<IteratorResult<TEvent>> | null = null;
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
        yield outcome.value;
        continue;
      }
      const waiting = deps.waitingOn().filter((id) => !synthesized.has(id));
      if (waiting.length === 0) continue;
      let statuses: Record<string, OpenCodeIdleProbeStatus> | null = null;
      try {
        statuses = await deps.probe();
      } catch {
        statuses = null;
      }
      if (!statuses) continue;
      const idle = waiting.filter((id) => (statuses?.[id] ?? "idle") === "idle");
      if (idle.length === 0) continue;
      for (const id of idle) synthesized.add(id);
      deps.onSynthesized?.(idle);
      for (const id of idle) yield deps.makeIdleEvent(id);
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
