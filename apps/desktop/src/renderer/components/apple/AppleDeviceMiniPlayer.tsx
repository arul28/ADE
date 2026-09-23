import { useCallback, useEffect, useRef, useState } from "react";
import { PictureInPicture } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { AppleDeviceStage } from "./AppleDeviceStage";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import {
  APPLE_MINI_PLAYER_CORNER_RADIUS,
  appleMiniPlayerSourceSize,
  clampAppleMiniPlayerPosition,
  resizeAppleMiniPlayer,
  resolveAppleMiniPlayerFrame,
  type AppleMiniPlayerFrame,
  type AppleMiniPlayerPosition,
  type AppleMiniPlayerResizeDirection,
} from "./appleMiniPlayerLayout";
import {
  appleMiniPlayerBelongsToSurface,
  closeAppleMiniPlayer,
  releaseAppleMiniPlayerHandoverHold,
  retakeAppleMiniPlayer,
  takeAppleMiniPlayerPoster,
  useAppleMiniPlayerTarget,
  type AppleMiniPlayerSurface,
  type AppleMiniPlayerTarget,
} from "./appleMiniPlayerStore";
import {
  enterCanvasPictureInPicture,
  isWorkLivePictureInPictureSupported,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
  type WorkLivePipSession,
} from "../work/workLiveIosPictureInPicture";
import { useAppleDeviceInput } from "./useAppleDeviceInput";
import { PaneTooltip } from "../ui/PaneTooltip";

