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
  closeAppleMiniPlayer,
  useAppleMiniPlayerTarget,
  type AppleMiniPlayerTarget,
} from "./appleMiniPlayerStore";
import {
  enterCanvasPictureInPicture,
  isWorkLivePictureInPictureSupported,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
  type WorkLivePipSession,
} from "../work/workLiveIosPictureInPicture";
import type { AppleDeviceInput } from "./AppleDeviceFlatView";
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
 * The device, floating over the chat.
 *
 * This replaces the auto-appearing corner card, which showed up uninvited and
 * whose only controls were a dismiss X and a Float chip. A player you asked
 * for can be silent: an 8px dot is its entire chrome until you touch it, and
 * the picture underneath stays live and interactive the whole time.
 */
export function AppleDeviceMiniPlayer({
  onOpenInPane,
  recording = false,
}: {
  /** Brings the device back into the Apple pane. */
  onOpenInPane: (target: AppleMiniPlayerTarget) => void;
  recording?: boolean;
}) {
  const target = useAppleMiniPlayerTarget();
  if (!target) return null;
  return (
    <AppleMiniPlayerFrameView
      key={target.deviceUdid}
      target={target}
      recording={recording}
      onOpenInPane={onOpenInPane}
    />
  );
}

function AppleMiniPlayerFrameView({
  target,
  recording,
  onOpenInPane,
}: {
  target: AppleMiniPlayerTarget;
  recording: boolean;
  onOpenInPane: (target: AppleMiniPlayerTarget) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pipRef = useRef<WorkLivePipSession | null>(null);
  const pinRef = useRef(target.runtimePin);
  pinRef.current = target.runtimePin;

  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [width, setWidth] = useState<number | null>(null);
  const [position, setPosition] = useState<AppleMiniPlayerPosition | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);

  const noop = useCallback(() => {}, []);
  const stream = useAppleDeviceStream({
    deviceUdid: target.deviceUdid,
    laneId: target.laneId,
    chatSessionId: target.chatSessionId,
    enabled: true,
    hidden: false,
    machineName: null,
    bitrateKbpsCap: null,
    runtimePinRef: pinRef,
    onError: noop,
  });

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
    };
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
    };
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
      pipRef.current?.stop();
      pipRef.current = session;
      setPipActive(true);
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

  const handleDimensions = useCallback((size: { width: number; height: number }) => {
    setScreen((value) => (
      value && value.width === size.width && value.height === size.height ? value : size
    ));
    stream.handleDimensions(size);
    // `stream` is a fresh object each render; the handler it carries is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.handleDimensions]);

  const sendInput = useCallback((input: AppleDeviceInput) => {
    if (input.phase !== "end") return;
    void window.ade.iosSimulator
      .tap(
        { deviceUdid: target.deviceUdid, x: Math.round(input.x), y: Math.round(input.y) },
        pinRef.current,
      )
      .catch(() => {});
  }, [target.deviceUdid]);

  const pipSupported = isWorkLivePictureInPictureSupported();

  return (
    <div
      ref={hostRef}
      data-apple-mini-player={target.deviceUdid}
      role="group"
      aria-label={`${target.deviceName}, floating`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="absolute z-40 overflow-hidden bg-muted shadow-2xl ring-1 ring-inset ring-white/10"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderRadius: APPLE_MINI_PLAYER_CORNER_RADIUS,
      }}
    >
      <div ref={canvasHostRef} className="absolute inset-0" onPointerDown={startDrag}>
        <AppleDeviceStage
          streamUrl={stream.url}
          streamToken={stream.token}
          reconnectNonce={stream.reconnectNonce}
          mode="flat"
          viewNonce={0}
          family={target.family}
          deviceTypeName={target.deviceName}
          realistic={false}
          orientation="portrait"
          devicePointSize={null}
          interactive
          onDeviceInput={sendInput}
          onReaderStatus={stream.handleReaderStatus}
          onDimensions={handleDimensions}
          onFrame={stream.noteFrame}
          frameVersion={stream.frameVersion}
        />
      </div>

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
          <div className="flex items-center gap-1 rounded-full border border-border bg-bg/95 px-1 py-0.5 shadow-lg backdrop-blur-md">
            <button
              type="button"
              className="rounded-full px-2 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.08] hover:text-fg"
              onClick={() => {
                stopPip();
                closeAppleMiniPlayer(target.deviceUdid);
                onOpenInPane(target);
              }}
            >
              Open in pane
            </button>
            <PaneTooltip label={pipSupported ? "Picture in picture" : WORK_LIVE_PIP_UNSUPPORTED_LABEL}>
              <button
                type="button"
                aria-label="Picture in picture"
                disabled={!pipSupported}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-fg hover:bg-white/[0.08] hover:text-fg disabled:opacity-40"
                onClick={() => (pipActive ? stopPip() : void enterPip())}
              >
                <PictureInPicture size={12} />
              </button>
            </PaneTooltip>
            <button
              type="button"
              className="rounded-full px-2 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.08] hover:text-fg"
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
              recording ? "bg-[var(--color-error)] motion-safe:animate-pulse" : "bg-white/45",
            )}
          />
        )}
      </div>
    </div>
  );
}
