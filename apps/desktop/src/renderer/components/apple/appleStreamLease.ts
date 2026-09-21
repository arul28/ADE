/**
 * Who is still watching a device's stream, counted in the renderer.
 *
 * `stopStream` is LANE-scoped: it stops the helper's capture for the lane, full
 * stop. That was fine while the device had exactly one viewer, and it stopped
 * being fine the moment the Apple column became a pane and the floating corner
 * card learned to play the same H.264. Two viewers, one lane — and dismissing
 * the card, or scrolling it out of view, called `stopStream` and black-framed
 * the column beside it.
 *
 * So the last viewer out turns off the light. A module-level map rather than
 * React state because the holders are in different subtrees (the column is in
 * the Apple pane, the card floats over the chat column) with no common ancestor
 * short of the page, and a context that high would re-render both of them on
 * every acquire.
 *
 * The counterpart on the brain side already exists: `appleStreamRelay.ts` stops
 * only the lanes IT started, so a web or phone viewer disconnecting cannot stop
 * a capture the desktop brought up either.
 */

type AppleStreamLeaseEntry = {
  count: number;
  /**
   * Which RUN of this stream the holders belong to.
   *
   * Bumped every time the count rises from zero, so "the stream that was
   * running when I took my lease" is a value a releaser can carry. A release
   * stamped with an older epoch is a message from a stream that has already
   * ended, and it must not be allowed to stop the one running now — see
   * `releaseAppleStreamLease`.
   */
  epoch: number;
  viewer?: AppleStreamViewer;
};

const leases = new Map<string, AppleStreamLeaseEntry>();
let epochCounter = 0;

/**
 * What each held stream actually IS, so a surface that holds no lease of its
 * own can still answer "is this lane's device streaming right now, and which
 * device is it?" without an IPC round trip.
 *
 * Round 4 §B4: the floating player used to take a visible moment to appear
 * because the handover asked the runtime `deviceList` before it opened —
 * a question the renderer already knew the answer to. A viewer only holds a
 * lease while its stream is wanted, so the presence of one is the liveness
 * check, and it is synchronous.
 */
export type AppleStreamViewer = {
  laneId: string | null;
  deviceUdid: string;
  pinKey: string | null;
};

/**
 * One key per stream the helper can actually be running.
 *
 * The machine is in the key because two tabs bound to different Macs can show
 * the same lane id, and they are not watching the same capture.
 */
export function appleStreamLeaseKey(args: {
  pinKey: string | null | undefined;
  laneId: string | null | undefined;
  deviceUdid: string;
}): string {
  const pin = args.pinKey?.trim() || "bound";
  const lane = args.laneId?.trim() || "no-lane";
  return `${pin}::${lane}::${args.deviceUdid}`;
}

/**
 * Take a lease. `first` is true for the viewer that has to start the stream.
 *
 * The returned `epoch` identifies the run this lease belongs to. Hand it back
 * to `releaseAppleStreamLease` — a viewer that does not is trusting that no
 * newer stream can have started in between, which is exactly the assumption
 * that stopped a freshly-opened pane's capture.
 */
export function acquireAppleStreamLease(
  key: string,
  /** What this viewer is watching. Omitted by a holder that only parks a count. */
  viewer?: AppleStreamViewer,
): { first: boolean; epoch: number } {
  const entry = leases.get(key);
  if (!entry || entry.count <= 0) {
    epochCounter += 1;
    const fresh: AppleStreamLeaseEntry = { count: 1, epoch: epochCounter };
    if (viewer) fresh.viewer = viewer;
    leases.set(key, fresh);
    return { first: true, epoch: fresh.epoch };
  }
  entry.count += 1;
  if (viewer) entry.viewer = viewer;
  return { first: false, epoch: entry.epoch };
}

/**
 * Give a lease back. `last` is true only for the viewer that has to stop the
 * stream — every other release is a no-op for the helper.
 *
 * Releasing a key nobody holds reports `last: false`: an unmount that already
 * released must not be able to stop a stream a LATER viewer has since started.
 */
export function releaseAppleStreamLease(key: string, epoch?: number): { last: boolean } {
  const entry = leases.get(key);
  if (!entry || entry.count <= 0) {
    leases.delete(key);
    return { last: false };
  }
  /*
   * A release from a previous run is not this run's business.
   *
   * The floating player and the pane hand the device to each other, and the
   * loser of that handover unmounts a commit or two after the winner has
   * already started streaming. Without this guard the loser's release could
   * reach zero against the NEW run's count and fire a lane-scoped `stopStream`
   * at a capture that had just been started — the service goes on reporting
   * `running: true` (its own short-circuit then refuses to start another one)
   * while the helper has stopped encoding, and the pane sits on "Connecting
   * video" until the renderer is reloaded. Stamping the epoch makes that
   * message from the past a no-op instead of a race.
   */
  if (epoch !== undefined && epoch !== entry.epoch) return { last: false };
  entry.count -= 1;
  if (entry.count === 0) {
    leases.delete(key);
    return { last: true };
  }
  return { last: false };
}

/**
 * The stream running for a lane right now, or null.
 *
 * Synchronous and exact: it is derived from the leases actually held, not from
 * a device's power state, so it answers "there are frames to hand over"
 * rather than "a simulator is booted", which is the question the handover has.
 */
export function appleStreamViewerForLane(
  laneId: string | null | undefined,
): (AppleStreamViewer & { key: string }) | null {
  const wanted = laneId?.trim() || null;
  if (!wanted) return null;
  for (const [key, entry] of leases) {
    if (entry.count <= 0 || !entry.viewer) continue;
    if (entry.viewer.laneId === wanted) return { ...entry.viewer, key };
  }
  return null;
}

/**
 * Drop every lease for a lane, without stopping anything.
 *
 * For a device that is being POWERED OFF: its stream is going away with it, so
 * the counts that described it are not facts about the world any more. Leaving
 * them behind would mean the next viewer of a freshly started device is not
 * seen as the first one, and a later unmount would aim a stop at a run that no
 * longer exists. Deliberately silent — the caller is already stopping the
 * stream and shutting the device down; this only forgets the bookkeeping.
 */
export function forgetAppleStreamLeasesForLane(laneId: string | null | undefined): void {
  const wanted = laneId?.trim() || null;
  if (!wanted) return;
  for (const [key, entry] of [...leases]) {
    // The lane is the middle segment of the key, which also catches a parked
    // hold — one that carries a count but no viewer to match on.
    const matchesKey = key.split("::")[1] === wanted;
    if (matchesKey || entry.viewer?.laneId === wanted) leases.delete(key);
  }
}

/** How many viewers hold this stream. Diagnostics and tests. */
export function appleStreamLeaseCount(key: string): number {
  return leases.get(key)?.count ?? 0;
}

/** Which run this key is on, or 0 when nobody holds it. Diagnostics and tests. */
export function appleStreamLeaseEpoch(key: string): number {
  return leases.get(key)?.epoch ?? 0;
}

/** Test-only: drops every lease. */
export function resetAppleStreamLeases(): void {
  leases.clear();
}
