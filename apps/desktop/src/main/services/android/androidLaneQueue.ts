/**
 * One step at a time for each lane: a step starts after every earlier step
 * of the same lane has settled, whatever its outcome. The fold and the
 * Compose previews each keep one, apart from the service's lifecycle queue.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */
export function createAndroidLaneQueue(): <T>(laneId: string, step: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(laneId: string, step: () => Promise<T>): Promise<T> => {
    const run = (tails.get(laneId) ?? Promise.resolve()).then(step, step);
    const tail = run.catch(() => undefined);
    tails.set(laneId, tail);
    // The map keeps only the lanes with a step in flight.
    void tail.then(() => {
      if (tails.get(laneId) === tail) tails.delete(laneId);
    });
    return run;
  };
}
