import { useCallback, useEffect, useRef, useState } from "react";
import { PictureInPicture, WarningCircle } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppleDeviceStream } from "../apple/useAppleDeviceStream";
import { IosSimH264Video } from "../chat/IosSimH264Video";
import { PaneTooltip } from "../ui/PaneTooltip";
import { cn } from "../ui/cn";
import {
  enterCanvasPictureInPicture,
  isWorkLivePictureInPictureSupported,
  workLiveIosStreamRequestUrl,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
  type WorkLivePipSession,
} from "./workLiveIosPictureInPicture";
import type { WorkLiveIosDevice } from "./workLiveCard";

/**
 * H.264 live view for one Apple-device corner card.
 *
 * Uses 3A's `useAppleDeviceStream` for the ticket and watchdogs, and the
 * shared H.264 canvas reader with `Authorization: bearer <token>`. The
 * stream runs only while this view is on screen (or in PiP); hiding it
 * pauses, showing it resumes. Reconnect is the same affordance every viewer
 * has.
 */

export function WorkLiveIosStreamView({
  device,
  runtimePin,
  onScreen,
  pipActive,
  onPipChange,
  pipRequestKey = 0,
}: {
  device: WorkLiveIosDevice;
  runtimePin: OpenProjectBinding | null;
  /** The card is laid out in the column. IntersectionObserver may still hide it. */
  onScreen: boolean;
  pipActive: boolean;
  onPipChange: (active: boolean) => void;
  /** Bumped by the Simulator-running pill's Float action. */
  pipRequestKey?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipRef = useRef<WorkLivePipSession | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const [intersecting, setIntersecting] = useState(true);
  const [pipSupported] = useState(() => isWorkLivePictureInPictureSupported());
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    const node = hostRef.current;
    if (!onScreen || !node || typeof IntersectionObserver === "undefined") {
      setIntersecting(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      setIntersecting(Boolean(entry?.isIntersecting));
    }, { threshold: 0.01 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onScreen]);

  const visible = intersecting || pipActive;
  const enabled = onScreen || pipActive;
  const hidden = enabled && !visible;

  const onError = useCallback((message: string | null) => {
    setStreamError(message);
  }, []);

  const stream = useAppleDeviceStream({
    deviceUdid: device.udid,
    laneId: device.laneId || null,
    chatSessionId: device.chatSessionId,
    enabled,
    hidden,
    machineName: null,
    bitrateKbpsCap: null,
    runtimePinRef: pinRef,
    onError,
  });

  const stopPip = useCallback(() => {
    pipRef.current?.stop();
    pipRef.current = null;
    onPipChange(false);
  }, [onPipChange]);

  const enterPip = useCallback(async () => {
    if (!pipSupported) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const session = await enterCanvasPictureInPicture(canvas);
      pipRef.current?.stop();
      pipRef.current = session;
      onPipChange(true);
      session.video.addEventListener("leavepictureinpicture", () => {
        session.stop();
        if (pipRef.current === session) pipRef.current = null;
        onPipChange(false);
      }, { once: true });
    } catch {
      stopPip();
    }
  }, [onPipChange, pipSupported, stopPip]);

  const pendingPipRef = useRef(false);
  useEffect(() => {
    if (pipRequestKey <= 0) return;
    pendingPipRef.current = true;
    if (canvasRef.current) {
      pendingPipRef.current = false;
      void enterPip();
    }
  }, [enterPip, pipRequestKey]);

  const handleCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas && pendingPipRef.current) {
      pendingPipRef.current = false;
      void enterPip();
    }
  }, [enterPip]);

  useEffect(() => () => {
    pipRef.current?.stop();
    pipRef.current = null;
  }, []);

  const stalled = stream.state === "stalled" || stream.state === "error";
  const paused = stream.state === "paused" && !pipActive;
  const readerUrl = stream.url ? workLiveIosStreamRequestUrl(stream.url) : null;

  return (
    <div ref={hostRef} className="absolute inset-0" data-work-live-ios-stream={device.udid}>
      {readerUrl && stream.token ? (
        <IosSimH264Video
          url={readerUrl}
          token={stream.token}
          reconnectNonce={stream.reconnectNonce}
          onStatus={stream.handleReaderStatus}
          onDimensions={stream.handleDimensions}
          onCanvas={handleCanvas}
          onFrame={stream.noteFrame}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="h-full w-full bg-black" />
      )}

      {paused ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 px-3 text-center text-[11px] text-fg/80">
          Paused — not visible
        </div>
      ) : null}

      {stalled ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-3 text-center">
          <WarningCircle size={16} className="text-amber-200" />
          <span className="text-[11px] text-fg/85">
            {stream.state === "error" ? (streamError ?? stream.error ?? "Stream stopped") : "No frames"}
          </span>
          <button
            type="button"
            data-live-card-inert=""
            onClick={(event) => {
              event.stopPropagation();
              stream.reconnect();
            }}
            className={cn(
              "rounded-[8px] border border-white/15 bg-white/[0.08] px-2 py-0.5",
              "text-[11px] font-medium text-fg hover:bg-white/[0.12]",
            )}
          >
            Reconnect
          </button>
        </div>
      ) : null}

      <PaneTooltip label={pipSupported ? "Float" : WORK_LIVE_PIP_UNSUPPORTED_LABEL}>
        <button
          type="button"
          data-live-card-inert=""
          data-live-card-float=""
          aria-label="Float"
          disabled={!pipSupported}
          onClick={(event) => {
            event.stopPropagation();
            if (pipActive) stopPip();
            else void enterPip();
          }}
          className={cn(
            "absolute bottom-2 right-2 z-[1] inline-flex h-7 items-center gap-1 rounded-[8px] px-1.5",
            "border border-[var(--chat-glass-border)] bg-[var(--chat-glass-bg)]",
            "backdrop-blur-[var(--blur-popup)] text-[10px] font-medium text-fg",
            "hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <PictureInPicture size={12} weight="bold" />
          Float
        </button>
      </PaneTooltip>
    </div>
  );
}
