import { useLayoutEffect, useRef, useState } from "react";
import type { ActiveScene } from "./useScene";

type ImageScene = Extract<ActiveScene, { kind: "image" }>;

// `.ade-scene-frame`'s opacity transition (scene.css).
const FADE_MS = 420;
// When each picture first showed in this window. A layer that mounts later for
// a picture already on screen (the Work page taking over from the early prompt
// box, a tab coming back) shows it at once, in step with any fade still
// running, instead of fading it in again from nothing.
const shownAt = new Map<string, number>();

/**
 * One box's slice of a window-sized picture.
 *
 * Every surface that paints the window field (the top bar, the welcome
 * screen, the new chat page) mounts one of these. Each sizes an inner layer to
 * the whole window and shifts it by its own offset, so the slices meet as one
 * picture with no seam — the same contract the mesh keeps with its `view`
 * uniform. The picture stays the hero: the veil (`dim`), the texture and the
 * soft top scrim behind the title bar are the only things painted over it.
 *
 * It is a plain <img> and a few gradients: no canvas, no animation, nothing
 * to pause when the window blurs.
 */
export function SceneImageLayer({ scene }: { scene: ImageScene }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  // Read once, at mount: the picture this layer opens on is already on screen.
  const [shownOnMount] = useState(() => (scene.url !== null && shownAt.has(scene.url) ? scene.url : null));
  // The file on screen, and the picture it belongs to.
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(() =>
    shownOnMount ? { id: scene.id, url: shownOnMount } : null,
  );
  const loadedUrl = loaded?.url ?? null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const measureNow = () => {
      const rect = host.getBoundingClientRect();
      setFrame((prev) => {
        const next = { left: rect.left, top: rect.top, width: window.innerWidth, height: window.innerHeight };
        return prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
          ? prev
          : next;
      });
    };
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measureNow);
    };
    if (shownOnMount) {
      // Visible from the first frame, so it must sit at its window offset
      // from the first frame too; the deferred measure would show one frame
      // of the picture shifted by this box's offset.
      measureNow();
      const elapsed = performance.now() - (shownAt.get(shownOnMount) ?? 0);
      if (elapsed < FADE_MS) {
        frameRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay: -elapsed, easing: "ease" });
      }
    } else {
      measure();
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
    // Mount only: `shownOnMount` never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another file of the same picture (a size for another screen, or a user
  // picture's screen-sized copy) replaces the one on screen without a gap:
  // the old file stays drawn under the new one until the new one is decoded,
  // then goes. They show the same picture at the same crop, so nothing moves.
  // A different picture fades in from nothing, as before.
  const swapping = scene.url !== null && loaded !== null && loaded.id === scene.id && loaded.url !== scene.url;
  const visible = scene.url !== null && (loadedUrl === scene.url || swapping);

  return (
    <div ref={hostRef} aria-hidden className="ade-scene-layer">
      <div
        ref={frameRef}
        className="ade-scene-frame"
        data-texture={scene.texture}
        style={{
          left: -frame.left,
          top: -frame.top,
          width: frame.width || "100vw",
          height: frame.height || "100vh",
          opacity: visible ? 1 : 0,
          ["--scene-dim" as string]: String(scene.dim / 100),
        }}
      >
        {swapping && loadedUrl ? (
          <img
            key={loadedUrl}
            src={loadedUrl}
            alt=""
            draggable={false}
            className="ade-scene-image"
            style={{ objectPosition: scene.position }}
          />
        ) : null}
        {scene.url ? (
          <img
            key={scene.url}
            src={scene.url}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={(event) => {
              const url = scene.url;
              const id = scene.id;
              if (!url) return;
              const show = () => {
                // A file that replaces another of the same picture keeps its
                // first-shown time, so a layer that mounts later does not fade.
                if (!shownAt.has(url)) shownAt.set(url, (loadedUrl && shownAt.get(loadedUrl)) || performance.now());
                setLoaded((prev) => (prev?.url === url ? prev : { id, url }));
              };
              // While another file of this picture is on screen, wait until
              // this one is decoded, so the swap never paints an empty frame.
              if (swapping) void event.currentTarget.decode().catch(() => undefined).then(show);
              else show();
            }}
            className="ade-scene-image"
            style={{ objectPosition: scene.position, ...(swapping ? { opacity: 0 } : null) }}
          />
        ) : null}
        <div className="ade-scene-veil" />
        <div className="ade-scene-texture" />
      </div>
    </div>
  );
}
