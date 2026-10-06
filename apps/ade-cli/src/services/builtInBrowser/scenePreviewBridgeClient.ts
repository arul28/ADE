import type { ScenePreviewRequest, ScenePreviewResult } from "../../../../desktop/src/shared/scenePreview";
import { createDesktopBridgeConnection } from "./desktopBridgeConnection";

/**
 * The desktop app's scene previewer as the runtime daemon reaches it.
 *
 * `ade scene preview` renders an agent's scene the way the chat will — the same
 * document, SDK, policy and sandbox — in a hidden desktop window, and answers
 * with a screenshot and what went wrong. That needs Chromium, so it lives in
 * the desktop and is reached over the desktop bridge socket with the bridge
 * token, like the demo engine.
 */

export const SCENE_PREVIEW_BRIDGE_PREFIX = "scene_preview.";
export const SCENE_PREVIEW_BRIDGE_METHODS = ["render"] as const;
export type ScenePreviewBridgeMethod = (typeof SCENE_PREVIEW_BRIDGE_METHODS)[number];

export function isScenePreviewBridgeMethod(name: string): name is ScenePreviewBridgeMethod {
  return (SCENE_PREVIEW_BRIDGE_METHODS as readonly string[]).includes(name);
}

/** Above the previewer's own deadline, so the desktop's clearer error arrives first. */
const RENDER_TIMEOUT_MS = 45_000;
export const SCENE_PREVIEW_NO_DESKTOP = "Previewing a scene needs the ADE desktop app on this machine, and none is attached.";

export type ScenePreviewer = {
  render(request: ScenePreviewRequest): Promise<ScenePreviewResult>;
  dispose(): void;
};

export function createScenePreviewBridgeClient(args: {
  socketPath: string;
  getAuthToken: () => string | null;
}): ScenePreviewer {
  const connection = createDesktopBridgeConnection({
    ...args,
    unavailableMessage: SCENE_PREVIEW_NO_DESKTOP,
    closedMessage: "The scene preview bridge was disposed.",
  });
  // One render in flight at a time, as the desktop runs them. Queued here, so
  // each request's timeout starts when it is sent: a preview waiting behind two
  // slow ones would otherwise time out in transit and drop the shared socket.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    render: (request) => {
      const run = queue.then(() =>
        connection.request<ScenePreviewResult>(`${SCENE_PREVIEW_BRIDGE_PREFIX}render`, { request }, RENDER_TIMEOUT_MS));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose: () => connection.close(),
  };
}
