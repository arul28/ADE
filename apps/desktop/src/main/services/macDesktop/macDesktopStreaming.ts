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
  createMacDesktopStreamServer,
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
};

export function createMacDesktopStreaming(deps: MacDesktopStreamingDeps) {
  /** laneId → chat that asked for the current stream, for the idle accounting. */
  const streamOwners = new Map<string, string | null>();
  const streamServer = createMacDesktopStreamServer({
    logger: deps.logger,
    now: deps.now,
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
    };
  }

  async function startStream(args: MacDesktopStartStreamArgs): Promise<MacDesktopStreamStatus> {
    const laneId = args.laneId.trim();
    deps.requireDisplay(laneId);
    const running = streamServer.getTransport(laneId);
    if (running) {
      // A reconnecting viewer asks again. Restarting would mint a second token
      // and cut off every client holding the first one, so the live stream and
      // its token are handed back unchanged; only a stopped stream mints one.
      deps.touchDisplay(laneId);
      return buildStreamStatus(laneId, { redacted: false, transport: running });
    }
    const provider = await deps.ensureProvider();
    deps.assertPermission("screenRecording");
    const fps = Math.max(1, Math.min(60, Math.round(args.fps ?? MAC_DESKTOP_ACTIVE_FPS)));
    const idleFps = Math.max(1, Math.min(fps, Math.round(args.idleFps ?? MAC_DESKTOP_IDLE_FPS)));
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
    streamOwners.set(laneId, args.chatSessionId?.trim() || null);
    deps.touchDisplay(laneId);
    // The only call that hands out the token.
    const status = buildStreamStatus(laneId, { redacted: false, transport });
    deps.emit({ type: "stream-started", status: buildStreamStatus(laneId, { redacted: true }) });
    return status;
  }

  async function stopStream(laneId: string, reason: string): Promise<MacDesktopStreamStatus> {
    const wasStreaming = streamServer.isStreaming(laneId);
    streamServer.stop(laneId);
    streamOwners.delete(laneId);
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
    },

    /** Stops every stream a closing chat asked for. */
    async stopOwnedBy(chatSessionId: string): Promise<void> {
      for (const [laneId, owner] of [...streamOwners]) {
        if (owner !== chatSessionId) continue;
        await stopStream(laneId, "owner-chat-ended").catch(() => {
          // A stream we cannot stop is one the server's own teardown will.
        });
      }
    },

    clear(): void {
      streamOwners.clear();
    },

    dispose(): void {
      streamServer.dispose();
      streamOwners.clear();
    },
  };
}

export type MacDesktopStreaming = ReturnType<typeof createMacDesktopStreaming>;
