/**
 * The one queue for every `tailscale serve` change ADE makes on this machine.
 * Serve is machine-global and two commands for one port (a publish to the
 * side door, then back to the sync port) must land in the order they were
 * issued, or the older one can win and forward to a port nothing serves.
 * Reads (`serve status`) do not need it.
 */
let serveQueue: Promise<unknown> = Promise.resolve();

export function enqueueTailscaleServe<T>(work: () => Promise<T>): Promise<T> {
  const run = serveQueue.then(work, work);
  serveQueue = run.catch(() => undefined);
  return run;
}
