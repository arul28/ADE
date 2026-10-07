import { useLayoutEffect, useRef, useState } from "react";
import type { ActiveScene } from "./useScene";

type ImageScene = Extract<ActiveScene, { kind: "image" }>;

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
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        setFrame((prev) => {
          const next = { left: rect.left, top: rect.top, width: window.innerWidth, height: window.innerHeight };
          return prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
            ? prev
            : next;
        });
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const visible = scene.url !== null && loadedUrl === scene.url;

  return (
    <div ref={hostRef} aria-hidden className="ade-scene-layer">
      <div
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
        {scene.url ? (
          <img
            key={scene.url}
            src={scene.url}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={() => setLoadedUrl(scene.url)}
            className="ade-scene-image"
            style={{ objectPosition: scene.position }}
          />
        ) : null}
        <div className="ade-scene-veil" />
        <div className="ade-scene-texture" />
      </div>
    </div>
  );
}
