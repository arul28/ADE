import { SceneImageLayer } from "./SceneImageLayer";
import { useActiveScene } from "./useScene";

/**
 * Frosted glass over the scene picture, without a backdrop-filter.
 *
 * On macOS, Chromium draws the whole window again for every change (a caret,
 * a streamed word) while any element on the page has a backdrop-filter. This
 * paints the same look from the picture itself: the box's slice of the
 * window-sized picture (`SceneImageLayer`, aligned with the page's picture),
 * a plain `filter` blur on it, and the box's tint on top. A static filter on
 * a static image is drawn once, so a change elsewhere stays a small redraw.
 *
 * Mount it as the first child of the frosted box. The box's CSS takes it from
 * there (`styles/scene.css`): for `.box:has(> .ade-scene-frost)` it sets
 * `isolation: isolate`, drops its own background and inset shadows, and puts
 * them in `--scene-frost-tint` and `--scene-frost-inset`, with the blur in
 * `--scene-frost-blur` and `--scene-frost-saturate`.
 *
 * Without a picture (the gradient mesh, the plain scene) it renders nothing,
 * and the box keeps its own flat background.
 */
export function SceneFrost() {
  const scene = useActiveScene();
  if (scene.kind !== "image" || !scene.showImage) return null;
  return (
    <div aria-hidden className="ade-scene-frost">
      <div className="ade-scene-frost-blur">
        <SceneImageLayer scene={scene} variant="frost" />
      </div>
      <div className="ade-scene-frost-tint" />
    </div>
  );
}
