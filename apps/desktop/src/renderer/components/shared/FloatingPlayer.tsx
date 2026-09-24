import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { PictureInPicture } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  enterCanvasPictureInPicture,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
  type WorkLivePipSession,
} from "../work/workLiveIosPictureInPicture";
import {
  clampFloatingPlayerPosition,
  FLOATING_PLAYER_CORNER_RADIUS,
  resizeFloatingPlayer,
  resolveFloatingPlayerFrame,
  type FloatingPlayerFrame,
  type FloatingPlayerPosition,
  type FloatingPlayerResizeDirection,
  type FloatingPlayerSize,
} from "./floatingPlayerLayout";

/**
 * The floating player's shell: one box over the chat column that you drag,
 * resize from any edge, and hover for its controls.
 *
 * The floating Apple device and the floating Mac Desktop both use it, so the
 * two look and behave the same way. The picture inside is each tool's own
 * business; the shell owns the box, the gestures, the 8px status dot at rest,
 * and the hover bar that takes the dot's place (Open in pane, picture in
 * picture, Close).
 */

const RESIZE_ZONES: { direction: FloatingPlayerResizeDirection; className: string }[] = [
  { direction: "north", className: "left-2 right-2 top-0 h-2 cursor-ns-resize" },
  { direction: "south", className: "bottom-0 left-2 right-2 h-2 cursor-ns-resize" },
  { direction: "west", className: "bottom-2 left-0 top-2 w-2 cursor-ew-resize" },
  { direction: "east", className: "bottom-2 right-0 top-2 w-2 cursor-ew-resize" },
  { direction: "north-west", className: "left-0 top-0 h-2 w-2 cursor-nwse-resize" },
  { direction: "north-east", className: "right-0 top-0 h-2 w-2 cursor-nesw-resize" },
  { direction: "south-west", className: "bottom-0 left-0 h-2 w-2 cursor-nesw-resize" },
  { direction: "south-east", className: "bottom-0 right-0 h-2 w-2 cursor-nwse-resize" },
];

/**
 * How the box goes away while its picture plays in a PiP window.
 *
 * Not `hidden` and not `opacity: 0`. The PiP window captures this box's
 * canvas, and a canvas the compositor treats as not visible can hand a GPU
 * reader a black surface (see `PARKED_CANVAS_STYLE` in `AppleDeviceStage`).
 * So the box keeps its place and size and stays composited at an opacity no
 * eye can see, and takes no pointer input.
 */
const PIP_CONCEALED_STYLE = {
  opacity: 0.002,
  pointerEvents: "none" as const,
};

const FALLBACK_CONTAINER: FloatingPlayerSize = { width: 960, height: 640 };

/** What the user chose for the box: a width and a place, each null for "never moved". */
export type FloatingPlayerChoice = {
  width: number | null;
  position: FloatingPlayerPosition | null;
};

/**
 * The box's size and place, and the two gestures that change them.
 *
 * The container is the box's parent (the chat column), measured and watched.
 * `initial` seeds a player whose choice outlives it; `onCommit` hears the
 * choice once a drag or resize ends, never per pointer move.
 */
