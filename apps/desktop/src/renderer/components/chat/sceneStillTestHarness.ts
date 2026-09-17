import { vi } from "vitest";

import type { SceneStillRecord } from "../../../shared/chatScene";

/**
 * The three stubs every scene-still suite needs, in one place.
 *
 * A scene only takes its still when the host can capture, the shell is fully on
 * screen, and the frame says it has settled — so each suite that tests any part
 * of that had grown its own copy of all three, and they drifted: one stubbed a
 * bridge without `listArtifacts`, another posted messages without the
 * `__adeScene` marker and quietly tested nothing. These are shared so a change
 * to the protocol breaks every suite at once instead of one of them.
 */

export type SceneCaptureBridgeStub = {
  snapshot: ReturnType<typeof vi.fn>;
  storeStill: ReturnType<typeof vi.fn>;
  listArtifacts: ReturnType<typeof vi.fn>;
  readArtifactPreview: ReturnType<typeof vi.fn>;
};

export const SCENE_STILL_DATA_URL = "data:image/png;base64,STILL";

/**
 * `window.ade` with a working capture route and an empty still index.
 *
 * The index matters as much as the capture: `SceneFrame` waits for it before
 * deciding whether to run a settled scene's code, so a bridge without
 * `listArtifacts` leaves every settled row stuck on a placeholder.
 */
export function stubSceneCaptureBridge(overrides: {
  snapshot?: () => Promise<string | null>;
  storeStill?: (args: unknown) => Promise<SceneStillRecord | null>;
  artifacts?: unknown[];
  readArtifactPreview?: (args: unknown) => Promise<string | null>;
} = {}): SceneCaptureBridgeStub {
  const snapshot = vi.fn(overrides.snapshot ?? (async () => SCENE_STILL_DATA_URL));
  const storeStill = vi.fn(
    overrides.storeStill
    ?? (async () => ({
      uri: ".ade/artifacts/computer-use/s.png",
      artifactId: "a1",
      title: "Generated view",
    })),
  );
  const listArtifacts = vi.fn(async () => overrides.artifacts ?? []);
  const readArtifactPreview = vi.fn(overrides.readArtifactPreview ?? (async () => null));
  // Merged, not replaced: suites that render a whole message list install a
  // large `window.ade` of their own in `beforeEach`, and overwriting it takes
  // the rest of the surface down with it.
  const existing = (window as unknown as { ade?: Record<string, unknown> }).ade ?? {};
  (window as unknown as { ade?: unknown }).ade = {
    ...existing,
    scene: { ...(existing.scene as object | undefined), snapshot, storeStill },
    computerUse: { ...(existing.computerUse as object | undefined), listArtifacts, readArtifactPreview },
  };
  return { snapshot, storeStill, listArtifacts, readArtifactPreview };
}

/**
 * Pin every element's rect.
 *
 * The capture refuses anything less than a fully visible shell, and jsdom
 * reports zeroes for everything, so a suite that does not stub this observes a
 * scene that never captures and cannot tell that from a broken one.
 */
export function stubShellRect(rect: Partial<DOMRect> = {}): void {
  const full = {
    x: 0, y: 0, top: 0, left: 0, width: 400, height: 200, bottom: 200, right: 400, ...rect,
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(full as DOMRect);
}

/** Post one host message as the frame itself. Anything else is dropped. */
export function postSceneMessage(frame: Element, type: string, height = 200): void {
  window.dispatchEvent(new MessageEvent("message", {
    source: (frame as HTMLIFrameElement).contentWindow,
    data: { __adeScene: 1, type, payload: { height } },
  }));
}
