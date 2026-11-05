import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workToolDefinition } from "../terminals/workTools";
import {
  FloatingPlayerShell,
  useCanvasPictureInPicture,
  useFloatingPlayerCapture,
  useFloatingPlayerFrame,
} from "../shared/FloatingPlayer";
import { floatingPlayerSourceSize } from "../shared/floatingPlayerLayout";
import { isWorkLivePictureInPictureSupported } from "../work/workLiveIosPictureInPicture";
import { Banner } from "../ui/notice";
import type { AppleMiniPlayerSurface } from "../apple/appleMiniPlayerStore";
import { AndroidDeviceStage } from "./AndroidDeviceStage";
import { androidDevicePixelSize, describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";
import {
  androidMiniPlayerBelongsToSurface,
  closeAndroidMiniPlayer,
  retakeAndroidMiniPlayer,
  useAndroidMiniPlayerTarget,
  type AndroidMiniPlayerTarget,
} from "./androidMiniPlayerStore";
import { useAndroidDeviceInput } from "./useAndroidDeviceInput";
import { useAndroidDeviceStream } from "./useAndroidDeviceStream";
import { useAndroidRecording } from "./useAndroidRecording";

/**
 * The lane's Android emulator, floating over the chat: the Android slot of
 * the floating players, beside the Apple device's (`AppleDeviceMiniPlayer`).
 * Both can float at once; the shared slots keep them from covering each
 * other.
 *
 * The same shell, the same rules: an 8px dot until you touch it, the picture
 * live and interactive the whole time, hidden (not closed) over another
 * lane's surface, and kept streaming while a picture-in-picture window shows
 * it.
 */
const FLOATING_ICON = (() => {
  const definition = workToolDefinition("android");
  return definition ? { Icon: definition.icon, color: definition.color } : null;
})();

/** The usual phone shape, until the first frame reports a size. */
const PHONE_FALLBACK = { width: 1_000, height: 1_000 / (9 / 20) };

export function AndroidDeviceMiniPlayer({
  onOpenInPane,
  surface,
}: {
  /** Brings the emulator back into the Android pane. */
  onOpenInPane: (target: AndroidMiniPlayerTarget) => void;
  /** The Work surface in front, or null on the new-chat screen. */
  surface: AppleMiniPlayerSurface | null;
}) {
  const target = useAndroidMiniPlayerTarget();
  if (!target) return null;
  return (
    <AndroidMiniPlayerFrameView
      key={`${target.runtimePin?.key ?? "bound"}:${target.laneId}:${target.avdName}`}
      target={target}
      visible={androidMiniPlayerBelongsToSurface(target, surface)}
      onOpenInPane={onOpenInPane}
    />
  );
}

function AndroidMiniPlayerFrameView({
  target,
  visible,
  onOpenInPane,
}: {
  target: AndroidMiniPlayerTarget;
  visible: boolean;
  onOpenInPane: (target: AndroidMiniPlayerTarget) => void;
}) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(target.runtimePin);
  pinRef.current = target.runtimePin;
  const pip = useCanvasPictureInPicture(() => canvasHostRef.current?.querySelector("canvas"));
  const pipActive = pip.active;
  const stopPip = pip.stop;
  const streaming = visible || pipActive;

  const [streamError, setStreamError] = useState<string | null>(null);
  const onStreamError = useCallback((message: string | null) => setStreamError(message), []);
  const stream = useAndroidDeviceStream({
    laneId: target.laneId,
    avdName: target.avdName,
    enabled: true,
    // A player nobody can see gives its lease back, so the emulator does not
    // encode for no one. A picture-in-picture window is someone seeing it.
    hidden: !streaming,
    runtimePinRef: pinRef,
    onError: onStreamError,
  });
  const live = stream.state === "live";

  const noteError = useCallback((cause: unknown) => setStreamError(describeAndroidError(cause).sentence), []);
  const input = useAndroidDeviceInput({
    laneId: target.laneId,
    enabled: live && !pipActive,
    runtimePinRef: pinRef,
    onError: noteError,
  });

  // The lane gave the emulator up (released, deleted): nothing left to show.
  useEffect(() => {
    const unsubscribe = window.ade?.androidEmulator?.onEvent?.((event) => {
      if (event.type !== "android.device.state" || event.laneId !== target.laneId) return;
      if (event.state === "none") closeAndroidMiniPlayer(target.avdName);
    }, pinRef.current);
    return () => unsubscribe?.();
  }, [target.avdName, target.laneId, target.runtimePin?.key]);

  const devicePixelSize = useMemo(
    () => androidDevicePixelSize(
      { lcdWidth: target.lcdWidth ?? 0, lcdHeight: target.lcdHeight ?? 0 },
      { width: stream.width, height: stream.height },
    ),
    [stream.height, stream.width, target.lcdHeight, target.lcdWidth],
  );
  const source = floatingPlayerSourceSize(
    stream.width && stream.height ? { width: stream.width, height: stream.height } : null,
    PHONE_FALLBACK,
  );
  const { hostRef, frame, startDrag, startResize } = useFloatingPlayerFrame({
    source,
    slot: { id: `android:${target.laneId}`, shown: streaming && !pipActive },
  });

  useEffect(() => {
    if (!pipActive) return;
    if (stream.state === "error" || stream.gaveUp) stopPip();
  }, [pipActive, stopPip, stream.gaveUp, stream.state]);

  // Watching never boots: an emulator that is off says so, with the pane's Start.
  const deviceOff = stream.state === "error" && describeAndroidError(streamError).code === "ANDROID_NOT_RUNNING";
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<AndroidErrorDescription | null>(null);
  // The RAM guard refused the start: the next press starts it anyway.
  const lowMemory = startError?.code === "ANDROID_LOW_MEMORY";
  const reconnect = stream.reconnect;
  const startDevice = useCallback(() => {
    const api = window.ade?.androidEmulator;
    if (!api?.start) return;
    setStarting(true);
    setStartError(null);
    void api.start({ laneId: target.laneId, ...(lowMemory ? { force: true } : {}) }, pinRef.current)
      .then(() => reconnect())
      .catch((cause: unknown) => setStartError(describeAndroidError(cause)))
      .finally(() => setStarting(false));
  }, [lowMemory, reconnect, target.laneId]);

  // The emulator's recording, with the pane's own pill and Stop, so an
  // agent's recording never runs behind a player with no way to end it.
  const recording = useAndroidRecording({
    laneId: target.laneId,
    live: streaming && live,
    chatSessionId: target.chatSessionId,
    runtimePinRef: pinRef,
    onError: noteError,
  });
  const capture = useFloatingPlayerCapture({
    startedAt: recording.active?.startedAt ?? null,
    makingDemo: false,
    stop: recording.active ? async () => recording.toggleRecording() : null,
  });

  return (
    <FloatingPlayerShell
      hostRef={hostRef}
      frame={frame}
      hidden={!streaming}
      icon={FLOATING_ICON}
      concealed={pipActive}
      attrPrefix="android-mini"
      playerId={target.laneId}
      ariaLabel={`${target.deviceName}, floating`}
      recording={Boolean(recording.active)}
      capture={capture}
      onStartDrag={startDrag}
      onStartResize={startResize}
      onOpenInPane={() => {
        stopPip();
        retakeAndroidMiniPlayer();
        onOpenInPane(target);
      }}
      onClose={() => {
        stopPip();
        closeAndroidMiniPlayer(target.avdName);
      }}
      pip={{
        supported: isWorkLivePictureInPictureSupported(),
        ready: live,
        onToggle: () => (pipActive ? stopPip() : void pip.enter()),
      }}
    >
      <div ref={canvasHostRef} className="absolute inset-0">
        <AndroidDeviceStage
          className="h-full w-full"
          streamUrl={stream.url}
          streamToken={stream.token}
          reconnectNonce={stream.reconnectNonce}
          devicePixelSize={devicePixelSize}
          mode="flat"
          // Concealed, the screen must not take focus or keys you cannot see.
          interactive={live && !pipActive}
          onDeviceInput={input.send}
          onDeviceScroll={input.scroll}
          onDeviceKey={input.key}
          onReaderStatus={stream.handleReaderStatus}
          onDimensions={stream.handleDimensions}
          onFrame={stream.noteFrame}
        />
      </div>
      {deviceOff ? (
        <div
          data-android-mini-off=""
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center"
        >
          <p className="font-sans text-[12px] text-fg/85">{target.deviceName} is off</p>
          <button
            type="button"
            disabled={starting}
            className="rounded-full border border-border px-3 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-fg/[0.07] hover:text-fg disabled:opacity-50"
            onClick={startDevice}
          >
            {starting ? "Starting…" : lowMemory ? "Start anyway" : "Start"}
          </button>
          {startError ? (
            <Banner
              layout="inline"
              model={{
                id: "android-device-mini-start-error",
                tone: lowMemory ? "warning" : "error",
                title: startError.sentence,
                report: lowMemory ? false : { surface: "android_device_mini_player_start" },
                dismiss: { onDismiss: () => setStartError(null) },
              }}
            />
          ) : null}
        </div>
      ) : null}
    </FloatingPlayerShell>
  );
}
