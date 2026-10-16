import { SceneImageLayer } from "../../scene/SceneImageLayer";
import { useActiveScene } from "../../scene/useScene";

/**
 * The window's scene picture behind a chat surface (the Chats page, the
 * Browser tab's dock), so it sits on the same wallpaper as the home page.
 *
 * Mount it first inside a `relative` box marked `.ade-chat-scene`; the planes
 * above it (`.ade-chat-scene-plane`) go frosted over the picture by the rules
 * in `styles/scene.css`. Nothing renders without a picture: the gradient scene
 * keeps the plain page background, because a transcript over the animated
 * mesh costs a shader loop for no gain in reading.
 */
export function ChatSceneBackdrop() {
  const scene = useActiveScene();
  if (scene.kind !== "image" || !scene.showImage) return null;
  return <SceneImageLayer scene={scene} />;
}
