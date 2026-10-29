import { normalizeUpdateTrack, type UpdateTrack } from "../../shared/updateTrack";

/**
 * The running build's update track, from the synchronous preload bridge.
 * Missing bridge (the web app, tests) means Stable.
 */
export function rendererUpdateTrack(): UpdateTrack {
  if (typeof window === "undefined") return "stable";
  const bridged = (window as { ade?: { app?: { updateTrack?: unknown } } }).ade?.app?.updateTrack;
  return normalizeUpdateTrack(bridged) ?? "stable";
}