export function useFloatingPlayerFrame(args: {
  source: FloatingPlayerSize;
  initial?: FloatingPlayerChoice | null;
  onCommit?: (choice: FloatingPlayerChoice) => void;
}): {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  frame: FloatingPlayerFrame;
  startDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  startResize: (event: ReactPointerEvent<HTMLElement>, direction: FloatingPlayerResizeDirection) => void;
} {
  const { source } = args;
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * The teardown for an in-flight drag/resize. A gesture that outlives the
   * player (device stops, handover, close) would otherwise keep calling
   * `setPosition`/`setWidth` on an unmounted component against a stale box.
   */
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  /**
   * Viewport pixels per CSS pixel of the column. The hosted web client zooms
   * `<body>` with CSS `zoom`, so the pointer moves in one unit and `left`/`top`
   * are written in another; without this a drag ran ahead of the pointer and a
   * fresh player opened past the column's right edge.
   */
  const scaleRef = useRef(1);
  const [width, setWidth] = useState<number | null>(() => args.initial?.width ?? null);
  const [position, setPosition] = useState<FloatingPlayerPosition | null>(() => args.initial?.position ?? null);
  /** The choice as of the last pointer move, for `onCommit` at the end. */
  const choiceRef = useRef<FloatingPlayerChoice>({ width, position });
  choiceRef.current = { width, position };
  const onCommitRef = useRef(args.onCommit);
  onCommitRef.current = args.onCommit;

  useEffect(() => {
    const node = hostRef.current?.parentElement;
    if (!node) return undefined;
    const read = () => {
      // `clientWidth` is in the column's own CSS pixels, which is what the
      // box's `left`/`top` are written in; the rect is in viewport pixels.
      const rect = node.getBoundingClientRect();
      const width = node.clientWidth || rect.width;
      const height = node.clientHeight || rect.height;
      scaleRef.current = width > 0 && rect.width > 0 ? rect.width / width : 1;
      setContainer({ width, height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A drag or resize still held when the player unmounts must not outlive it.
  useEffect(() => () => {
    gestureCleanupRef.current?.();
    gestureCleanupRef.current = null;
  }, []);

  // An unmeasured column (not laid out yet) stands in as a common one, for the
  // frame and for the gestures alike, so a drag clamps to the box it sees.
  const box = container.width > 0 ? container : FALLBACK_CONTAINER;
  const frame = resolveFloatingPlayerFrame({ width, position, source, container: box });

  /** Listens on the window until the pointer comes up, then reports the choice. */
  const track = useCallback((move: (event: PointerEvent) => void) => {
    let moved = false;
    const onMove = (event: PointerEvent) => {
      moved = true;
      move(event);
    };
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      if (gestureCleanupRef.current === up) gestureCleanupRef.current = null;
      if (moved) onCommitRef.current?.(choiceRef.current);
    };
    gestureCleanupRef.current = up;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
  }, []);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    const start = { x: frame.x, y: frame.y };
    const size = { width: frame.width, height: frame.height };
    const scale = scaleRef.current;
    track((moveEvent) => {
      const next = clampFloatingPlayerPosition(
        { x: start.x + (moveEvent.clientX - origin.x) / scale, y: start.y + (moveEvent.clientY - origin.y) / scale },
        box,
        size,
      );
      choiceRef.current = { ...choiceRef.current, position: next };
      setPosition(next);
    });
  }, [box, frame.height, frame.width, frame.x, frame.y, track]);

  const startResize = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    direction: FloatingPlayerResizeDirection,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    const start: FloatingPlayerFrame = { ...frame };
    const scale = scaleRef.current;
    track((moveEvent) => {
      const next = resizeFloatingPlayer({
        start,
        direction,
        delta: { x: (moveEvent.clientX - origin.x) / scale, y: (moveEvent.clientY - origin.y) / scale },
        source,
        container: box,
      });
      choiceRef.current = { width: next.width, position: { x: next.x, y: next.y } };
      setWidth(next.width);
      setPosition({ x: next.x, y: next.y });
    });
  }, [box, frame, source, track]);

  return { hostRef, frame, startDrag, startResize };
}

/**
 * A canvas in its own OS picture-in-picture window.
 *
 * `getCanvas` names the decoder's canvas at the moment the user asks. The
 * window's own close button and its "back to tab" button both end the session
 * here, and so does `stop`.
 */
export function useCanvasPictureInPicture(getCanvas: () => HTMLCanvasElement | null | undefined): {
  active: boolean;
  enter: () => Promise<void>;
  stop: () => void;
} {
  const pipRef = useRef<WorkLivePipSession | null>(null);
  const [active, setActive] = useState(false);
  const getCanvasRef = useRef(getCanvas);
  getCanvasRef.current = getCanvas;

  const stop = useCallback(() => {
    pipRef.current?.stop();
    pipRef.current = null;
    setActive(false);
  }, []);

  const enter = useCallback(async () => {
    const canvas = getCanvasRef.current();
    if (!canvas) return;
    try {
      const session = await enterCanvasPictureInPicture(canvas);
      // The canvas went away while the window opened (the surface changed, or
      // the player went): the window would get no frames.
      if (!canvas.isConnected) {
        session.stop();
        return;
      }
      pipRef.current?.stop();
      pipRef.current = session;
      setActive(true);
      session.video.addEventListener("leavepictureinpicture", () => {
        session.stop();
        if (pipRef.current === session) pipRef.current = null;
        setActive(false);
      }, { once: true });
    } catch {
      stop();
    }
  }, [stop]);

  useEffect(() => () => {
    pipRef.current?.stop();
    pipRef.current = null;
  }, []);

  return { active, enter, stop };
}

const BAR_TEXT_BUTTON =
  "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.07] hover:text-fg";