const RESIZE_ZONES: { direction: AppleMiniPlayerResizeDirection; className: string }[] = [
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
 * How the box goes away while the device plays in a PiP window.
 *
 * Not `hidden` and not `opacity: 0`. The PiP window captures this box's
 * canvas, and the stage has already learned (see `PARKED_CANVAS_STYLE` in
 * `AppleDeviceStage`) that a canvas the compositor treats as not visible can
 * hand a GPU reader a black surface. So the box keeps its place and size and
 * stays composited at an opacity no eye can see, and takes no pointer input.
 */
const PIP_CONCEALED_STYLE = {
  opacity: 0.002,
  pointerEvents: "none" as const,
};

/**
 * The device, floating over the chat.
 *
 * This replaces the auto-appearing corner card, which showed up uninvited and
 * whose only controls were a dismiss X and a Float chip. A player you asked
 * for can be silent: an 8px dot is its entire chrome until you touch it, and
 * the picture underneath stays live and interactive the whole time.
 */
export function AppleDeviceMiniPlayer({
  onOpenInPane,
  surface,
  recording = false,
}: {
  /** Brings the device back into the Apple pane. */
  onOpenInPane: (target: AppleMiniPlayerTarget) => void;
  /**
   * The Work surface in front, or null on the new-chat screen. Required, not
   * optional: a mount that forgot it would float the device over every
   * surface again, which is the bug this exists to prevent.
   */
  surface: AppleMiniPlayerSurface | null;
  recording?: boolean;
}) {
  const target = useAppleMiniPlayerTarget();
  if (!target) return null;
  return (
    <AppleMiniPlayerFrameView
      key={target.deviceUdid}
      target={target}
      visible={appleMiniPlayerBelongsToSurface(target, surface)}
      recording={recording}
      onOpenInPane={onOpenInPane}
    />
  );
}

function AppleMiniPlayerFrameView({
  target,
  visible,
  recording,
  onOpenInPane,
}: {
  target: AppleMiniPlayerTarget;
  /**
   * False while the surface in front is another lane's, another machine's, or
   * the new-chat screen (the owner's 2026-09-23 report: a lane's simulator
   * floated over a new chat). Hidden, NOT closed: the target stays in the
   * store, so going back to a surface of the device's lane brings the player
   * back where it was, at the size it was. Staying mounted is what keeps the
   * position and width; the stream is what must not stay, and `hidden` below
   * gives this viewer's lease back exactly as an unmount would.
   *
   * Picture in picture overrides this. The PiP window is how you watch the
   * device from somewhere else, so it keeps the stream while another surface
   * is in front. The rule applies again once PiP closes.
   */
  visible: boolean;
  recording: boolean;
  onOpenInPane: (target: AppleMiniPlayerTarget) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pipRef = useRef<WorkLivePipSession | null>(null);
  const pinRef = useRef(target.runtimePin);
  /**
   * The teardown for an in-flight drag/resize. A gesture that outlives the
   * player (device stops, handover, close) would otherwise keep calling
   * `setPosition`/`setWidth` on an unmounted component against a stale box.
   */
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  pinRef.current = target.runtimePin;

  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [width, setWidth] = useState<number | null>(null);
  const [position, setPosition] = useState<AppleMiniPlayerPosition | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);
  /**
   * The pane's last frame, claimed once at mount (round 4 §B4).
   *
   * Read in the initializer so it is on screen in the FIRST paint of the
   * player: the picture does not fade in from black, it is already the picture
   * the pane was showing, and the live decoder takes over behind it a frame or
   * two later. Claimed destructively, so a later open with no handover behind
   * it gets nothing rather than a photograph of an old session.
   */
  const [poster, setPoster] = useState<string | null>(() => takeAppleMiniPlayerPoster(target.deviceUdid));
  /*
   * The owner's 2026-09-23 ask: while the device is in a PiP window, the box
   * inside ADE goes away, and it comes back when PiP closes.
   *
   * The PiP window is fed from this box's own canvas, so "away" cannot mean
   * `hidden`: that drops the lease, and the stage unmounts the decoder when
   * the URL goes, which freezes the PiP window. So the box stays mounted,
   * laid out and streaming, and is only concealed (see `PIP_CONCEALED_STYLE`).
   */
  const streaming = visible || pipActive;

  const noop = useCallback(() => {}, []);
  const stream = useAppleDeviceStream({
    deviceUdid: target.deviceUdid,
    laneId: target.laneId,
    chatSessionId: target.chatSessionId,
    enabled: true,
    // Hidden releases this viewer's lease (and stops the capture when it was
    // the last one), so a player nobody can see is not encoding H.264. A PiP
    // window is somebody seeing it.
    hidden: !streaming,
    machineName: null,
    bitrateKbpsCap: null,
    runtimePinRef: pinRef,
    onError: noop,
  });

  /*
   * Hand the HANDOVER's lease back, now that this player holds one of its own.
   *
   * Declared after `useAppleDeviceStream` on purpose: effects run in the order
   * their hooks were called, so the stream's start effect — which is where the
   * lease is acquired — has already run by the time this one does. Releasing
   * first would drop the count to zero between the two and stop the capture,
   * which is exactly the tear-down this whole mechanism exists to avoid.
   *
   * Only while streaming: a hidden player holds no lease of its own, and this
   * release never stops a capture, so giving the hold back here would leave
   * the helper encoding for nobody. Left alone, the hold's own expiry stops it
   * — or, if the user comes back within the window, this runs then instead.
   */
  useEffect(() => {
    if (streaming) releaseAppleMiniPlayerHandoverHold();
  }, [streaming]);

  // The poster is a stand-in for frames, so the first real frame retires it.
  useEffect(() => {
    if (stream.frameVersion > 0) setPoster(null);
  }, [stream.frameVersion]);

  useEffect(() => {
    const node = hostRef.current?.parentElement;
    if (!node) return undefined;
    const read = () => {
      const rect = node.getBoundingClientRect();
      setContainer({ width: rect.width, height: rect.height });
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

  const source = appleMiniPlayerSourceSize(screen);
  const frame = resolveAppleMiniPlayerFrame({
    width,
    position,
    source,
    container: container.width > 0 ? container : { width: 960, height: 640 },
  });

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    const start = { x: frame.x, y: frame.y };
    const size = { width: frame.width, height: frame.height };
    const box = container;
    const move = (moveEvent: PointerEvent) => {
      setPosition(clampAppleMiniPlayerPosition(
        { x: start.x + moveEvent.clientX - origin.x, y: start.y + moveEvent.clientY - origin.y },
        box,
        size,
      ));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (gestureCleanupRef.current === up) gestureCleanupRef.current = null;
    };
    gestureCleanupRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [container, frame.height, frame.width, frame.x, frame.y]);

  const startResize = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    direction: AppleMiniPlayerResizeDirection,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    const start: AppleMiniPlayerFrame = { ...frame };
    const box = container;
    const move = (moveEvent: PointerEvent) => {
      const next = resizeAppleMiniPlayer({
        start,
        direction,
        delta: { x: moveEvent.clientX - origin.x, y: moveEvent.clientY - origin.y },
        source,
        container: box,
      });
      setWidth(next.width);
      setPosition({ x: next.x, y: next.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (gestureCleanupRef.current === up) gestureCleanupRef.current = null;
    };
    gestureCleanupRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [container, frame, source]);

  const stopPip = useCallback(() => {
    pipRef.current?.stop();
    pipRef.current = null;
    setPipActive(false);
  }, []);

  const enterPip = useCallback(async () => {
    const canvas = canvasHostRef.current?.querySelector("canvas");
    if (!canvas) return;
    try {
      const session = await enterCanvasPictureInPicture(canvas);
      // The stage dropped this canvas while the window opened (the surface
      // changed, or the player went): the window would get no frames.
      if (!canvas.isConnected) {
        session.stop();
        return;
      }
      pipRef.current?.stop();
      pipRef.current = session;
      setPipActive(true);
      // The PiP window's close button and its "back to tab" button both end
      // here, and so does `stopPip`'s exit. Clearing `pipActive` shows the box.
      session.video.addEventListener("leavepictureinpicture", () => {
        session.stop();
        if (pipRef.current === session) pipRef.current = null;
        setPipActive(false);
      }, { once: true });
    } catch {
      stopPip();
    }
  }, [stopPip]);

  useEffect(() => () => {
    pipRef.current?.stop();
    pipRef.current = null;
  }, []);

  // A hidden or concealed box never sees the pointer leave it, so the hover
  // bar would still be open when it comes back. Hiding no longer ends PiP:
  // PiP keeps the stream (see `streaming`).
  useEffect(() => {
    if (visible && !pipActive) return;
    setHovered(false);
  }, [pipActive, visible]);

  // The device stopped or its stream ended. This player never redials, so the
  // PiP window would sit on the last frame with the box still concealed. End
  // PiP, which shows the box again (or leaves it hidden on another surface).
  useEffect(() => {
    if (!pipActive) return;
    if (stream.state === "idle" || stream.state === "error") stopPip();
  }, [pipActive, stopPip, stream.state]);

  const handleDimensions = useCallback((size: { width: number; height: number }) => {
    setScreen((value) => (
      value && value.width === size.width && value.height === size.height ? value : size
    ));
    stream.handleDimensions(size);
    // `stream` is a fresh object each render; the handler it carries is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.handleDimensions]);

  /**
   * The floating player drives the device exactly as the pane does.
   *
   * Same hook, same gesture recognition, same one-action-per-gesture rule —
   * "taps and keys pass through exactly as in the pane" is a contract, and the
   * way to keep it is to share the implementation rather than to write a
   * second tap sender that drifts.
   */
  const input = useAppleDeviceInput({
    deviceUdid: target.deviceUdid,
    laneId: target.laneId,
    chatSessionId: target.chatSessionId,
    enabled: stream.state === "live",
    runtimePinRef: pinRef,
  });

  const pipSupported = isWorkLivePictureInPictureSupported();
  /*
   * Picture-in-picture needs a canvas that has actually drawn something.
   *
   * A decoder canvas is 300×150 until its first frame sizes it — an untouched
   * HTML default that is opaque black under `alpha: false`, and LANDSCAPE.
   * `enterCanvasPictureInPicture` goes through `captureStream()` into a video
   * element, and the PiP window takes its shape from the first frame it is
   * given, so entering early hands the user a small black landscape window for
   * a portrait phone and does not reshape itself when real frames arrive.
   *
   * `frameVersion` counts decoded frames, so it is the same "has anything been
   * drawn" question the handover poster asks, answered from the stream rather
   * than by measuring the canvas.
   */
  const hasPicture = stream.frameVersion > 0;

  return (
    <div
      ref={hostRef}
      hidden={!streaming}
      data-apple-mini-player={target.deviceUdid}
      data-apple-mini-pip={pipActive ? "" : undefined}
      aria-hidden={pipActive || undefined}
      role="group"
      aria-label={`${target.deviceName}, floating`}
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
        borderRadius: APPLE_MINI_PLAYER_CORNER_RADIUS,
        ...(pipActive ? PIP_CONCEALED_STYLE : null),
      }}
    >
      {/*
        The picture is for driving the device, not for moving the window. Round
        2 put the drag handler on the whole canvas, so every tap grabbed the
        player instead of reaching the simulator — which is most of why the
        floating view read as dead. Moving it lives on one invisible strip
        under the top edge (inside the north resize zone) and on the chrome bar.
      */}
      {poster ? (
        /* Under the stage and inert: the stage's flat presenter draws the
           decoded canvas `object-contain` with no bezel of its own, so the same
           rule on the same box puts this frame exactly where the live one
           lands — no jump when the decoder catches up. */
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          data-apple-mini-poster=""
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
      <div ref={canvasHostRef} className="absolute inset-0">
        <AppleDeviceStage
          /*
           * `h-full` is what makes the floating player show a PICTURE.
           *
           * The stage's own box is `flex-1`, which is a height in the pane's
           * flex column and nothing at all here: every child of the stage is
           * absolutely positioned, so as a plain block inside `absolute
           * inset-0` it laid out 0px tall. The flat view then measured a
           * zero-height container, `measureAppleScreenBox` answered null, and
           * the stage parked the decoder off-screen — the empty frame A5
           * describes. The stream, the lease and the decoder were all fine;
           * only the box was missing.
           */
          className="h-full w-full"
          streamUrl={stream.url}
          streamToken={stream.token}
          reconnectNonce={stream.reconnectNonce}
          mode="flat"
          viewNonce={0}
          family={target.family}
          deviceTypeName={target.deviceName}
          orientation="portrait"
          devicePointSize={stream.devicePointSize}
          // Concealed, the screen must not take focus or keys you cannot see.
          interactive={!pipActive}
          onDeviceInput={input.send}
          onDeviceScroll={input.scroll}
          onDeviceKey={input.key}
          onReaderStatus={stream.handleReaderStatus}
          onDimensions={handleDimensions}
          onFrame={stream.noteFrame}
          frameVersion={stream.frameVersion}
        />
      </div>

      <div
        data-apple-mini-drag=""
        aria-hidden="true"
        className="absolute left-2 right-2 top-2 z-[2] h-4 cursor-grab active:cursor-grabbing"
        onPointerDown={startDrag}
      />

      {RESIZE_ZONES.map((zone) => (
        <div
          key={zone.direction}
          data-apple-mini-resize={zone.direction}
          className={cn("absolute z-[2]", zone.className)}
          onPointerDown={(event) => startResize(event, zone.direction)}
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
            <button
              type="button"
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.07] hover:text-fg"
              onClick={() => {
                stopPip();
                // The device is moving back into the pane, not being refused:
                // a dismissal here would stop A4 from ever floating it again.
                retakeAppleMiniPlayer(target.deviceUdid);
                onOpenInPane(target);
              }}
            >
              Open in pane
            </button>
            <PaneTooltip
              label={!pipSupported
                ? WORK_LIVE_PIP_UNSUPPORTED_LABEL
                : hasPicture
                  ? "Picture in picture"
                  : "Waiting for the first frame"}
            >
              <button
                type="button"
                aria-label="Picture in picture"
                disabled={!pipSupported || !hasPicture}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-fg hover:bg-white/[0.07] hover:text-fg disabled:opacity-40"
                onClick={() => (pipActive ? stopPip() : void enterPip())}
              >
                <PictureInPicture size={12} />
              </button>
            </PaneTooltip>
            <button
              type="button"
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.07] hover:text-fg"
              onClick={() => {
                stopPip();
                closeAppleMiniPlayer(target.deviceUdid);
              }}
            >
              Close
            </button>
          </div>
        ) : (
          <span
            aria-hidden="true"
            data-apple-mini-dot={recording ? "recording" : "idle"}
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
