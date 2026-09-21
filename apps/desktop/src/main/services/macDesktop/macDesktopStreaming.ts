/**
 * The live view half of the Mac Desktop service.
 *
 * Owns the loopback video server, the per-lane transport (and therefore the
 * token), the redacted/unredacted split every stream read depends on, and who
 * asked for the stream so a closing chat can take it down again.
 *
 * Split out of `macDesktopService.ts` as pure code motion: the service passes
 * its registries and its gates in, and keeps the API surface.
 */

import {
  MAC_DESKTOP_ACTIVE_FPS,
  MAC_DESKTOP_IDLE_FPS,
  type DesktopSeatProvider,
  type MacDesktopEventPayload,
  type MacDesktopStartStreamArgs,
  type MacDesktopStreamStatus,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import {
  clampFps,
  createMacDesktopStreamServer,
  type MacDesktopStreamServerDeps,
  type MacDesktopStreamTransportWithSecret,
} from "./macDesktopStreamServer";

/** The transport the server minted, token included. Never leaves this process. */
type LaneTransport = MacDesktopStreamTransportWithSecret;

export type MacDesktopStreamingDeps = {
  logger: Logger;
  now: () => number;
  isDarwin: boolean;
  emit: (payload: MacDesktopEventPayload) => void;
  /** Starts the backend if needed. Throws the same errors the service does. */
  ensureProvider: () => Promise<DesktopSeatProvider>;
  /** The backend only if it is already up: teardown must not start one. */
  activeProvider: () => DesktopSeatProvider | null;
  requireDisplay: (laneId: string) => void;
  assertPermission: (which: "screenRecording" | "accessibility") => void;
  touchDisplay: (laneId: string) => void;
  /** Raised by `startStream` when the backend hands back no port. */
  driverUnavailable: (message: string) => Error;
  /** The takeover fast path served on the stream server. See `macDesktopInput.postRealInput`. */
  postRealInput?: MacDesktopStreamServerDeps["postRealInput"];
};

export function createMacDesktopStreaming(deps: MacDesktopStreamingDeps) {
  /**
   * laneId → every chat that asked for the current stream.
   *
   * A set rather than one owner: a second chat (or a reconnecting viewer) asking
   * for a stream that is already up is handed the live one, and the first chat
   * to end must not take the stream down under everyone else. `null` is the
   * anonymous asker — a viewer with no chat session — and it is a member like
   * any other so `stopOwnedBy` can never empty a set it is in.
   */
  const streamOwners = new Map<string, Set<string | null>>();
  /**
   * laneId → sync-socket subscription ids watching the lane live.
   *
   * Deliberately not in `streamOwners`: that set feeds `viewerChatSessionIds`,
   * which callers read as "chats watching this lane". A subscription id is not
   * a chat, and a viewer that is only watching from a browser must not make
   * the lane look like a chat's turn is active.
   */
  const streamSubscriptions = new Map<string, Set<string>>();

  const addStreamOwner = (laneId: string, chatSessionId: string | null | undefined): void => {
    const owner = chatSessionId?.trim() || null;
    const owners = streamOwners.get(laneId);
    if (owners) owners.add(owner);
    else streamOwners.set(laneId, new Set([owner]));
  };

  const addSubscriptionOwner = (laneId: string, subscriptionId: string): void => {
    const existing = streamSubscriptions.get(laneId);
    if (existing) existing.add(subscriptionId);
    else streamSubscriptions.set(laneId, new Set([subscriptionId]));
  };

  /** True while any asker — chat or sync subscription — keeps the stream up. */
  const hasStreamOwners = (laneId: string): boolean =>
    (streamOwners.get(laneId)?.size ?? 0) > 0 || (streamSubscriptions.get(laneId)?.size ?? 0) > 0;
  const streamServer = createMacDesktopStreamServer({
    logger: deps.logger,
    now: deps.now,
    // Read late: the input module is built after streaming (it needs the
    // server's `noteActivity`), so the service fills this in afterwards.
    postRealInput: (args) => {
      if (!deps.postRealInput) return Promise.reject(new Error("Real input is not available on this host."));
      return deps.postRealInput(args);
    },
    setRate: async ({ laneId, fps }) => {
      const provider = deps.activeProvider();
      if (!provider) return;
      await provider.setStreamRate({ laneId, fps });
      deps.emit({ type: "stream-status", status: buildStreamStatus(laneId, { redacted: true }) });
    },
    onZeroClients: (laneId) => {
      // The encoder stops; the display does not. A lane with parked windows is
      // still doing work nobody happens to be watching.
      void stopStream(laneId, "no-clients").catch((error) => {
        deps.logger.debug("mac_desktop.stream_idle_stop_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  /**
   * The chat ids recorded as viewers of a lane's stream, anonymous askers
   * dropped. Ids only — see `MacDesktopStreamStatus.viewerChatSessionIds`.
   */
  const viewerChatSessionIds = (laneId: string): string[] => (
    [...(streamOwners.get(laneId) ?? [])].filter((owner): owner is string => typeof owner === "string")
  );

  /**
   * The stream's shape for a reader.
   *
   * Always answers: a lane with no stream is a stopped stream, not an absent
   * one, and every caller wants to say so rather than branch on null.
   */
  function buildStreamStatus(
    laneId: string,
    options: { redacted?: boolean; transport?: LaneTransport | null } = {},
  ): MacDesktopStreamStatus {
    const metrics = streamServer.metrics(laneId);
    if (!metrics) {
      return {
        laneId,
        running: false,
        fps: 0,
        idle: false,
        bitrateKbps: null,
        transport: null,
        lastError: null,
        clients: 0,
        viewerChatSessionIds: viewerChatSessionIds(laneId),
      };
    }
    const transport = options.transport ?? null;
    return {
      laneId,
      running: true,
      fps: metrics.fps,
      idle: metrics.idle,
      bitrateKbps: metrics.bitrateKbps,
      transport: {
        // Redacted on every read but `startStream`: `getStreamStatus` is on the
        // agent action allowlist, so an unredacted token would be printed into
        // a durable transcript.
        url: options.redacted === false && transport ? transport.url : null,
        port: transport?.port ?? metrics.port,
        token: options.redacted === false && transport ? transport.token : null,
        codec: metrics.codec,
        width: metrics.width,
        height: metrics.height,
      },
      lastError: metrics.lastError,
      clients: metrics.clients,
      viewerChatSessionIds: viewerChatSessionIds(laneId),
    };
  }

  type StreamOwner =
    | { kind: "chat"; chatSessionId: string | null | undefined }
    | { kind: "subscription"; subscriptionId: string };

  const addOwner = (laneId: string, owner: StreamOwner): void => {
    if (owner.kind === "chat") addStreamOwner(laneId, owner.chatSessionId);
    else addSubscriptionOwner(laneId, owner.subscriptionId);
  };

  async function startStreamFor(
    args: Pick<MacDesktopStartStreamArgs, "laneId" | "fps" | "idleFps">,
    owner: StreamOwner,
  ): Promise<MacDesktopStreamStatus> {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const running = streamServer.getTransport(laneId);
    if (running) {
      // A reconnecting viewer asks again. Restarting would mint a second token
      // and cut off every client holding the first one, so the live stream and
      // its token are handed back unchanged; only a stopped stream mints one.
      addOwner(laneId, owner);
      deps.touchDisplay(laneId);
      return buildStreamStatus(laneId, { redacted: false, transport: running });
    }
    const provider = await deps.ensureProvider();
    deps.assertPermission("screenRecording");
    const fps = clampFps(args.fps, MAC_DESKTOP_ACTIVE_FPS);
    // The idle rate is also capped by the active rate: idling faster than the
    // stream runs is not a rate.
    const idleFps = Math.min(fps, clampFps(args.idleFps, MAC_DESKTOP_IDLE_FPS));
    const reply = await provider.startStream({ laneId, fps });
    const sourcePort = typeof reply.port === "number" && Number.isFinite(reply.port) ? reply.port : 0;
    if (!sourcePort) {
      throw deps.driverUnavailable("The desktop driver did not hand back a stream port.");
    }
    const transport = await streamServer.start({
      laneId,
      sourcePort,
      codec: typeof reply.codec === "string" ? reply.codec : null,
      width: typeof reply.width === "number" ? reply.width : null,
      height: typeof reply.height === "number" ? reply.height : null,
      fps,
      idleFps,
    });
    addOwner(laneId, owner);
    deps.touchDisplay(laneId);
    // The only call that hands out the token.
    const status = buildStreamStatus(laneId, { redacted: false, transport });
    deps.emit({ type: "stream-started", status: buildStreamStatus(laneId, { redacted: true }) });
    return status;
  }

  async function startStream(args: MacDesktopStartStreamArgs): Promise<MacDesktopStreamStatus> {
    return await startStreamFor(args, { kind: "chat", chatSessionId: args.chatSessionId });
  }

  /**
   * The sync live view's start: same stream, same rate bookkeeping, but the
   * asker is a subscription id rather than a chat. It stays out of
   * `viewerChatSessionIds` for that reason.
   */
  async function startStreamForSubscription(args: {
    laneId: string;
    subscriptionId: string;
    fps?: number | null;
    idleFps?: number | null;
  }): Promise<MacDesktopStreamStatus> {
    return await startStreamFor(args, { kind: "subscription", subscriptionId: args.subscriptionId });
  }

  async function stopStream(laneId: string, reason: string): Promise<MacDesktopStreamStatus> {
    const wasStreaming = streamServer.isStreaming(laneId);
    streamServer.stop(laneId);
    streamOwners.delete(laneId);
    streamSubscriptions.delete(laneId);
    const provider = deps.isDarwin ? deps.activeProvider() : null;
    if (provider) {
      await provider.stopStream({ laneId }).catch((error: unknown) => {
        deps.logger.debug("mac_desktop.stop_stream_failed", {
          laneId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const status = buildStreamStatus(laneId, { redacted: true });
    if (wasStreaming) deps.emit({ type: "stream-stopped", status });
    return status;
  }

  return {
    streamServer,
    buildStreamStatus,
    startStream,
    startStreamForSubscription,
    stopStream,

    /** Records an encoder failure the backend reported, and republishes. */
    recordError(laneId: string, message: string): void {
      streamServer.recordError(laneId, message);
      deps.emit({ type: "stream-error", status: buildStreamStatus(laneId, { redacted: true }) });
    },

    /** Local teardown for a lane whose display is going away. */
    forgetLane(laneId: string): void {
      streamServer.stop(laneId);
      streamOwners.delete(laneId);
      streamSubscriptions.delete(laneId);
    },

    /**
     * Stops every stream whose LAST asker was this closing chat.
     *
     * A stream two chats asked for outlives the first of them: dropping the
     * closing chat and stopping only on an empty set is what keeps the other
     * viewer's picture alive.
     */
    async stopOwnedBy(chatSessionId: string): Promise<void> {
      for (const [laneId, owners] of [...streamOwners]) {
        if (!owners.delete(chatSessionId)) continue;
        if (hasStreamOwners(laneId)) continue;
        await stopStream(laneId, "owner-chat-ended").catch(() => {
          // A stream we cannot stop is one the server's own teardown will.
        });
      }
    },

    /**
     * Drops one sync-socket viewer. Same rule as `stopOwnedBy`: only an empty
     * owner set stops the encoder, so a browser closing its tab never takes
     * the picture away from a chat that is still watching.
     */
    async releaseStreamSubscription(subscriptionId: string): Promise<void> {
      for (const [laneId, subscriptions] of [...streamSubscriptions]) {
        if (!subscriptions.delete(subscriptionId)) continue;
        if (hasStreamOwners(laneId)) continue;
        await stopStream(laneId, "subscription-ended").catch(() => {
          // A stream we cannot stop is one the server's own teardown will.
        });
      }
    },

    clear(): void {
      streamOwners.clear();
      streamSubscriptions.clear();
    },

    dispose(): void {
      streamServer.dispose();
      streamOwners.clear();
      streamSubscriptions.clear();
    },
  };
}

export type MacDesktopStreaming = ReturnType<typeof createMacDesktopStreaming>;
