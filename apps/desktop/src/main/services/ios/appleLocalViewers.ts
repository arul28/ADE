/**
 * Which lanes have a viewer on THIS machine's renderer.
 *
 * `appleStreamRelay` stops only the lanes it started, which covers the common
 * direction: the desktop brings a capture up, a phone joins, the phone leaves,
 * the desktop keeps its frames. It does not cover the other direction. When a
 * web tab starts the capture and the desktop column joins afterwards, the web
 * tab closing is the relay's last remote viewer, the lane IS one the relay
 * started, and the stop lands on a device somebody is still looking at.
 *
 * The relay already asks — `closeSource({ laneId, localViewers })` — it just
 * had nothing to ask. This registry is the answer: the IPC layer marks a lane
 * while a renderer holds a stream on it, and the relay consults it before
 * stopping anything.
 *
 * A count rather than a flag: two renderer viewers of one lane are normal (the
 * column and the corner card), and the first of them to stop must not clear the
 * mark for the second. Module scope because there is one helper, one service
 * and one main process per machine — the same scope the service itself has.
 */

const viewersByLane = new Map<string, number>();

function normalize(laneId: string | null | undefined): string | null {
  const lane = typeof laneId === "string" ? laneId.trim() : "";
  return lane.length > 0 ? lane : null;
}

/** A renderer started a stream on this lane. */
export function noteAppleLocalViewerStarted(laneId: string | null | undefined): void {
  const lane = normalize(laneId);
  if (!lane) return;
  viewersByLane.set(lane, (viewersByLane.get(lane) ?? 0) + 1);
}

/** A renderer stopped its stream on this lane. Never goes below zero. */
export function noteAppleLocalViewerStopped(laneId: string | null | undefined): void {
  const lane = normalize(laneId);
  if (!lane) return;
  const next = (viewersByLane.get(lane) ?? 0) - 1;
  if (next <= 0) viewersByLane.delete(lane);
  else viewersByLane.set(lane, next);
}

/** What `closeSource` asks before it stops a capture. */
export function hasAppleLocalViewer(laneId: string | null | undefined): boolean {
  const lane = normalize(laneId);
  return lane ? (viewersByLane.get(lane) ?? 0) > 0 : false;
}

/** Test-only. */
export function resetAppleLocalViewers(): void {
  viewersByLane.clear();
}
