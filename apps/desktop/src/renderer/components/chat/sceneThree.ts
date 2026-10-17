/**
 * three.js for 3D scenes, on the renderer side: loading the bundle and
 * limiting how many 3D frames run at once.
 *
 * The bundle (~760 KB, `vite.sceneThree.ts`) is fetched the first time a scene
 * that uses 3D comes on screen and kept for the session as one string. A
 * transcript with no 3D never loads it.
 */

import { captureError, captureProblem, isSentryActive } from "../../../shared/sentry/capture";

let loaded: string | null = null;
/** One report per session: every 3D scene would otherwise report the same miss. */
let reported = false;
let pending: Promise<string> | null = null;

/** The three.js source, once it is known. Null until the first load finishes. */
export function sceneThreeSourceNow(): string | null {
  return loaded;
}

async function fetchThree(): Promise<string> {
  const { default: url } = await import("virtual:ade-scene-three");
  if (!url) return "";
  const response = await fetch(url);
  if (response.ok) return await response.text();
  // Otherwise every 3D scene fails with "THREE is not defined", which reads
  // as the agent's bug; say what actually went missing.
  if (!reported && isSentryActive()) {
    reported = true;
    captureProblem("Scene three.js bundle request failed", {
      fingerprint: ["scene", "three-bundle", "request"],
      tags: { status: response.status },
      handled: true,
    });
  }
  return "";
}

/**
 * Load the bundle once; resolves "" when it cannot be had. Never rejects. Only
 * a real bundle is kept: a failure (a dev server still starting, a bad
 * response) is tried again the next time a 3D scene asks.
 */
export function loadSceneThreeSource(): Promise<string> {
  if (loaded !== null) return Promise.resolve(loaded);
  pending ??= fetchThree()
    .catch((error: unknown) => {
      if (!reported && isSentryActive()) {
        reported = true;
        captureError(error, { fingerprint: ["scene", "three-bundle", "load"], handled: true });
      }
      return "";
    })
    .then((source) => {
      if (source) loaded = source;
      else pending = null;
      return source;
    });
  return pending;
}

/**
 * How many 3D scene frames may be live at once.
 *
 * Every frame holds a WebGL context, and sandboxed frames share one renderer
 * process, where Chromium keeps 16 contexts at most and silently kills the
 * oldest past that. Each context is also GPU memory and a compositing layer.
 * Frames only run while on screen, so more than a few at once means a tall
 * window full of models; past the cap the scene seen longest ago falls back to
 * its still, and comes back live when it is next scrolled to.
 */
export const MAX_LIVE_THREE_FRAMES = 4;

type Slot = { evict: () => void };
const slots: Slot[] = [];

/**
 * Take a live-3D slot. Past the cap, the oldest holder is told to stand down.
 * Returns the release function; releasing twice is harmless.
 */
export function claimThreeFrameSlot(evict: () => void): () => void {
  const slot: Slot = { evict };
  slots.push(slot);
  while (slots.length > MAX_LIVE_THREE_FRAMES) {
    const oldest = slots.shift();
    oldest?.evict();
  }
  return () => {
    const index = slots.indexOf(slot);
    if (index !== -1) slots.splice(index, 1);
  };
}
