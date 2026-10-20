import { useEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * The real ADE app, running in the page. `/demo/` is the desktop renderer
 * built as a static site (apps/desktop: `npm run build:demo`). It runs on
 * its browser mock with a made-up project, so it needs no account, machine or
 * server, and every chip, card and menu is the app's own.
 *
 * The app is laid out at a fixed desktop size and scaled to the frame, so it
 * keeps its real layout at any page width.
 */
/** The logical screen of a 14-inch MacBook Pro, the size ADE's panels are designed for. */
export const DEMO_W = 1512;
export const DEMO_H = 982;
export const DEMO_URL = "/demo/index.html#/work?sessionId=demo-chat-checkout";

export function LiveDemo({
  poster,
  className,
  interactive = true,
  onReady,
}: {
  poster?: string;
  className?: string;
  /** False when the page drives the app (the scroll story): clicks then go to the page, and no hint shows. */
  interactive?: boolean;
  /** Called once the app has painted, with its window, for a page that drives it. */
  onReady?: (app: Window) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0);
  const [ready, setReady] = useState(false);
  const [touched, setTouched] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number; flipX: boolean; flipY: boolean } | null>(null);

  // The app runs on the same origin, so its own document reports the first
  // click; the hint leaves for good after it.
  const onFrameLoad = () => {
    window.setTimeout(() => {
      setReady(true);
      const app = iframeRef.current?.contentWindow;
      if (app && onReady) onReady(app);
    }, 700);
    if (!interactive) return;
    const doc = iframeRef.current?.contentWindow?.document;
    if (!doc) return;
    const markTouched = () => setTouched(true);
    doc.addEventListener("pointerdown", markTouched, { once: true, capture: true });
    // Pointer moves inside the iframe do not reach this page; mirror them, scaled back to page pixels.
    doc.addEventListener("pointermove", (event) => {
      const frame = frameRef.current;
      const s = frame ? frame.clientWidth / DEMO_W : 1;
      const x = event.clientX * s;
      const y = event.clientY * s;
      // Near the right or bottom edge the hint sits on the other side of the pointer, so it never wraps or leaves the frame.
      setPointer({ x, y, flipX: !!frame && x > frame.clientWidth - 340, flipY: !!frame && y > frame.clientHeight - 60 });
    });
    doc.addEventListener("pointerleave", () => setPointer(null));
  };

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / DEMO_W);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className={cn("relative w-full overflow-hidden rounded-[14px] border border-white/[0.12] bg-[#0b0b10]", className)}
      style={{ aspectRatio: `${DEMO_W} / ${DEMO_H}` }}
    >
      {scale > 0 ? (
        <iframe
          title="ADE, running live in your browser"
          src={DEMO_URL}
          ref={iframeRef}
          onLoad={onFrameLoad}
          tabIndex={interactive ? undefined : -1}
          className={cn("absolute left-0 top-0 origin-top-left border-0", !interactive && "pointer-events-none")}
          style={{ width: DEMO_W, height: DEMO_H, transform: `scale(${scale})` }}
        />
      ) : null}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-10 transition-opacity duration-500",
          touched || !ready || !interactive ? "opacity-0" : "opacity-100",
        )}
        style={
          pointer
            ? {
                left: pointer.x + (pointer.flipX ? -14 : 18),
                top: pointer.y + (pointer.flipY ? -14 : 18),
                transform: `translate(${pointer.flipX ? "-100%" : "0"}, ${pointer.flipY ? "-100%" : "0"})`,
              }
            : { left: "50%", top: "46%", transform: "translate(-50%, -50%)" }
        }
      >
        <div className={cn("flex items-center gap-2 whitespace-nowrap rounded-full border border-white/15 bg-[#14121c]/90 py-1.5 pl-2 pr-3.5 text-[12.5px] text-white shadow-[0_12px_40px_rgba(0,0,0,0.55),0_0_30px_rgba(124,58,237,0.35)] backdrop-blur", !pointer && "ade-float")}>
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[color:var(--color-violet-bright)] text-[#0a0a0f]">
            <MousePointer2 className="h-3.5 w-3.5" />
          </span>
          Interact with the app to see how it works
        </div>
      </div>
      {poster ? (
        <img
          src={poster}
          alt=""
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700",
            ready ? "opacity-0" : "opacity-100",
          )}
        />
      ) : null}
    </div>
  );
}
