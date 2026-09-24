import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  MacDesktopEventPayload,
  MacDesktopLeaseHolderKind,
  MacDesktopLeaseState,
  MacDesktopStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { isWorkLivePreviewDisabled } from "../../state/workLiveCardState";
import { cn } from "../ui/cn";
import { clearMacDesktopFrame, useMacDesktopFrame } from "../chat/macDesktopFrameStore";
import { H264VideoCanvas } from "../chat/H264VideoCanvas";
import { useMacDesktopLiveView } from "../chat/useMacDesktopLiveView";
import { MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY } from "../chat/macDesktopLiveViewLease";
import { macDesktopErrorText } from "../chat/macDesktopErrorText";
import { closeWorkLiveCardForChat, useChatCompanionUiState } from "../chat/chatCompanionUiState";
import {
  noteFloatingWorkSurfaceShown,
  useWorkSurfaceElementMounted,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import {
  FloatingPlayerShell,
  useCanvasPictureInPicture,
  useFloatingPlayerFrame,
} from "../shared/FloatingPlayer";
import { floatingPlayerSourceSize, type FloatingPlayerSize } from "../shared/floatingPlayerLayout";
import { isWorkLivePictureInPictureSupported } from "./workLiveIosPictureInPicture";
import { macDesktopFloatState, workLiveMacDesktopSessionKey, workLiveSource } from "./workLiveCard";
import {
  MAC_DESKTOP_CARD_ON_SCREEN_KEY,
  revokeMacDesktopCardForChat,
  useMacDesktopCardGrant,
} from "./macDesktopCardGrants";
import { readMacDesktopMiniPlayerChoice, writeMacDesktopMiniPlayerChoice } from "./macDesktopMiniPlayerChoice";

/**
 * The lane's Mac Desktop, floating over the chat.
 *
 * The same player as the floating Apple device (`FloatingPlayerShell`): drag
 * it, resize it from any edge, hover it for Open in pane, picture in picture
 * and Close. At rest it is the picture and an 8px dot, red while the desktop
 * records. Its place and width are kept across restarts.
 *
 * It used to be one of the corner card's sources, which the owner found
 * wanting on 2026-09-23: it could not be moved, it could not be resized, and it
 * floated over a tools pane that was already showing the desktop. Its rules
 * are now its own (`macDesktopFloatState`).
 *
 * The picture is the lane's one decoder when this player holds it (the pane
 * outranks it, see `macDesktopLiveViewLease`), and the last frame from
 * `macDesktopFrameStore` otherwise and underneath, so a handover from the pane
 * never shows a black box.
 */

/** A desktop shape until the first frame reports the display's own size. */
const DESKTOP_FALLBACK: FloatingPlayerSize = { width: 1_600, height: 1_000 };

/**
 * Whether the chat on screen is currently watching the lane's desktop, or
 * holding its input lease — plus the identity of the display itself.
 *
 * The display belongs to the lane, not to one chat, so the player asks the
 * stream status who its viewers are (ids only) and the lease who holds it.
 * Both reads are tolerant of a surface without the namespace. The display key
 * is what the "×" marker is stored under: a stop-and-recreate is a new
 * session, and a lane id could never tell the two apart. The lease holder's
 * kind and the recording flag feed the player's owner tag and red dot.
 * `displayGone` is true only once a read or an event SAID there is no display,
 * never while the answer is pending: it is what the Off state keys on.
 */
function useMacDesktopChatScope(args: {
  enabled: boolean;
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): {
  viewerChatSessionIds: string[];
  leaseHolderId: string | null;
  leaseHolderKind: MacDesktopLeaseHolderKind | null;
  recording: boolean;
  displayKey: string | null;
  displayGone: boolean;
  /** Apply a status this player fetched itself (the Off state's Start). */
  noteStatus: (status: MacDesktopStatus | null | undefined) => void;
} {
  const { enabled, laneId, chatSessionId, runtimePin } = args;
  const [viewerChatSessionIds, setViewerChatSessionIds] = useState<string[]>([]);
  const [lease, setLease] = useState<{ id: string; kind: MacDesktopLeaseHolderKind } | null>(null);
  const [recording, setRecording] = useState(false);
  const [displayKey, setDisplayKey] = useState<string | null>(null);
  const [displayGone, setDisplayGone] = useState(false);
  // Read through a ref so a caller passing a fresh pin object each render cannot
  // re-issue the stream read; only the pin's key is a dependency.
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const pinKey = runtimePin?.key ?? null;

  useEffect(() => {
    const api = window.ade?.macDesktop;
    if (!enabled || !laneId || !api || !chatSessionId) {
      // Without a chat there is nothing to authorize; skip the reads entirely.
      setViewerChatSessionIds([]);
      setLease(null);
      setRecording(false);
      setDisplayKey(null);
      setDisplayGone(false);
      return undefined;
    }
    let cancelled = false;
    void api.getStreamStatus?.({ laneId }, pinRef.current)
      .then((status) => {
        if (!cancelled) setViewerChatSessionIds(status?.viewerChatSessionIds ?? []);
      })
      .catch(() => {});
    // The lease and the display are seeded once as well as tracked by event: a
    // chat that already holds the lease, or a display that already exists when
    // this player mounts, gets no event to learn from.
    void api.getStatus?.({ laneId, chatSessionId }, pinRef.current)
      .then((status) => {
        if (cancelled) return;
        setLease(leaseOf(status?.lease));
        setRecording(status?.recording?.running === true);
        setDisplayKey(workLiveMacDesktopSessionKey(status?.display));
        if (status) setDisplayGone(!status.display);
      })
      .catch(() => {});
    const unsubscribe = api.onEvent?.((event: MacDesktopEventPayload) => {
      if (
        event.type === "stream-started"
        || event.type === "stream-status"
        || event.type === "stream-stopped"
        || event.type === "stream-error"
      ) {
        if (event.status.laneId === laneId) {
          setViewerChatSessionIds(event.status.viewerChatSessionIds ?? []);
        }
        return;
      }
      if (event.type === "lease-changed" && event.laneId === laneId) {
        setLease(leaseOf(event.lease));
        return;
      }
      if (event.type === "recording-changed" && event.status.laneId === laneId) {
        setRecording(event.status.running === true);
        return;
      }
      if (event.type === "display-created") {
        if (event.display.laneId === laneId) {
          setDisplayKey(workLiveMacDesktopSessionKey(event.display));
          setDisplayGone(false);
        }
        return;
      }
      if (event.type === "display-destroyed" && event.laneId === laneId) {
        setDisplayKey(null);
        setDisplayGone(true);
        // A recording cannot outlive its display; the stop event may never come.
        setRecording(false);
        // The picture is of a display that no longer exists; the pane clears
        // the shared frame too, but the player must not depend on the pane
        // being open to stop showing a dead screen.
        clearMacDesktopFrame(laneId);
      }
    }, pinRef.current);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [chatSessionId, enabled, laneId, pinKey]);

  const noteStatus = useCallback((status: MacDesktopStatus | null | undefined) => {
    if (!status?.display || status.display.laneId !== laneId) return;
    setDisplayKey(workLiveMacDesktopSessionKey(status.display));
    setDisplayGone(false);
  }, [laneId]);

  return {
    viewerChatSessionIds,
    leaseHolderId: lease?.id ?? null,
    leaseHolderKind: lease?.kind ?? null,
    recording,
    displayKey,
    displayGone,
    noteStatus,
  };
}

function leaseOf(lease: MacDesktopLeaseState | null | undefined): { id: string; kind: MacDesktopLeaseHolderKind } | null {
  return lease?.holderId ? { id: lease.holderId, kind: lease.holder } : null;
}

export function MacDesktopMiniPlayer({
  active,
  laneId,
  paneTool,
  chatSessionId,
  sessionLaneId = null,
  runtimePin,
  supported,
  onOpenInPane,
}: {
  /** The Work route is on screen. Everything here is torn down when it is not. */
  active: boolean;
  laneId: string | null;
  /**
   * The chat's OWN lane: null for a lane-less chat, whose tools borrow the
   * pane's fallback lane. Only a chat of the lane gets the default preview.
   */
  sessionLaneId?: string | null;
  /** The tool filling the tools pane, or null when the pane is closed. */
  paneTool: WorkSidebarTab | null;
  /** The chat on screen. Only a chat that may see the lane's desktop gets it. */
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** False once the host said it cannot host a display. */
  supported: boolean;
  onOpenInPane: () => void;
}) {
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;
  const boundBinding = useAppStore((s) => s.projectBinding);
  const scopeKey = workRuntimeScopeKey(runtimePin, boundBinding);

  const macScope = useMacDesktopChatScope({ enabled: supported, laneId, chatSessionId, runtimePin });
  /**
   * The lane's last desktop frame. A store read, not a feed: whichever surface
   * holds the decoder writes it, so the picture exists even while the pane
   * owns the stream.
   */
  const storedFrame = useMacDesktopFrame(laneId);

  /**
   * When this chat's agent last drove the lane's desktop (or asked to show it),
   * or null. See `macDesktopCardGrants`: an agent in accessibility mode is
   * neither a viewer nor the lease holder, so without this the player never
   * appeared for the chat whose agent was working on the display.
   */
  const grantedAt = useMacDesktopCardGrant(laneId, chatSessionId);
  const granted = Boolean(chatSessionId && grantedAt != null);
  /**
   * On by default, like the floating Apple device: a chat of the lane sees
   * the lane's running display float over it without having watched it or
   * driven it first. The chat's preview toggle and × still turn it off
   * (`dismissed` below), and the Off state stays for a granted chat only.
   */
  const laneDefault = Boolean(laneId && sessionLaneId === laneId && macScope.displayKey != null);
  const authorized = Boolean(
    chatSessionId
    && (
      macScope.viewerChatSessionIds.includes(chatSessionId)
      || macScope.leaseHolderId === chatSessionId
      || granted
      || laneDefault
    ),
  );
  /**
   * The display went away under a player this chat's agent floated: the player
   * stays, says so and offers Start, as the floating Apple player does. Any
   * other player leaves with its display.
   */
  const off = granted && macScope.displayGone;

  // × and the pane's "Show preview when minimized" toggle write the same
  // per-chat marker, so the two can never disagree.
  const companionUi = useChatCompanionUiState(chatSessionId);
  const floated = companionUi.workLiveCardFloating.includes("mac-desktop");
  const dismissed = isWorkLivePreviewDisabled(companionUi.workLiveCardClosedByTool, "mac-desktop") && !floated;

  /**
   * The lane's one decoder, held by this player while nobody shows the pane.
   *
   * While the pane is open it outranks the player and this hook is passive; the
   * moment the pane goes away the player is promoted and decodes, so frames
   * keep reaching `macDesktopFrameStore` and the chat stays a stream viewer.
   */
  const live = useMacDesktopLiveView({
    laneId,
    runtimePin,
    enabled: Boolean(
      active
      && laneId
      && chatSessionId
      && authorized
      && !dismissed
      // Nothing to decode: the Off state shows instead.
      && !off
      && supported,
    ),
    chatSessionId,
    priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
  });
  const decoderPlaying = Boolean(live.url) && live.status === "playing";
  // The pane's own element, by the key it registers under: see `macDesktopFloatState`.
  const paneMounted = useWorkSurfaceElementMounted(laneId ? workSurfaceKey("mac-desktop", scopeKey, laneId) : null);

  const { present, visible } = macDesktopFloatState({
    active,
    laneId,
    chatSessionId,
    supported,
    authorized,
    dismissed,
    hasPicture: Boolean(storedFrame) || decoderPlaying,
    off,
    floated,
    decoding: Boolean(live.url),
    paneTool,
    paneMounted,
  });

  const source = useMemo(() => workLiveSource("mac-desktop", {
    browserTab: null,
    appControlSession: null,
    iosSession: null,
    macDesktopFrame: storedFrame ? { ...storedFrame, displayKey: macScope.displayKey } : null,
    macDesktopControl: { leaseHolder: macScope.leaseHolderKind, recording: macScope.recording },
  }), [macScope.displayKey, macScope.leaseHolderKind, macScope.recording, storedFrame]);

  /** The Off state's Start: the same explicit start as the pane's Off card. */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const noteStatus = macScope.noteStatus;
  const start = useCallback(() => {
    const api = window.ade?.macDesktop;
    if (!api?.start || !laneId) return;
    setStarting(true);
    setStartError(null);
    void api.start({ laneId, chatSessionId }, runtimePinRef.current)
      // The `display-created` event says the same; the answer is not held
      // back behind it.
      .then((status) => noteStatus(status))
      .catch((cause: unknown) => setStartError(
        macDesktopErrorText(cause instanceof Error ? cause.message : String(cause), { laneId })
          ?? "Mac Desktop did not start.",
      ))
      .finally(() => setStarting(false));
  }, [chatSessionId, laneId, noteStatus]);

  /**
   * × turns the preview off for this chat and ends the agent's float: the
   * agent's next action does not bring it back until the chat's preview
   * toggle is on again. Keyed by the display it was showing.
   */
  const close = useCallback(() => {
    if (!chatSessionId) return;
    closeWorkLiveCardForChat(chatSessionId, "mac-desktop", source.sessionKey ?? laneId ?? "");
    revokeMacDesktopCardForChat(laneId, chatSessionId);
  }, [chatSessionId, laneId, source.sessionKey]);

  if (!present || !laneId) return null;
  return (
    <MacDesktopMiniPlayerBox
      laneId={laneId}
      onScreenKey={workSurfaceKey(MAC_DESKTOP_CARD_ON_SCREEN_KEY, scopeKey, laneId)}
      visible={visible}
      live={live}
      storedFrame={storedFrame?.dataUrl ?? null}
      storedSize={storedFrame ? { width: storedFrame.width, height: storedFrame.height } : null}
      ownerLabel={source.ownerLabel}
      recording={macScope.recording}
      off={off}
      starting={starting}
      startError={startError}
      onStart={start}
      onOpenInPane={onOpenInPane}
      onClose={close}
    />
  );
}

function MacDesktopMiniPlayerBox({
  laneId,
  onScreenKey,
  visible,
  live,
  storedFrame,
  storedSize,
  ownerLabel,
  recording,
  off,
  starting,
  startError,
  onStart,
  onOpenInPane,
  onClose,
}: {
  laneId: string;
  /** The `workToolOnScreen` key for this card on this lane and machine. */
  onScreenKey: string;
  /** False while hidden (the pane shows the desktop): mounted, so it keeps its place. */
  visible: boolean;
  live: ReturnType<typeof useMacDesktopLiveView>;
  storedFrame: string | null;
  storedSize: FloatingPlayerSize | null;
  ownerLabel: string | null;
  recording: boolean;
  off: boolean;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
  onOpenInPane: () => void;
  onClose: () => void;
}) {
  const decoderHostRef = useRef<HTMLDivElement | null>(null);
  const pip = useCanvasPictureInPicture(() => decoderHostRef.current?.querySelector("canvas"));
  const stopPip = pip.stop;
  const decoderPlaying = Boolean(live.url) && live.status === "playing";

  const source = floatingPlayerSourceSize(live.dimensions ?? storedSize, DESKTOP_FALLBACK);
  const [initial] = useState(readMacDesktopMiniPlayerChoice);
  const { hostRef, frame, startDrag, startResize } = useFloatingPlayerFrame({
    source,
    initial,
    onCommit: writeMacDesktopMiniPlayerChoice,
  });

  // The player lost the decoder (the pane took it back, the player was closed,
  // the display went away): the PiP window would freeze on the last frame.
  useEffect(() => {
    if (pip.active && !live.url) stopPip();
  }, [live.url, pip.active, stopPip]);

  // `ade ui show floating-mac-desktop` answers "shown" only while this is set.
  const shown = visible || pip.active;
  useLayoutEffect(
    () => (shown ? noteFloatingWorkSurfaceShown(onScreenKey) : undefined),
    [onScreenKey, shown],
  );

  return (
    <FloatingPlayerShell
      hostRef={hostRef}
      frame={frame}
      hidden={!shown}
      concealed={pip.active}
      attrPrefix="mac-mini"
      playerId={laneId}
      ariaLabel="Mac Desktop, floating"
      recording={recording}
      onStartDrag={startDrag}
      onStartResize={startResize}
      onOpenInPane={() => {
        stopPip();
        onOpenInPane();
      }}
      onClose={() => {
        stopPip();
        onClose();
      }}
      pip={{
        supported: isWorkLivePictureInPictureSupported(),
        ready: decoderPlaying,
        onToggle: () => (pip.active ? stopPip() : void pip.enter()),
      }}
      barLeading={ownerLabel ? (
        <span
          data-mac-mini-owner={ownerLabel}
          title={ownerLabel === "you" ? "You have control" : "The agent is driving"}
          className="shrink-0 whitespace-nowrap pl-1.5 pr-0.5 font-sans text-[11px] text-muted-fg"
        >
          {ownerLabel}
        </span>
      ) : null}
    >
      {/*
        The picture does not take input (driving the desktop is the pane's
        Take over), so the whole of it moves the player. A click that does not
        move is nothing; "Open in pane" is on the hover bar.
      */}
      <div
        data-mac-mini-picture=""
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={startDrag}
      >
        {storedFrame ? (
          /* The last frame, under the decoder: it is the picture while the pane
             holds the stream, and it covers the new reader's first keyframe
             after a handover. */
          <img
            src={storedFrame}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-mac-mini-poster=""
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
        ) : null}
        {live.url ? (
          <div ref={decoderHostRef} data-mac-mini-decoder="" className="pointer-events-none absolute inset-0">
            <H264VideoCanvas
              url={live.url}
              reconnectNonce={live.reconnectNonce}
              onStatus={live.onStatus}
              onDimensions={live.onDimensions}
              onCanvas={live.onCanvas}
              className={decoderPlaying ? undefined : "opacity-0"}
            />
          </div>
        ) : null}
        {!storedFrame && !decoderPlaying && !off ? (
          <p className="absolute inset-0 flex items-center justify-center font-sans text-[11px] text-muted-fg">
            Connecting…
          </p>
        ) : null}
      </div>

      {off ? (
        <div
          data-mac-mini-off=""
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center"
        >
          <p className="font-sans text-[12px] text-fg/85">Mac Desktop is off</p>
          <button
            type="button"
            disabled={starting}
            className={cn(
              "rounded-full border border-border px-3 py-0.5 font-sans text-[11px] text-fg/85",
              "hover:bg-white/[0.07] hover:text-fg disabled:opacity-50",
            )}
            onClick={onStart}
          >
            {starting ? "Starting…" : "Start"}
          </button>
          {startError ? <p className="font-sans text-[11px] text-muted-fg">{startError}</p> : null}
        </div>
      ) : null}
    </FloatingPlayerShell>
  );
}
