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

const holders = new Map<string, number>();

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

/** Take a lease. `first` is true for the viewer that has to start the stream. */
export function acquireAppleStreamLease(key: string): { first: boolean } {
  const next = (holders.get(key) ?? 0) + 1;
  holders.set(key, next);
  return { first: next === 1 };
}

/**
 * Give a lease back. `last` is true only for the viewer that has to stop the
 * stream — every other release is a no-op for the helper.
 *
 * Releasing a key nobody holds reports `last: false`: an unmount that already
 * released must not be able to stop a stream a LATER viewer has since started.
 */
export function releaseAppleStreamLease(key: string): { last: boolean } {
  const current = holders.get(key) ?? 0;
  if (current <= 0) {
    holders.delete(key);
    return { last: false };
  }
  const next = current - 1;
  if (next === 0) {
    holders.delete(key);
    return { last: true };
  }
  holders.set(key, next);
  return { last: false };
}

/** How many viewers hold this stream. Diagnostics and tests. */
export function appleStreamLeaseCount(key: string): number {
  return holders.get(key) ?? 0;
}

/** Test-only: drops every lease. */
export function resetAppleStreamLeases(): void {
  holders.clear();
}
