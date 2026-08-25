/**
 * One brain restart at a time, however many callers ask for it.
 *
 * The freshness monitor and the memory guard both restart this brain through
 * the same closure, and each one serializes only its own attempts. Without a
 * shared latch the two can request a restart of the same service concurrently.
 *
 * A caller that arrives while a restart is in flight joins that restart instead
 * of starting a second one, and sees its outcome: a failure reaches every
 * caller, because both callers treat a throw as "the restart did not happen"
 * and re-arm on it.
 */
export type SingleFlightBrainRestart = (failureEvent: string) => Promise<void>;

export function createSingleFlightBrainRestart(
  restart: (failureEvent: string) => void | Promise<void>,
  options: { onCoalesced?: (failureEvent: string) => void } = {},
): SingleFlightBrainRestart {
  let inFlight: Promise<void> | null = null;

  return async (failureEvent: string): Promise<void> => {
    if (inFlight) {
      options.onCoalesced?.(failureEvent);
      return inFlight;
    }
    // The latch clears once the attempt settles, so a caller that re-arms after
    // a failed restart can try again.
    const attempt = (async () => {
      await restart(failureEvent);
    })().finally(() => {
      inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  };
}
