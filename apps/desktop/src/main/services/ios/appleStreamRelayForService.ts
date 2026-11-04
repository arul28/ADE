import type { AppleDevicePosture } from "../../../shared/types/iosSimulator";
import {
  APPLE_STREAM_NOT_RUNNING_CODE,
  createAppleStreamRelay,
  type AppleStreamRelay,
  type AppleStreamRelayDeps,
} from "./appleStreamRelay";

/*
 * The stream relay over the simulator service: which captures it may start
 * and stop, and the pose notes it forwards. The relay itself
 * (`appleStreamRelay.ts`) knows nothing of the service.
 */

/** What the service may ask the relay before a local viewer's stop. */
export type AppleRemoteViewerProbe = {
  /** A remote viewer is reading this lane's capture right now. */
  watching(laneId: string): boolean;
  /** The relay now owns stopping this lane's capture. */
  adopt(laneId: string): void;
};

/** The slice of the simulator service the relay drives. */
export type AppleStreamOwningService = {
  getStreamStatus(args: { laneId?: string | null }): { running: boolean };
  startStream(args: { laneId?: string | null; bitrateKbps?: number | null }): Promise<{
    transport?: {
      url?: string | null;
      token?: string | null;
      codec?: string | null;
      width?: number | null;
      height?: number | null;
    } | null;
  }>;
  stopStream(args: { laneId?: string | null }): Promise<unknown>;
  /**
   * Is a renderer on this machine still watching this lane's stream? The
   * service tracks it, so the answer is the same whether the renderer reached
   * the service through IPC or a runtime action.
   */
  hasLocalViewer?: (laneId: string) => boolean;
  /**
   * Lets the service ask, before a LOCAL viewer's stop, whether a remote
   * viewer still reads the capture, and hand the stop to the relay if so.
   */
  setRemoteViewerProbe?: (probe: AppleRemoteViewerProbe | null) => void;
  /**
   * The last remote viewer left while a viewer on this machine still watches:
   * drop the remote bitrate cap so the local view is back at full quality.
   */
  liftStreamBitrateCap?: (args: { laneId: string }) => Promise<unknown>;
  /** Re-cap the capture that is running now, and never start one. Pacing uses it. */
  capLiveStream?: (args: { laneId: string; bitrateKbps: number }) => Promise<unknown>;
  /** A foldable's pose now, read when the relay opens its capture. */
  getPosture?: (args: { laneId: string }) => Promise<AppleDevicePosture>;
  /** Hear each pose change of a streamed foldable; returns the unsubscribe. */
  onPostureChanged?: (listener: (laneId: string | null, posture: AppleDevicePosture) => void) => () => void;
};

/**
 * Build a relay over a simulator service.
 *
 * The one rule worth naming: **the relay stops only what the relay started.**
 * The desktop reads the helper's loopback body itself, so the brain cannot see
 * its viewers; without this rule, closing a phone's viewer would black out the
 * Mac's own live view. Tracking which lanes this relay brought up is a cheaper
 * and more honest answer than inventing a local-viewer registry the desktop
 * would have to remember to update.
 */
export function createAppleStreamRelayForService(deps: {
  service: AppleStreamOwningService;
  /** `apple.remoteBitrateKbpsCap`, read per start so a settings change lands. */
  remoteBitrateKbpsCap: () => number | null;
  /**
   * Is a viewer on this machine's own renderer still watching this lane?
   *
   * `startedLanes` below answers "did the relay bring this up", which is not
   * the same question: a web tab can start a capture that the desktop column
   * then joins, and closing the tab would stop a device somebody is still
   * looking at. The headless brain has no renderer, so it passes nothing and
   * the answer is a constant false.
   */
  hasLocalViewer?: (laneId: string) => boolean;
  logger?: AppleStreamRelayDeps["logger"];
  connect?: AppleStreamRelayDeps["connect"];
  publicOrigin?: AppleStreamRelayDeps["publicOrigin"];
}): AppleStreamRelay {
  const startedLanes = new Set<string>();
  const capLiveStream = deps.service.capLiveStream;
  const getPosture = deps.service.getPosture;
  const relay = createAppleStreamRelay({
    logger: deps.logger,
    connect: deps.connect,
    publicOrigin: deps.publicOrigin,
    bitrateCapKbps: deps.remoteBitrateKbpsCap,
    // Not `startStream`: that resolves the device again and starts a capture
    // when none is running, which a cap change must never do.
    applyBitrateCap: capLiveStream ? (args) => capLiveStream(args) : undefined,
    // Fall back to the service's own tracker, so the brain (which passes no
    // registry) still sees a desktop renderer that joined a remote-started
    // capture.
    hasLocalViewer: deps.hasLocalViewer
      ?? (deps.service.hasLocalViewer
        ? (laneId: string) => deps.service.hasLocalViewer?.(laneId) ?? false
        : undefined),
    // The pose the device is already in; the posture watcher reports changes
    // from here on. A rigid device answers "not supported" and adds nothing.
    readPosture: getPosture
      ? async ({ laneId }) => relay.notePosture(laneId, await getPosture({ laneId }))
      : undefined,
    openSource: async ({ laneId }) => {
      const alreadyRunning = deps.service.getStreamStatus({ laneId }).running;
      const status = await deps.service.startStream({
        laneId,
        bitrateKbps: deps.remoteBitrateKbpsCap(),
      });
      if (!alreadyRunning) startedLanes.add(laneId);
      const transport = status.transport;
      if (!transport?.url || !transport.token) {
        throw new Error(
          `${APPLE_STREAM_NOT_RUNNING_CODE}: the Apple device helper reported no stream address for lane ${laneId}.`,
        );
      }
      return {
        url: transport.url,
        token: transport.token,
        codec: transport.codec ?? null,
        width: transport.width ?? null,
        height: transport.height ?? null,
      };
    },
    closeSource: async ({ laneId, localViewers }) => {
      if (localViewers) {
        // Somebody on this machine is still watching. Forget that the relay
        // started it: the local viewer owns the stop now, and a later remote
        // viewer must not inherit the right to end it. The cap was for the
        // remote viewers, so it goes with them.
        startedLanes.delete(laneId);
        await deps.service.liftStreamBitrateCap?.({ laneId });
        return;
      }
      // Not the relay's capture to stop, so it keeps running for whoever
      // started it, without the remote cap.
      if (!startedLanes.delete(laneId)) {
        await deps.service.liftStreamBitrateCap?.({ laneId });
        return;
      }
      try {
        await Promise.resolve(deps.service.stopStream({ laneId }));
      } catch (error) {
        // The body this relay read is already closed, but the helper may still
        // hold a capture. Reports under the relay's own close-failure name.
        deps.logger?.warn?.("apple.stream_close_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  // A desktop viewer leaving must not cut off a phone still reading the same
  // capture: the service asks here first, and the relay takes the stop over.
  deps.service.setRemoteViewerProbe?.({
    watching: (laneId) => relay.visibleViewerCount(laneId) > 0,
    adopt: (laneId) => {
      startedLanes.add(laneId);
    },
  });
  // Every viewer of the lane hears a streamed foldable's pose as it changes.
  const stopPostureNotes = deps.service.onPostureChanged?.((laneId, posture) => relay.notePosture(laneId, posture));
  const disposeRelay = relay.dispose.bind(relay);
  return {
    ...relay,
    dispose: () => {
      deps.service.setRemoteViewerProbe?.(null);
      stopPostureNotes?.();
      disposeRelay();
    },
  };
}
