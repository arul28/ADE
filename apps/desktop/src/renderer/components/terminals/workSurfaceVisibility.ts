export const WORK_SURFACE_REVEALED_EVENT = "ade:work-surface-revealed";

export function dispatchWorkSurfaceRevealed(): void {
  window.dispatchEvent(new Event(WORK_SURFACE_REVEALED_EVENT));
}
