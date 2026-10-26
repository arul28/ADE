/**
 * How many GitHub requests one process sends at once.
 *
 * Opening a pull request used to put about fourteen requests on the wire in
 * the same instant (its status, checks, reviews, comments, files, commits, CI
 * runs and each run's jobs), on top of whatever the poller was doing. GitHub
 * answers a burst like that more slowly, and its secondary rate limit is about
 * concurrency, not totals. Six matches what a browser opens to one host.
 *
 * A request holds its slot until GitHub's headers arrive; reading the body
 * happens outside it, so a slow download never holds up the next request.
 * Waiting requests go in the order they asked. Nothing that holds a slot
 * waits on another slot, so the gate cannot deadlock.
 */
export const GITHUB_MAX_REQUESTS_IN_FLIGHT = 6;

let inFlight = 0;
const waiting: Array<() => void> = [];

/**
 * Resolves with a release function once a slot is free. Release is
 * idempotent. A caller whose `signal` aborts while it waits leaves the line
 * and rejects with the signal's reason, as `fetch` would.
 */
export function acquireGithubRequestSlot(signal?: AbortSignal | null): Promise<() => void> {
  const grant = (): (() => void) => {
    inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      const next = waiting.shift();
      if (next) next();
    };
  };
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (inFlight < GITHUB_MAX_REQUESTS_IN_FLIGHT) return Promise.resolve(grant());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      const index = waiting.indexOf(admit);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal?.reason);
    };
    const admit = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(grant());
    };
    waiting.push(admit);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
