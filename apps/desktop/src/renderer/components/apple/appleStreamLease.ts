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

import type { OpenProjectBinding } from "../../../shared/types";
import { laneOnMachineKey } from "../../lib/chatMachineRouting";
import { createStreamLeaseTable } from "../device/streamLease";

/**
 * What Apple keeps on top of the shared count and epoch (the epoch is which
 * RUN of the stream a holder belongs to; see `releaseAppleStreamLease`).
 */
type AppleStreamLeaseMeta = {
  /** The key the first holder took it under. */
  key: AppleStreamLeaseKey;
  viewer?: AppleStreamViewer;
};

const leases = createStreamLeaseTable<AppleStreamLeaseMeta>();

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
  pinKey: string;
};

type AppleStreamScopeArgs = {
  /** The session's pin; null means the machine this window is bound to. */
  pin: OpenProjectBinding | null | undefined;
  /** The window's current binding, which a null pin resolves to. */
  bound: OpenProjectBinding | null | undefined;
  laneId: string | null | undefined;
};

/**
 * One key per stream the helper can actually be running.
 *
 * The machine is in the key because two tabs bound to different Macs can show
 * the same lane id, and they are not watching the same capture.
 */
export type AppleStreamLeaseKey = {
  /** The stream: machine, lane and device. */
  id: string;
  /**
   * The machine and lane. `stopStream` is scoped to this, not to one device.
   *
   * The pin is resolved here, so a viewer holding a null pin and one holding
   * the same machine resolved (`local:/…`) count in one bucket. Two spellings
   * were two buckets, and each viewer leaving was "the last one" of its own.
   */
  laneScope: string;
  /** The lane id, or "no-lane". */
  laneId: string;
};

export function appleStreamLeaseKey(args: AppleStreamScopeArgs & { deviceUdid: string }): AppleStreamLeaseKey {
  const laneId = args.laneId?.trim() || "no-lane";
  const laneScope = laneOnMachineKey(args.pin, args.bound, laneId);
  return { id: `${laneScope}::${args.deviceUdid}`, laneScope, laneId };
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
  key: AppleStreamLeaseKey,
  /** What this viewer is watching. Omitted by a holder that only parks a count. */
  viewer?: AppleStreamViewer,
): { first: boolean; epoch: number } {
  const { first, epoch, meta } = leases.acquire(key.id, () => ({ key }));
  if (viewer) meta.viewer = viewer;
  return { first, epoch };
}

/**
 * Give a lease back. `last` is true only for the viewer that has to stop the
 * stream — every other release is a no-op for the helper.
 *
 * Releasing a key nobody holds reports `last: false`: an unmount that already
 * released must not be able to stop a stream a LATER viewer has since started.
 */
export function releaseAppleStreamLease(key: AppleStreamLeaseKey, epoch?: number): { last: boolean } {
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
   * message from the past a no-op instead of a race. The shared table makes
   * both checks.
   */
  return leases.release(key.id, epoch);
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
  /** The machine, as `workRuntimeScopeKey` spells it. */
  pinKey: string,
): (AppleStreamViewer & { key: AppleStreamLeaseKey }) | null {
  const wanted = laneId?.trim() || null;
  if (!wanted) return null;
  for (const [, entry] of leases.entries()) {
    const viewer = entry.meta.viewer;
    if (entry.count <= 0 || !viewer) continue;
    if (viewer.pinKey !== pinKey) continue;
    if (viewer.laneId === wanted) return { ...viewer, key: entry.meta.key };
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
  for (const [id, entry] of [...leases.entries()]) {
    // The entry's own lane also catches a parked hold, which has no viewer.
    if (entry.meta.key.laneId === wanted || entry.meta.viewer?.laneId === wanted) leases.forget(id);
  }
}

/**
 * How many leases are held on the lane and machine of `key`, on any device.
 *
 * The stop the last viewer arms is lane-scoped, so a new device on the same
 * lane (a swap inside one viewer, or the floating player moving to another
 * device) must keep it from firing.
 */
export function appleStreamLaneLeaseCount(key: AppleStreamLeaseKey): number {
  let count = 0;
  for (const [, entry] of leases.entries()) {
    if (entry.meta.key.laneScope === key.laneScope) count += Math.max(0, entry.count);
  }
  return count;
}

/** How many viewers hold this stream. Diagnostics and tests. */
export function appleStreamLeaseCount(key: AppleStreamLeaseKey): number {
  return leases.count(key.id);
}

/** Which run this key is on, or 0 when nobody holds it. Diagnostics and tests. */
export function appleStreamLeaseEpoch(key: AppleStreamLeaseKey): number {
  return leases.epoch(key.id);
}

/** Test-only: drops every lease. */
export function resetAppleStreamLeases(): void {
  leases.clear();
}
