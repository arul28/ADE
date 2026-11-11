import { armDeadline } from "../../../shared/deadlineTimer";

/**
 * The steps an event read or subscription on another machine waits on, in the
 * order they usually run. A deadline that fires names the one it was in.
 */
export type RemoteEventSetupPhase =
  /** Checking that the signed-in ADE account may use this machine. */
  | "authorize"
  /** Opening the connection: socket, hello, `ade/initialize`, the first project list. */
  | "connect"
  /** Learning the machine's project ids, to route a pinned folder. */
  | "list_projects"
  /** The `stream_events` read itself. */
  | "read"
  /** Waiting for `runtimeEvents.subscribe` to be acknowledged. */
  | "subscribe"
  /** A reply timed out; asking the open connection whether it still answers. */
  | "liveness_probe"
  /** The connection was dropped; opening it again before one retry. */
  | "reconnect";

/**
 * How long one event read or subscription waits for everything before it,
 * including a dial it starts or joins. Each step under it has its own, shorter
 * bound (a paired dial is at most about a minute a route); this is the ceiling
 * for a dial that tries several routes, or a slow SSH install it joined. The
 * dial itself is not cancelled: it keeps going for the next poll to join.
 *
 * Event pumps poll again two seconds after a failure, so failing here means
 * "try again shortly", where waiting meant ten minutes of silence.
 */
export const REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS = 2 * 60_000;

/**
 * The renderer's IPC budget for `ade.remoteRuntime.streamEvents`: the setup
 * ceiling plus headroom, so the main process always answers with the step
 * that hung before the generic IPC deadline can fire. Shaped like the local
 * twin, LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS.
 */
export const REMOTE_RUNTIME_EVENT_SETUP_IPC_TIMEOUT_MS = REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS + 30_000;

/** Setups slower than this leave a breadcrumb with their step timings. */
export const REMOTE_RUNTIME_EVENT_SETUP_SLOW_MS = 10_000;

const PHASE_WORDS: Record<RemoteEventSetupPhase, string> = {
  authorize: "ADE could not confirm the ADE account it belongs to",
  connect: "it did not answer the connection handshake",
  list_projects: "it did not send its project list",
  read: "it did not send its events",
  subscribe: "it did not confirm the event subscription",
  liveness_probe: "it stopped answering on the open connection",
  reconnect: "it did not answer the connection handshake after the connection dropped",
};

export type RemoteEventSetupPhaseTiming = { phase: RemoteEventSetupPhase; ms: number };

/** An event read or subscription that waited past its ceiling, naming the step it was on. */
export class RemoteEventSetupTimeoutError extends Error {
  readonly code = "REMOTE_EVENT_SETUP_TIMEOUT" as const;

  constructor(
    readonly machineName: string,
    readonly phase: RemoteEventSetupPhase,
    readonly timeoutMs: number,
    readonly phases: readonly RemoteEventSetupPhaseTiming[],
  ) {
    super(
      `Could not reach ${machineName}: ${PHASE_WORDS[phase]} within ${Math.round(timeoutMs / 1000)}s. ADE will try again.`,
    );
    this.name = "RemoteEventSetupTimeoutError";
  }
}

/** "connect:118000 read:2000", for logs. */
export function summarizeEventSetupPhases(phases: readonly RemoteEventSetupPhaseTiming[]): string {
  return phases.map(({ phase, ms }) => `${phase}:${ms}`).join(" ");
}

/**
 * Run one event setup under a ceiling. `run` reports each step it enters;
 * past `timeoutMs` the returned promise rejects with the step it was in. A
 * result that arrives later goes to `onLateResult` (a subscription it must
 * close), and a late failure is dropped: the caller already has its answer.
 * The one timer is cleared when `run` settles in time.
 */
export function runWithEventSetupDeadline<T>(args: {
  machineName: string;
  timeoutMs?: number;
  run: (notePhase: (phase: RemoteEventSetupPhase) => void) => Promise<T>;
  onLateResult?: (value: T) => void;
  onSettled?: (outcome: {
    timedOut: boolean;
    totalMs: number;
    phases: readonly RemoteEventSetupPhaseTiming[];
    error?: RemoteEventSetupTimeoutError;
  }) => void;
}): Promise<T> {
  const timeoutMs = args.timeoutMs ?? REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS;
  const startedAt = Date.now();
  const phases: RemoteEventSetupPhaseTiming[] = [];
  let current: RemoteEventSetupPhase = "authorize";
  let currentStartedAt = startedAt;
  const closeCurrent = (now: number) => {
    phases.push({ phase: current, ms: Math.max(0, now - currentStartedAt) });
  };
  const notePhase = (phase: RemoteEventSetupPhase) => {
    if (phase === current) return;
    const now = Date.now();
    closeCurrent(now);
    current = phase;
    currentStartedAt = now;
  };
  const snapshot = (): RemoteEventSetupPhaseTiming[] => [
    ...phases,
    { phase: current, ms: Math.max(0, Date.now() - currentStartedAt) },
  ];

  let settled = false;
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const deadline = armDeadline(timeoutMs, () => {
      if (settled) return;
      settled = true;
      timedOut = true;
      const timings = snapshot();
      const error = new RemoteEventSetupTimeoutError(args.machineName, current, timeoutMs, timings);
      args.onSettled?.({ timedOut: true, totalMs: Date.now() - startedAt, phases: timings, error });
      reject(error);
    });
    let running: Promise<T>;
    try {
      running = args.run(notePhase);
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (value) => {
        if (timedOut) {
          try {
            args.onLateResult?.(value);
          } catch {
            // Closing a late result is best-effort; the caller already has its answer.
          }
          return;
        }
        if (settled) return;
        settled = true;
        deadline.cancel();
        args.onSettled?.({ timedOut: false, totalMs: Date.now() - startedAt, phases: snapshot() });
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        args.onSettled?.({ timedOut: false, totalMs: Date.now() - startedAt, phases: snapshot() });
        reject(error);
      },
    );
  });
}
