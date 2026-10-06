import fs from "node:fs";
import { JsonRpcClient, JsonRpcResponseError } from "../../tuiClient/jsonRpcClient";
import type { ScenePreviewRequest, ScenePreviewResult } from "../../../../desktop/src/shared/scenePreview";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "./desktopBridgeMethods";

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

const CONNECT_TIMEOUT_MS = 3_000;
/** Above the previewer's own deadline, so the desktop's clearer error arrives first. */
const RENDER_TIMEOUT_MS = 45_000;
const NO_DESKTOP = "Previewing a scene needs the ADE desktop app on this machine, and none is attached.";

export type ScenePreviewer = {
  render(request: ScenePreviewRequest): Promise<ScenePreviewResult>;
  dispose(): void;
};

export function createScenePreviewBridgeClient(args: {
  socketPath: string;
  getAuthToken: () => string | null;
}): ScenePreviewer {
  const { socketPath } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");
  let client: JsonRpcClient | null = null;
  let connecting: Promise<JsonRpcClient> | null = null;
  let disposed = false;

  const ensureClient = async (): Promise<JsonRpcClient> => {
    if (client) return client;
    if (disposed) throw new Error("The scene preview bridge was disposed.");
    if (!connecting) {
      connecting = (async () => {
        if (!isNamedPipe && !fs.existsSync(socketPath)) throw new Error(NO_DESKTOP);
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          const next = await Promise.race([
            JsonRpcClient.connect(socketPath),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Timed out connecting to the ADE desktop app.")), CONNECT_TIMEOUT_MS);
            }),
          ]);
          next.onClose(() => {
            if (client === next) client = null;
          });
          client = next;
          return next;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })().finally(() => {
        connecting = null;
      });
    }
    return await connecting;
  };

  return {
    async render(request) {
      if (disposed) throw new Error("The scene preview bridge was disposed.");
      const token = args.getAuthToken()?.trim();
      if (!token) throw new Error(NO_DESKTOP);
      const c = await ensureClient();
      try {
        return await c.request<ScenePreviewResult>(
          `${SCENE_PREVIEW_BRIDGE_PREFIX}render`,
          { request, [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: token },
          { timeoutMs: RENDER_TIMEOUT_MS },
        );
      } catch (error) {
        // A render's own failure is an answer; only a transport failure drops the socket.
        if (client === c && !(error instanceof JsonRpcResponseError)) {
          client = null;
          try { c.close(); } catch { /* ignore */ }
        }
        throw error;
      }
    },
    dispose() {
      disposed = true;
      const c = client;
      client = null;
      if (c) {
        try { c.close(); } catch { /* ignore */ }
      }
    },
  };
}
