import { armDeadline } from "../../../shared/deadlineTimer";
import { captureError } from "../../../shared/sentry/capture";
import { createPhaseClock, type PhaseClock } from "../../../shared/phaseClock";
import { markExpected } from "../../../shared/expectedError";

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
 * "try again shortly".
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

/** An event read or subscription that waited past its ceiling, naming the step it was on. */
export class RemoteEventSetupTimeoutError extends Error {
  readonly code = "REMOTE_EVENT_SETUP_TIMEOUT" as const;

  constructor(
    readonly machineName: string,
    readonly phase: RemoteEventSetupPhase,
    readonly timeoutMs: number,
  ) {
    super(
      `Could not reach ${machineName}: ${PHASE_WORDS[phase]} within ${Math.round(timeoutMs / 1000)}s. ADE will try again.`,
    );
    this.name = "RemoteEventSetupTimeoutError";
    // A paired machine that is asleep, busy or offline; the message names the
    // step and ADE retries on its own. The step stays in the Sentry Log.
    markExpected(this, "network");
  }
}

/**
 * Run one event setup under REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS. `run`
 * reports each step it enters, and can ask whether the caller already gave up
 * (`isAbandoned`), to drop what a late result would deliver. Past the ceiling
 * the returned promise rejects with the step it was in; a result that arrives
 * later goes to `onLateResult` (a subscription it must close), and a late
 * failure is dropped. The one timer is cleared when `run` settles in time.
 */
export function runWithEventSetupDeadline<T>(args: {
  machineName: string;
  run: (notePhase: (phase: RemoteEventSetupPhase) => void, isAbandoned: () => boolean) => Promise<T>;
  onLateResult?: (value: T) => void;
  onSettled?: (outcome: { timedOut: boolean; clock: PhaseClock<RemoteEventSetupPhase> }) => void;
}): Promise<T> {
  const timeoutMs = REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS;
  const clock = createPhaseClock<RemoteEventSetupPhase>("authorize");
  // Reporting is best-effort: a reporter that throws must not leave the
  // request unsettled or escape the deadline's timer.
  const report = (timedOut: boolean): void => {
    try {
      args.onSettled?.({ timedOut, clock });
    } catch (error) {
      captureError(error, { fingerprint: ["remote-event-setup", "report-failed"] });
    }
  };
  let settled = false;
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const deadline = armDeadline(timeoutMs, () => {
      if (settled) return;
      settled = true;
      timedOut = true;
      const error = new RemoteEventSetupTimeoutError(args.machineName, clock.current(), timeoutMs);
      reject(error);
      report(true);
    });
    let running: Promise<T>;
    try {
      running = args.run((phase) => clock.enter(phase), () => timedOut);
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
        resolve(value);
        report(false);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        reject(error);
        report(false);
      },
    );
  });
}
