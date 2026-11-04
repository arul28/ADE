/**
 * Who is still watching a device stream, counted in the renderer.
 *
 * A stream's stop is lane-scoped, so the last viewer out stops it, and a
 * viewer that remounts joins the running stream instead of cutting it. Each
 * tool makes its own table: the Apple table counts every lease of a lane
 * together and its floating player looks up "the lane's stream" there, so an
 * Android lease in it would hold an Apple stop open and hand the Apple player
 * an emulator.
 *
 * A module-level map rather than React state, because the holders live in
 * different subtrees (a pane, a floating player) with no common ancestor short
 * of the page.
 */

export type StreamLeaseEntry<Meta> = {
  count: number;
  /**
   * Which run of the stream the holders belong to.
   *
   * Bumped every time the count rises from zero, so "the stream that was
   * running when I took my lease" is a value a releaser can carry. A release
   * stamped with an older epoch is a message from a stream that has already
   * ended, and it must not stop the one running now.
   */
  epoch: number;
  /** What the tool keeps about the stream, set by the first holder. */
  meta: Meta;
};

export type StreamLeaseTable<Meta> = {
  /**
   * Take a lease. `first` is true for the viewer that starts the stream.
   * `create` makes the entry's metadata when the count rises from zero; the
   * returned `meta` is the entry's, so a joining viewer can update it.
   */
  acquire(id: string, create: () => Meta): { first: boolean; epoch: number; meta: Meta };
  /**
   * Give a lease back. `last` is true only for the viewer that has to stop
   * the stream. Releasing an id nobody holds, or with an older run's epoch,
   * reports `last: false`, so a slow unmount cannot stop a stream a newer
   * viewer has started.
   */
  release(id: string, epoch?: number): { last: boolean };
  /** How many viewers hold this stream. */
  count(id: string): number;
  /** Which run this id is on, or 0 when nobody holds it. */
  epoch(id: string): number;
  /** Every held entry, for lookups across ids. */
  entries(): IterableIterator<[string, StreamLeaseEntry<Meta>]>;
  /** Forget one id's leases without stopping anything. */
  forget(id: string): void;
  /** Drops every lease. */
  clear(): void;
};

export function createStreamLeaseTable<Meta>(): StreamLeaseTable<Meta> {
  const leases = new Map<string, StreamLeaseEntry<Meta>>();
  let epochCounter = 0;
  return {
    acquire(id, create) {
      const entry = leases.get(id);
      if (!entry || entry.count <= 0) {
        epochCounter += 1;
        const fresh: StreamLeaseEntry<Meta> = { count: 1, epoch: epochCounter, meta: create() };
        leases.set(id, fresh);
        return { first: true, epoch: fresh.epoch, meta: fresh.meta };
      }
      entry.count += 1;
      return { first: false, epoch: entry.epoch, meta: entry.meta };
    },
    release(id, epoch) {
      const entry = leases.get(id);
      if (!entry || entry.count <= 0) {
        leases.delete(id);
        return { last: false };
      }
      if (epoch !== undefined && epoch !== entry.epoch) return { last: false };
      entry.count -= 1;
      if (entry.count === 0) {
        leases.delete(id);
        return { last: true };
      }
      return { last: false };
    },
    count: (id) => leases.get(id)?.count ?? 0,
    epoch: (id) => leases.get(id)?.epoch ?? 0,
    entries: () => leases.entries(),
    forget(id) {
      leases.delete(id);
    },
    clear() {
      leases.clear();
    },
  };
}
