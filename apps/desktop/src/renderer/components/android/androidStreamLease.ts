/**
 * Who is still watching a lane's Android stream, counted in the renderer.
 *
 * `androidEmulator.stopStream` is lane-scoped, so the last viewer out stops
 * it, and a viewer that remounts (the tools pane switching tabs and back)
 * joins the running stream instead of cutting it. The same rule as
 * `appleStreamLease.ts`, kept in its own map on purpose: the Apple map counts
 * every lease of a lane together (`appleStreamLaneLeaseCount`) and its
 * floating player looks up "the lane's stream" there, so an Android lease in
 * it would hold an Apple stop open and hand the Apple player an emulator.
 *
 * TODO(shared device layer, plan §4): move both into one namespaced lease.
 */

import type { OpenProjectBinding } from "../../../shared/types";
import { laneOnMachineKey } from "../../lib/chatMachineRouting";

type AndroidStreamLeaseEntry = {
  count: number;
  /** Which run of the stream the holders belong to; bumped when the count rises from zero. */
  epoch: number;
};

const leases = new Map<string, AndroidStreamLeaseEntry>();
let epochCounter = 0;

/** One key per lane on one machine: the stop is lane-scoped. */
export function androidStreamLeaseKey(args: {
  pin: OpenProjectBinding | null | undefined;
  bound: OpenProjectBinding | null | undefined;
  laneId: string;
}): string {
  return laneOnMachineKey(args.pin, args.bound, args.laneId);
}

/** Take a lease. `first` is true for the viewer that starts the stream. */
export function acquireAndroidStreamLease(key: string): { first: boolean; epoch: number } {
  const entry = leases.get(key);
  if (!entry || entry.count <= 0) {
    epochCounter += 1;
    leases.set(key, { count: 1, epoch: epochCounter });
    return { first: true, epoch: epochCounter };
  }
  entry.count += 1;
  return { first: false, epoch: entry.epoch };
}

/**
 * Give a lease back. `last` is true only for the viewer that has to stop the
 * stream. A release stamped with an older run's epoch is a no-op, so a slow
 * unmount cannot stop a stream a newer viewer has started.
 */
export function releaseAndroidStreamLease(key: string, epoch?: number): { last: boolean } {
  const entry = leases.get(key);
  if (!entry || entry.count <= 0) {
    leases.delete(key);
    return { last: false };
  }
  if (epoch !== undefined && epoch !== entry.epoch) return { last: false };
  entry.count -= 1;
  if (entry.count === 0) {
    leases.delete(key);
    return { last: true };
  }
  return { last: false };
}

/** How many viewers hold the lane's stream now. */
export function androidStreamLeaseCount(key: string): number {
  return leases.get(key)?.count ?? 0;
}

/**
 * Forget a lane's leases without stopping anything: its emulator is being
 * stopped or released, so the stream goes with it, and the next viewer of a
 * fresh boot must be the first one again.
 */
export function forgetAndroidStreamLeases(key: string): void {
  leases.delete(key);
}