export function FloatingPlayerShell({
  hostRef,
  frame,
  hidden,
  concealed,
  attrPrefix,
  playerId,
  ariaLabel,
  recording,
  onStartDrag,
  onStartResize,
  onOpenInPane,
  onClose,
  pip,
  barLeading = null,
  children,
}: {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  frame: FloatingPlayerFrame;
  /** Out of view and holding nothing: another surface is in front. */
  hidden: boolean;
  /** Playing in a PiP window: laid out and composited, but not seen. */
  concealed: boolean;
  /** Names every `data-*` hook, e.g. `apple-mini` → `data-apple-mini-dot`. */
  attrPrefix: string;
  /** The value of `data-<prefix>-player`. */
  playerId: string;
  ariaLabel: string;
  recording: boolean;
  onStartDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  onStartResize: (event: ReactPointerEvent<HTMLElement>, direction: FloatingPlayerResizeDirection) => void;
  onOpenInPane: () => void;
  onClose: () => void;
  pip: {
    supported: boolean;
    /** A frame has been drawn, so the window will open at the picture's shape. */
    ready: boolean;
    onToggle: () => void;
  };
  /** Extra facts at the start of the hover bar (who drives the picture). */
  barLeading?: ReactNode;
  /** The picture, and anything drawn over it. The shell's chrome sits above. */
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  // A hidden or concealed box never sees the pointer leave it, so the hover
  // bar would still be open when it comes back.
  useEffect(() => {
    if (!hidden && !concealed) return;
    setHovered(false);
  }, [concealed, hidden]);

  const data = (name: string) => `data-${attrPrefix}-${name}`;

  return (
    <div
      ref={hostRef}
      hidden={hidden}
      {...{ [data("player")]: playerId, [data("pip")]: concealed ? "" : undefined }}
      aria-hidden={concealed || undefined}
      role="group"
      aria-label={ariaLabel}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false);
      }}
      className="absolute z-40 overflow-hidden rounded-xl bg-surface shadow-2xl ring-1 ring-inset ring-border"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderRadius: FLOATING_PLAYER_CORNER_RADIUS,
        ...(concealed ? PIP_CONCEALED_STYLE : null),
      }}
    >
      {children}

      {/*
        Moving the box lives on one invisible strip under the top edge (inside
        the north resize zone). A picture that takes input must not also grab
        the player; one that does not may add its own drag surface.
      */}
      <div
        {...{ [data("drag")]: "" }}
        aria-hidden="true"
        className="absolute left-2 right-2 top-2 z-[2] h-4 cursor-grab active:cursor-grabbing"
        onPointerDown={onStartDrag}
      />

      {RESIZE_ZONES.map((zone) => (
        <div
          key={zone.direction}
          {...{ [data("resize")]: zone.direction }}
          className={cn("absolute z-[2]", zone.className)}
          onPointerDown={(event) => onStartResize(event, zone.direction)}
        />
      ))}

      <div className="absolute right-2 top-2 z-[3]">
        {hovered ? (
          /* `shrink-0` + `nowrap` on every child: at the 240px minimum the bar
             is nearly as wide as the player, and flex was shrinking the two
             word buttons until "Close" sat on top of the picture-in-picture
             glyph. The bar may reach the player's edges; it may not overlap
             itself. */
          <div className="flex max-w-full items-center gap-1 overflow-hidden rounded-full border border-border bg-surface px-1 py-0.5 shadow-lg">
            {barLeading}
            <button type="button" className={BAR_TEXT_BUTTON} onClick={onOpenInPane}>
              Open in pane
            </button>
            <PaneTooltip
              label={!pip.supported
                ? WORK_LIVE_PIP_UNSUPPORTED_LABEL
                : pip.ready
                  ? "Picture in picture"
                  : "Waiting for the first frame"}
            >
              <button
                type="button"
                aria-label="Picture in picture"
                disabled={!pip.supported || !pip.ready}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-fg hover:bg-white/[0.07] hover:text-fg disabled:opacity-40"
                onClick={pip.onToggle}
              >
                <PictureInPicture size={12} />
              </button>
            </PaneTooltip>
            <button type="button" className={BAR_TEXT_BUTTON} onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <span
            aria-hidden="true"
            {...{ [data("dot")]: recording ? "recording" : "idle" }}
            className={cn(
              "block h-2 w-2 rounded-full",
              recording ? "bg-[var(--color-error)] motion-safe:animate-pulse" : "bg-fg/45",
            )}
          />
        )}
      </div>
    </div>
  );
}
