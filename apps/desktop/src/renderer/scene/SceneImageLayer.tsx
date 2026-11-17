import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActiveScene } from "./useScene";

type ImageScene = Extract<ActiveScene, { kind: "image" }>;

// `.ade-scene-frame`'s opacity transition (scene.css).
const FADE_MS = 420;
// When each picture first showed in this window. A layer that mounts later for
// a picture already on screen (the Work page taking over from the early prompt
// box, a tab coming back) shows it at once, in step with any fade still
// running, instead of fading it in again from nothing.
const shownAt = new Map<string, number>();

/*
 * A window's first picture waits for its first prompt box.
 *
 * At launch the picture (up to 1.9 MB, decoded to a window-sized bitmap) was
 * fetched while the prompt box's own code was still loading from the same
 * cold disk, and decoded beside the first frames a person types into. It
 * fades in anyway, so it now starts a moment after the prompt box has painted
 * (`ade:early-composer:shown` or `ade:boot:composer`), or at
 * FIRST_PICTURE_MAX_WAIT_MS into the page on a screen with no prompt box.
 * Later pictures, and layers that mount later, load at once.
 */
const FIRST_PICTURE_SETTLE_MS = 250;
const FIRST_PICTURE_MAX_WAIT_MS = 1_500;
const PROMPT_BOX_MARKS = ["ade:early-composer:shown", "ade:boot:composer"];
let firstPictureAllowed = false;
let firstPictureWait: Promise<void> | null = null;

function promptBoxMarked(): boolean {
  try {
    return PROMPT_BOX_MARKS.some((name) => performance.getEntriesByName(name, "mark").length > 0);
  } catch {
    return false;
  }
}

function waitForFirstPicture(): Promise<void> {
  firstPictureWait ??= new Promise<void>((resolve) => {
    let observer: PerformanceObserver | null = null;
    let settleTimer: number | null = null;
    const allow = () => {
      observer?.disconnect();
      window.clearTimeout(capTimer);
      if (settleTimer != null) window.clearTimeout(settleTimer);
      firstPictureAllowed = true;
      resolve();
    };
    const settle = () => {
      if (settleTimer == null) settleTimer = window.setTimeout(allow, FIRST_PICTURE_SETTLE_MS);
    };
    const capTimer = window.setTimeout(allow, Math.max(0, FIRST_PICTURE_MAX_WAIT_MS - performance.now()));
    if (promptBoxMarked()) {
      settle();
      return;
    }
    try {
      observer = new PerformanceObserver((list) => {
        if (list.getEntries().some((entry) => PROMPT_BOX_MARKS.includes(entry.name))) settle();
      });
      observer.observe({ type: "mark" });
    } catch {
      // No observer: the cap still lets the picture in.
    }
  });
  return firstPictureWait;
}

/**
 * Where a box rests in the window: its layout position, without the
 * transforms of it and the boxes around it (an entrance slide, a scale).
 * Offsets are whole pixels, so it can be off by under a pixel per offset
 * parent; under a frost blur that does not show.
 */
function restingOffset(el: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    left += node.offsetLeft;
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    // The body, or a fixed box: its offsets are already from the window.
    if (!parent) break;
    // Scrolled boxes between this one and its offset parent (that one too).
    for (let box: HTMLElement | null = node.parentElement; box; box = box.parentElement) {
      left -= box.scrollLeft;
      top -= box.scrollTop;
      if (box === parent) break;
    }
    left += parent.clientLeft;
    top += parent.clientTop;
    node = parent;
  }
  return { left, top };
}

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
 *
 * `variant="frost"` is the slice inside a frosted box (`SceneFrost`). Such a
 * box moves without changing size (the prompt box above it grows a line and
 * pushes it down), so the layer also re-measures when any box around it
 * changes size, measures at once instead of on the next frame, and reads
 * the box's resting place, not its place mid-animation (an entrance slide
 * would leave the slice off by the slide's distance). It never fades.
 */
export function SceneImageLayer({ scene, variant = "page" }: { scene: ImageScene; variant?: "page" | "frost" }) {
  const frost = variant === "frost";
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
  const [pictureAllowed, setPictureAllowed] = useState(() => firstPictureAllowed || shownOnMount !== null);

  useEffect(() => {
    if (pictureAllowed) return;
    let live = true;
    void waitForFirstPicture().then(() => {
      if (live) setPictureAllowed(true);
    });
    return () => {
      live = false;
    };
  }, [pictureAllowed]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const measureNow = () => {
      const rect = frost ? restingOffset(host) : host.getBoundingClientRect();
      const next = { left: rect.left, top: rect.top, width: window.innerWidth, height: window.innerHeight };
      if (frost) {
        // Called from the resize observer, after layout and before paint:
        // place the frame now so the move and the slice land in one frame.
        // The state below keeps the next render at the same place.
        const frameEl = frameRef.current;
        if (frameEl) {
          frameEl.style.left = `${-next.left}px`;
          frameEl.style.top = `${-next.top}px`;
          frameEl.style.width = `${next.width}px`;
          frameEl.style.height = `${next.height}px`;
        }
      }
      setFrame((prev) =>
        prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
          ? prev
          : next,
      );
    };
    const measure = frost
      ? measureNow
      : () => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(measureNow);
        };
    if (frost) {
      measureNow();
    } else if (shownOnMount) {
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
    if (frost) {
      // A box moves when a box around it changes size. Watching each one
      // costs nothing at rest: the observer only calls back on a change.
      for (let node = host.parentElement; node && node !== document.body; node = node.parentElement) {
        observer?.observe(node);
      }
    }
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
        data-variant={frost ? "frost" : undefined}
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
        {scene.url && pictureAllowed ? (
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
