import { useCallback, useEffect, useRef, useState } from "react";
import { AppleDeviceStage } from "./AppleDeviceStage";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import { appleMiniPlayerSourceSize } from "./appleMiniPlayerLayout";
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
import { isWorkLivePictureInPictureSupported } from "../work/workLiveIosPictureInPicture";
import {
  FloatingPlayerShell,
  useCanvasPictureInPicture,
  useFloatingPlayerFrame,
} from "../shared/FloatingPlayer";
import { useAppleDeviceInput } from "./useAppleDeviceInput";
import { describeAppleError, isAppleDeviceOffError } from "./appleErrors";

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
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(target.runtimePin);
  pinRef.current = target.runtimePin;

  const pip = useCanvasPictureInPicture(() => canvasHostRef.current?.querySelector("canvas"));
  const pipActive = pip.active;
  const stopPip = pip.stop;
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
   * laid out and streaming, and is only concealed (the shell's `concealed`).
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

  const source = appleMiniPlayerSourceSize(screen);
  const { hostRef, frame, startDrag, startResize } = useFloatingPlayerFrame({ source });

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

  /*
   * The device is off. Watching never boots a device (the service answers
   * `APPLE_DEVICE_OFF`), so without this the player sat on a generic error.
   * It says so and offers the pane's own Start; "Open in pane" stays on the
   * hover bar.
   */
  const deviceOff = stream.state === "error" && isAppleDeviceOffError(stream.error);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const reconnect = stream.reconnect;
  const startDevice = useCallback(() => {
    const api = window.ade?.iosSimulator;
    if (!api?.deviceStart || !target.laneId) return;
    setStarting(true);
    setStartError(null);
    void api.deviceStart(
      { laneId: target.laneId, chatSessionId: target.chatSessionId, udid: target.deviceUdid },
      pinRef.current,
    )
      .then(() => reconnect())
      .catch((cause: unknown) => setStartError(describeAppleError(cause).sentence))
      .finally(() => setStarting(false));
  }, [reconnect, target.chatSessionId, target.deviceUdid, target.laneId]);

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
    <FloatingPlayerShell
      hostRef={hostRef}
      frame={frame}
      hidden={!streaming}
      concealed={pipActive}
      attrPrefix="apple-mini"
      playerId={target.deviceUdid}
      ariaLabel={`${target.deviceName}, floating`}
      recording={recording}
      onStartDrag={startDrag}
      onStartResize={startResize}
      onOpenInPane={() => {
        stopPip();
        // The device is moving back into the pane, not being refused:
        // a dismissal here would stop A4 from ever floating it again.
        retakeAppleMiniPlayer(target.deviceUdid);
        onOpenInPane(target);
      }}
      onClose={() => {
        stopPip();
        closeAppleMiniPlayer(target.deviceUdid);
      }}
      pip={{
        supported: pipSupported,
        ready: hasPicture,
        onToggle: () => (pipActive ? stopPip() : void pip.enter()),
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

      {deviceOff ? (
        <div
          data-apple-mini-off=""
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center"
        >
          <p className="font-sans text-[12px] text-fg/85">{target.deviceName} is off</p>
          {target.laneId ? (
            <button
              type="button"
              disabled={starting}
              className="rounded-full border border-border px-3 py-0.5 font-sans text-[11px] text-fg/85 hover:bg-white/[0.07] hover:text-fg disabled:opacity-50"
              onClick={startDevice}
            >
              {starting ? "Starting…" : "Start"}
            </button>
          ) : null}
          {startError ? <p className="font-sans text-[11px] text-muted-fg">{startError}</p> : null}
        </div>
      ) : null}
    </FloatingPlayerShell>
  );
}
