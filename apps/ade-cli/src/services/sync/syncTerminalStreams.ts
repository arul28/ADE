import { createHash } from "node:crypto";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import { nowIso, toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import type {
  PtyDataEvent,
  PtyExitEvent,
  SyncEnvelope,
  SyncTerminalDataPayload,
  SyncTerminalExitPayload,
  SyncTerminalHistoryResponsePayload,
  SyncTerminalInputAckPayload,
  SyncTerminalInputPayload,
  SyncTerminalSnapshotPayload,
  SyncTerminalSubscribeError,
  SyncTerminalSubscribePayload,
} from "../../../../desktop/src/shared/types";
import { runWithAbortSignal } from "./abortSignal";
import type { ParsedSyncEnvelope } from "./syncProtocol";
import {
  clearTerminalSnapshotBarrier,
  dataPayload,
  discardTrackedTerminalDataForRecapture,
  exitPayload,
  MAX_PENDING_TERMINAL_SNAPSHOT_BYTES,
  MAX_PENDING_TERMINAL_SNAPSHOT_EVENTS,
  planTerminalSnapshotFlush,
  type PendingTerminalSnapshotBarrier,
  type PendingTerminalSnapshotEvent,
  replacingSnapshotPayload,
  requireFreshTerminalSnapshot,
  type TerminalSessionRow,
  type TerminalTranscriptSnapshot,
  withTerminalScreen,
} from "./syncTerminalSnapshotBarrier";

// Terminal streaming for phone sockets: the snapshot barrier, offset resume,
// live data and exit, history pages, resize, and acknowledged input. Both
// phone ingresses use it. The project sync host serves its own project's
// sessions and routes the rest; the brain's projectless handler routes all.
// A routed session is one in another project that is open on this machine:
// its PTY and session rows come from that project's runtime.

const DEFAULT_TERMINAL_SNAPSHOT_BYTES = 220_000;
const DEFAULT_TERMINAL_HISTORY_PAGE_BYTES = 262_144;
const MIN_TERMINAL_HISTORY_PAGE_BYTES = 4_096;
const MAX_TERMINAL_HISTORY_PAGE_BYTES = 524_288;
const MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS = 4;
const TERMINAL_INPUT_ID_MAX_CHARS = 128;

// Every live ingress in this process. The host and the brain keep separate peer
// sets, so a size restore must ask each one before it snaps a PTY back.
const liveTerminalStreamInstances = new Set<{ isWatching(sessionId: string): boolean }>();

/** A terminal input id as the streams read it: trimmed, at most 128 characters, or null. */
export function normalizeTerminalInputId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const inputId = value.trim();
  if (!inputId || inputId.length > TERMINAL_INPUT_ID_MAX_CHARS) return null;
  return inputId;
}

/** The services that own one project's terminals. */
export type SyncTerminalBackend = {
  ptyService: Pick<
    ReturnType<typeof createPtyService>,
    | "readTranscriptSnapshot"
    | "hasLivePty"
    | "getTranscriptWindow"
    | "readTranscriptRange"
    | "resizeBySessionId"
    | "restoreDesktopSizeBySessionId"
    | "writeBySessionId"
    | "readScreenSnapshot"
  >;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
};

/** A booted project's runtime, as far as terminal streaming needs it. */
export type SyncTerminalProjectRuntime = SyncTerminalBackend & {
  /** The runtime event buffer: `pty_data` and `pty_exit` arrive here. */
  eventBuffer: {
    subscribe(listener: (event: { category: string; payload: Record<string, unknown> }) => void): () => void;
  };
};

/**
 * Finds a project that is open on this machine by the id (or root) a peer
 * names. Never boots a project: null when it is not open.
 */
export type SyncTerminalProjectResolver = (target: {
  projectId: string;
  projectRootPath: string | null;
}) => Promise<SyncTerminalProjectRuntime | null>;

/** The terminal state each ingress keeps on its peer. */
export type SyncTerminalStreamPeer = {
  lifecycleGeneration: number;
  subscribedSessionIds: Set<string>;
  pendingTerminalSnapshots: Map<string, PendingTerminalSnapshotBarrier>;
  nextTerminalSnapshotGeneration: number;
};

/** Where a `terminal_*` envelope goes. */
export type SyncTerminalTarget =
  | { kind: "hosted" }
  | { kind: "project"; projectId: string; projectRootPath: string | null };

type TerminalInputDedupeLedger = {
  fingerprint(deviceId: string, sessionId: string, inputId: string): string | null;
  hasCapacity(): boolean;
  remember(
    deviceId: string,
    sessionId: string,
    inputId: string,
    dataFingerprint: string,
  ): "recorded" | "duplicate" | "capacity";
};

export type SyncTerminalStreamsContext<P extends SyncTerminalStreamPeer> = {
  logger: Logger;
  peers(): Iterable<P>;
  /** Authenticated, with an open socket. */
  isPeerReceiving(peer: P): boolean;
  /** The socket is open (authenticated or not). */
  isPeerSocketOpen(peer: P): boolean;
  /** Still the same live socket generation, and the ingress is not disposed. */
  isPeerLifecycleCurrent(peer: P, lifecycleGeneration: number): boolean;
  /** Still connected and authenticated (for queued input). */
  isPeerConnected(peer: P): boolean;
  isPeerBackpressured(peer: P): boolean;
  /** A reply the peer must get; false when it could not be sent. */
  sendRequired(peer: P, type: SyncEnvelope["type"], payload: unknown, requestId?: string | null): boolean;
  /** A live push the peer may miss under backpressure. */
  send(peer: P, type: SyncEnvelope["type"], payload: unknown): void;
  peerDeviceId(peer: P): string | null;
  closePeer(peer: P, code: number, reason: string): void;
  /** This ingress's own project, or null for the projectless ingress. */
  hostedBackend: SyncTerminalBackend | null;
  /** Other open projects of this machine. Without it, only hosted sessions stream. */
  resolveProject?: SyncTerminalProjectResolver;
  dedupeLedger: TerminalInputDedupeLedger;
  /** Log events keep the prefix each ingress used before this module. */
  logPrefix: "sync_host" | "sync_brain";
};

type RoutedTerminal = {
  /** The project id the peer named. Later envelopes for the session must match it. */
  projectId: string;
  backend: SyncTerminalBackend;
  stopEvents: () => void;
};

type SyncTerminalStreams<P extends SyncTerminalStreamPeer> = ReturnType<typeof createSyncTerminalStreams<P>>;

export function createSyncTerminalStreams<P extends SyncTerminalStreamPeer>(ctx: SyncTerminalStreamsContext<P>) {
  const routesByPeer = new WeakMap<P, Map<string, RoutedTerminal>>();
  /**
   * The project id a project subscribe named when it resolved to this host's
   * own runtime (no route). Later project envelopes must name the same id.
   * Each subscribe sets or clears it; `subscribedSessionIds` gates its use.
   */
  const hostedProjectIdsByPeer = new WeakMap<P, Map<string, string>>();
  const terminalInputOperationQueues = new Map<string, Promise<void>>();
  const logPrefix = ctx.logPrefix;
  const liveInstance = {
    isWatching(sessionId: string): boolean {
      for (const other of ctx.peers()) {
        if (other.subscribedSessionIds.has(sessionId) && ctx.isPeerSocketOpen(other)) return true;
      }
      return false;
    },
  };
  liveTerminalStreamInstances.add(liveInstance);

  function routeFor(peer: P, sessionId: string): RoutedTerminal | undefined {
    return routesByPeer.get(peer)?.get(sessionId);
  }

  function dropRoute(peer: P, sessionId: string): RoutedTerminal | undefined {
    const routes = routesByPeer.get(peer);
    const route = routes?.get(sessionId);
    if (!routes || !route) return undefined;
    routes.delete(sessionId);
    route.stopEvents();
    return route;
  }

  function backendFor(peer: P, sessionId: string): SyncTerminalBackend | null {
    return routeFor(peer, sessionId)?.backend ?? ctx.hostedBackend;
  }

  /**
   * The backend a `terminal_*` envelope may use, or null when it names a
   * project this session was not subscribed under on this peer.
   */
  function backendForTarget(peer: P, sessionId: string, target: SyncTerminalTarget): SyncTerminalBackend | null {
    const route = routeFor(peer, sessionId);
    if (target.kind === "hosted") return route ? null : ctx.hostedBackend;
    if (route) return route.projectId === target.projectId ? route.backend : null;
    // A project subscribe that resolved to this host's own runtime installs no
    // route; it recorded the project id it named.
    return peer.subscribedSessionIds.has(sessionId)
      && hostedProjectIdsByPeer.get(peer)?.get(sessionId) === target.projectId
      ? ctx.hostedBackend
      : null;
  }

  /**
   * Snap a PTY back to the desktop-preferred size once no connected peer is
   * still viewing it (mobile unsubscribe or disconnect). While another peer
   * remains subscribed the mobile size stays — that peer is still actively
   * driving the viewport.
   */
  function restoreDesktopTerminalSizeIfUnwatched(sessionId: string, backend: SyncTerminalBackend | null): void {
    // Each ingress in this process has its own peer set, so ask all of them.
    for (const instance of liveTerminalStreamInstances) {
      if (instance.isWatching(sessionId)) return;
    }
    if (!backend) return;
    try {
      backend.ptyService.restoreDesktopSizeBySessionId(sessionId);
    } catch (error) {
      ctx.logger.warn(`${logPrefix}.restore_desktop_terminal_size_failed`, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function isActiveTerminalSnapshotBarrier(
    peer: P,
    sessionId: string,
    barrier: PendingTerminalSnapshotBarrier,
    lifecycleGeneration: number,
  ): boolean {
    const currentBarrier = peer.pendingTerminalSnapshots.get(sessionId);
    return ctx.isPeerLifecycleCurrent(peer, lifecycleGeneration)
      && currentBarrier === barrier;
  }

  function failTerminalSnapshotBarrier(
    peer: P,
    sessionId: string,
    barrier: PendingTerminalSnapshotBarrier,
    reason: string,
  ): void {
    if (barrier.failed) return;
    barrier.failed = true;
    ctx.logger.warn(`${logPrefix}.terminal_snapshot_barrier_failed`, {
      sessionId,
      reason,
      captureAttempt: barrier.captureAttempt,
      queuedEvents: barrier.events.length,
      queuedBytes: barrier.queuedBytes,
      peerDeviceId: ctx.peerDeviceId(peer),
    });
    // Do not close the controller socket. A hot Claude TUI can overflow the
    // catch-up queue on LAN; tearing down sync blanks every other surface on
    // that phone. The subscribe loop sends the last captured snapshot instead.
  }

  function enqueueTerminalSnapshotEvent(
    peer: P,
    sessionId: string,
    event: PendingTerminalSnapshotEvent,
  ): boolean {
    const barrier = peer.pendingTerminalSnapshots.get(sessionId);
    if (!barrier) return false;
    if (barrier.failed) return true;

    const exceedsBudget = (): boolean => (
      barrier.events.length >= MAX_PENDING_TERMINAL_SNAPSHOT_EVENTS
      || barrier.queuedBytes + event.byteLength > MAX_PENDING_TERMINAL_SNAPSHOT_BYTES
    );
    if (exceedsBudget()) {
      // Numeric-offset data is durably represented by a fresh authoritative
      // transcript snapshot, so shed only those queued events and require the
      // next capture to cover their highest end offset. Offsetless data and
      // exits are not reconstructable and must remain explicitly queued.
      discardTrackedTerminalDataForRecapture(barrier);
    }
    if (exceedsBudget()) {
      if (event.kind === "data" && event.payload.offset != null) {
        requireFreshTerminalSnapshot(barrier, event.payload.offset);
        return true;
      }
      failTerminalSnapshotBarrier(peer, sessionId, barrier, "unreconstructable_queue_overflow");
      return true;
    }

    if (event.kind === "data" && event.payload.offset == null) {
      requireFreshTerminalSnapshot(barrier);
    }
    barrier.events.push(event);
    barrier.queuedBytes += event.byteLength;
    return true;
  }

  // --- Live output -----------------------------------------------------------

  function deliverData(peer: P, payload: SyncTerminalDataPayload): void {
    if (!ctx.isPeerReceiving(peer) || !peer.subscribedSessionIds.has(payload.sessionId)) return;
    if (enqueueTerminalSnapshotEvent(peer, payload.sessionId, {
      kind: "data",
      payload,
      byteLength: Buffer.byteLength(payload.data, "utf8"),
    })) return;
    if (ctx.isPeerBackpressured(peer)) return;
    ctx.send(peer, "terminal_data", payload);
  }

  function deliverExit(peer: P, payload: SyncTerminalExitPayload): void {
    if (!ctx.isPeerReceiving(peer) || !peer.subscribedSessionIds.has(payload.sessionId)) return;
    if (enqueueTerminalSnapshotEvent(peer, payload.sessionId, {
      kind: "exit",
      payload,
      byteLength: 0,
    })) return;
    if (ctx.isPeerBackpressured(peer)) return;
    ctx.send(peer, "terminal_exit", payload);
  }

  /**
   * Streams one routed session to one peer from its project's runtime events.
   * Installed in the same turn as the subscribe barrier, so output that
   * arrives while the snapshot is read queues behind it.
   */
  function installRoute(
    peer: P,
    sessionId: string,
    projectId: string,
    runtime: SyncTerminalProjectRuntime,
  ): void {
    dropRoute(peer, sessionId);
    const stopEvents = runtime.eventBuffer.subscribe((entry) => {
      if (entry.category !== "pty") return;
      const payload = entry.payload;
      if (payload?.type === "pty_data") {
        const event = payload.event as PtyDataEvent | undefined;
        if (event?.sessionId !== sessionId || typeof event.data !== "string") return;
        deliverData(peer, dataPayload(event));
      } else if (payload?.type === "pty_exit") {
        const event = payload.event as PtyExitEvent | undefined;
        if (event?.sessionId !== sessionId) return;
        deliverExit(peer, exitPayload(event));
      }
    });
    let routes = routesByPeer.get(peer);
    if (!routes) {
      routes = new Map();
      routesByPeer.set(peer, routes);
    }
    routes.set(sessionId, { projectId, backend: runtime, stopEvents });
  }

  // --- Subscribe -------------------------------------------------------------

  function sendSubscribeError(
    peer: P,
    sessionId: string,
    requestId: string | null | undefined,
    error: SyncTerminalSubscribeError,
  ): void {
    ctx.logger.warn(`${logPrefix}.terminal_subscribe_refused`, {
      sessionId,
      code: error.code,
      peerDeviceId: ctx.peerDeviceId(peer),
    });
    ctx.sendRequired(peer, "terminal_snapshot", {
      sessionId,
      transcript: "",
      status: null,
      runtimeState: null,
      lastOutputPreview: null,
      capturedAt: nowIso(),
      startOffset: null,
      endOffset: null,
      live: false,
      error,
    } satisfies SyncTerminalSnapshotPayload, requestId);
  }

  /**
   * The runtime a project target names, or the refusal to send. A target that
   * resolves to this ingress's own project is served as hosted.
   */
  async function resolveSubscribeTarget(
    sessionId: string,
    target: Extract<SyncTerminalTarget, { kind: "project" }>,
  ): Promise<
    | { kind: "hosted" }
    | { kind: "routed"; runtime: SyncTerminalProjectRuntime }
    | { kind: "refused"; error: SyncTerminalSubscribeError }
  > {
    const runtime = ctx.resolveProject ? await ctx.resolveProject(target) : null;
    if (!runtime) {
      return {
        kind: "refused",
        error: {
          code: "project_not_open",
          message: "This project is not open on that computer, or it is still opening. Open it there, then try again.",
        },
      };
    }
    // Checked for this host's own project too: a stale row must not open blank.
    if (!runtime.sessionService.get(sessionId)) {
      return {
        kind: "refused",
        error: {
          code: "session_not_found",
          message: "That computer has no terminal session with this id in this project.",
        },
      };
    }
    if (ctx.hostedBackend && runtime.ptyService === ctx.hostedBackend.ptyService) return { kind: "hosted" };
    return { kind: "routed", runtime };
  }

  async function subscribe(
    peer: P,
    envelope: ParsedSyncEnvelope,
    target: SyncTerminalTarget,
    lifecycleGeneration: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const payload = envelope.payload as Partial<SyncTerminalSubscribePayload> | null;
    const sessionId = toOptionalString(payload?.sessionId);
    if (!sessionId) return;
    let routedRuntime: SyncTerminalProjectRuntime | null = null;
    if (target.kind === "project") {
      const resolved = await resolveSubscribeTarget(sessionId, target);
      if (!ctx.isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      if (resolved.kind === "refused") {
        // A refused resubscribe must not keep an earlier stream or its input.
        const previousBackend = routeFor(peer, sessionId)?.backend
          ?? (peer.subscribedSessionIds.has(sessionId) ? ctx.hostedBackend : null);
        dropRoute(peer, sessionId);
        peer.subscribedSessionIds.delete(sessionId);
        clearTerminalSnapshotBarrier(peer.pendingTerminalSnapshots, sessionId);
        restoreDesktopTerminalSizeIfUnwatched(sessionId, previousBackend);
        sendSubscribeError(peer, sessionId, envelope.requestId, resolved.error);
        return;
      }
      if (resolved.kind === "routed") routedRuntime = resolved.runtime;
    }
    const backend: SyncTerminalBackend | null = routedRuntime ?? ctx.hostedBackend;
    if (!backend) return;
    const barrier: PendingTerminalSnapshotBarrier = {
      generation: ++peer.nextTerminalSnapshotGeneration,
      captureAttempt: 0,
      requiredCaptureAttempt: 0,
      requiredSnapshotEndOffset: null,
      events: [],
      queuedBytes: 0,
      failed: false,
    };
    peer.pendingTerminalSnapshots.set(sessionId, barrier);
    peer.subscribedSessionIds.add(sessionId);
    let hostedProjectIds = hostedProjectIdsByPeer.get(peer);
    if (!hostedProjectIds) {
      hostedProjectIds = new Map();
      hostedProjectIdsByPeer.set(peer, hostedProjectIds);
    }
    if (routedRuntime && target.kind === "project") {
      hostedProjectIds.delete(sessionId);
      installRoute(peer, sessionId, target.projectId, routedRuntime);
    } else {
      dropRoute(peer, sessionId);
      if (target.kind === "project") hostedProjectIds.set(sessionId, target.projectId);
      else hostedProjectIds.delete(sessionId);
    }
    const maxBytes = Math.max(1_024, Math.min(2_000_000, Math.floor(payload?.maxBytes ?? DEFAULT_TERMINAL_SNAPSHOT_BYTES)));
    const sinceOffset = typeof payload?.sinceOffset === "number" && Number.isInteger(payload.sinceOffset)
      ? payload.sinceOffset
      : null;
    let forceReplacement = false;
    let barrierCompleted = false;
    let lastCapturedTranscript: TerminalTranscriptSnapshot | null = null;
    const sendReplacingSnapshot = (
      session: TerminalSessionRow,
      transcriptSnapshot: TerminalTranscriptSnapshot | null,
    ): boolean => ctx.sendRequired(
      peer,
      "terminal_snapshot",
      replacingSnapshotPayload(backend, sessionId, session, transcriptSnapshot),
      envelope.requestId,
    );
    try {
      while (barrier.captureAttempt < MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS) {
        if (!isActiveTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)) break;
        if (barrier.failed) {
          if (sendReplacingSnapshot(backend.sessionService.get(sessionId), lastCapturedTranscript)) {
            barrierCompleted = true;
          }
          break;
        }
        barrier.captureAttempt += 1;
        const session = backend.sessionService.get(sessionId);
        const transcriptSnapshot = session
          ? await runWithAbortSignal(
              () => backend.ptyService.readTranscriptSnapshot({
                sessionId,
                maxBytes,
                alignStartToSafeBoundary: true,
              }),
              signal,
              "Sync operation aborted.",
            )
          : null;
        if (transcriptSnapshot) lastCapturedTranscript = transcriptSnapshot;
        if (!isActiveTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)) break;
        if (barrier.failed) {
          if (sendReplacingSnapshot(session, lastCapturedTranscript)) {
            barrierCompleted = true;
          }
          break;
        }

        const flush = planTerminalSnapshotFlush(
          barrier,
          transcriptSnapshot?.endOffset ?? null,
        );
        if (flush.needsRecapture) {
          forceReplacement = true;
          continue;
        }

        let snapshot: SyncTerminalSnapshotPayload | null = null;
        // Resume fast-path: the PTY snapshot is an exact logical suffix and
        // includes buffered live bytes beyond the flushed file. Slice that
        // authoritative suffix instead of re-reading the physical transcript,
        // otherwise a reconnect can silently miss output that arrived before
        // this subscription while the WriteStream was still draining.
        if (
          !forceReplacement
          && sinceOffset != null
          && transcriptSnapshot
          && sinceOffset >= transcriptSnapshot.startOffset
          // Equality has no delta to deliver. Send the replacing snapshot
          // below so a remounted controller cannot hydrate to an empty screen.
          && sinceOffset < transcriptSnapshot.endOffset
        ) {
          const snapshotBytes = Buffer.from(transcriptSnapshot.data, "utf8");
          const byteStart = sinceOffset - transcriptSnapshot.startOffset;
          const startsAtUtf8Boundary = byteStart >= 0
            && byteStart <= snapshotBytes.length
            && (byteStart === snapshotBytes.length || (snapshotBytes[byteStart]! & 0b1100_0000) !== 0b1000_0000);
          if (
            startsAtUtf8Boundary
            && snapshotBytes.length === transcriptSnapshot.endOffset - transcriptSnapshot.startOffset
          ) {
            snapshot = withTerminalScreen(backend, sessionId, {
              sessionId,
              transcript: snapshotBytes.subarray(byteStart).toString("utf8"),
              status: session?.status ?? null,
              runtimeState: session?.runtimeState ?? null,
              lastOutputPreview: session?.lastOutputPreview ?? null,
              capturedAt: nowIso(),
              startOffset: sinceOffset,
              endOffset: transcriptSnapshot.endOffset,
              delta: true,
              live: backend.ptyService.hasLivePty(sessionId),
            });
          }
        }
        snapshot ??= replacingSnapshotPayload(backend, sessionId, session, transcriptSnapshot);
        if (!ctx.sendRequired(peer, "terminal_snapshot", snapshot, envelope.requestId)) break;
        barrierCompleted = true;
        for (const event of flush.events) {
          const sent = event.kind === "data"
            ? ctx.sendRequired(peer, "terminal_data", event.payload)
            : ctx.sendRequired(peer, "terminal_exit", event.payload);
          if (!sent) {
            barrierCompleted = false;
            break;
          }
        }
        break;
      }
      if (
        !barrierCompleted
        && isActiveTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)
        && (barrier.failed || barrier.captureAttempt >= MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS)
      ) {
        failTerminalSnapshotBarrier(peer, sessionId, barrier, "capture_did_not_reach_stable_offset");
        if (sendReplacingSnapshot(backend.sessionService.get(sessionId), lastCapturedTranscript)) {
          barrierCompleted = true;
        }
      }
    } catch (error) {
      if (peer.pendingTerminalSnapshots.get(sessionId) === barrier) {
        peer.subscribedSessionIds.delete(sessionId);
        dropRoute(peer, sessionId);
        restoreDesktopTerminalSizeIfUnwatched(sessionId, backend);
      }
      throw error;
    } finally {
      clearTerminalSnapshotBarrier(peer.pendingTerminalSnapshots, sessionId, barrier);
    }
  }

  // --- Unsubscribe, history, resize --------------------------------------------

  function unsubscribe(peer: P, envelope: ParsedSyncEnvelope, target: SyncTerminalTarget): void {
    const payload = envelope.payload as { sessionId?: string } | null;
    const sessionId = toOptionalString(payload?.sessionId);
    if (!sessionId) return;
    const backend = backendForTarget(peer, sessionId, target);
    if (!backend) {
      ctx.logger.warn(`${logPrefix}.terminal_unsubscribe_scope_mismatch`, { sessionId });
      return;
    }
    clearTerminalSnapshotBarrier(peer.pendingTerminalSnapshots, sessionId);
    peer.subscribedSessionIds.delete(sessionId);
    dropRoute(peer, sessionId);
    restoreDesktopTerminalSizeIfUnwatched(sessionId, backend);
  }

  async function history(
    peer: P,
    envelope: ParsedSyncEnvelope,
    target: SyncTerminalTarget,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // Pull-to-load-older paging over the transcript file. Reuses the
    // terminal_input access gate: only a peer with a live subscribe for
    // the session may read its history.
    const payload = envelope.payload as { sessionId?: string; beforeOffset?: number; maxBytes?: number } | null;
    const sessionId = toOptionalString(payload?.sessionId);
    if (!sessionId) return;
    const beforeOffset = typeof payload?.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
      ? Math.max(0, Math.floor(payload.beforeOffset))
      : 0;
    const refused: SyncTerminalHistoryResponsePayload = {
      sessionId,
      data: "",
      startOffset: beforeOffset,
      endOffset: beforeOffset,
      atStart: true,
    };
    const backend = backendForTarget(peer, sessionId, target);
    const session = backend?.sessionService.get(sessionId) ?? null;
    if (!backend || !peer.subscribedSessionIds.has(sessionId) || !session) {
      ctx.logger.warn("sync.terminal_history_unsubscribed_session", { sessionId });
      ctx.sendRequired(peer, "terminal_history", refused, envelope.requestId);
      return;
    }
    const pageBytes = Math.max(
      MIN_TERMINAL_HISTORY_PAGE_BYTES,
      Math.min(
        MAX_TERMINAL_HISTORY_PAGE_BYTES,
        Math.floor(typeof payload?.maxBytes === "number" ? payload.maxBytes : DEFAULT_TERMINAL_HISTORY_PAGE_BYTES),
      ),
    );
    const transcriptWindow = backend.ptyService.getTranscriptWindow(sessionId);
    if (!transcriptWindow) {
      ctx.sendRequired(peer, "terminal_history", refused, envelope.requestId);
      return;
    }
    const endOffset = Math.max(
      transcriptWindow.startOffset,
      Math.min(beforeOffset, transcriptWindow.endOffset),
    );
    const requestedStartOffset = Math.max(transcriptWindow.startOffset, endOffset - pageBytes);
    const range = await runWithAbortSignal(
      () => backend.ptyService.readTranscriptRange({
        sessionId,
        startOffset: requestedStartOffset,
        endOffset,
        alignStartToSafeBoundary: true,
      }),
      signal,
      "Sync operation aborted.",
    );
    if (!range) {
      ctx.sendRequired(peer, "terminal_history", refused, envelope.requestId);
      return;
    }
    ctx.sendRequired(peer, "terminal_history", {
      sessionId,
      data: range.data,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      // Alignment can move the returned start past the retained base. The
      // unaligned/clamped request still tells the client whether any older
      // bytes exist; using the returned boundary causes an empty paging
      // loop after transcript rollover.
      atStart: requestedStartOffset <= transcriptWindow.startOffset,
    } satisfies SyncTerminalHistoryResponsePayload, envelope.requestId);
  }

  function resize(peer: P, envelope: ParsedSyncEnvelope, target: SyncTerminalTarget): void {
    // Mobile clients re-emit this whenever their visible viewport
    // changes (rotation, split view, dynamic font). We forward to the
    // active PTY so command-line apps re-flow correctly. Out-of-bound
    // values are clamped inside ptyService.
    const payload = envelope.payload as { sessionId?: string; cols?: number; rows?: number } | null;
    const sessionId = toOptionalString(payload?.sessionId);
    const cols = typeof payload?.cols === "number" ? Math.floor(payload.cols) : null;
    const rows = typeof payload?.rows === "number" ? Math.floor(payload.rows) : null;
    if (!sessionId || cols == null || rows == null) return;
    if (!peer.subscribedSessionIds.has(sessionId)) return;
    const backend = backendForTarget(peer, sessionId, target);
    if (!backend) return;
    // Tagged as mobile so the phone's viewport never becomes the
    // desktop-preferred size — it is restored when the phone detaches.
    backend.ptyService.resizeBySessionId(sessionId, cols, rows, { source: "mobile" });
  }

  // --- Input ---------------------------------------------------------------------

  /**
   * `target` is null when the ingress refused the envelope's project scope.
   */
  function handleInputEnvelope(peer: P, envelope: ParsedSyncEnvelope, target: SyncTerminalTarget | null): void {
    // Forward keystrokes / pasted text from an attached client into the active
    // PTY. An input id is exactly-once only for the same payload bytes; reusing
    // an id for different bytes is a protocol conflict, never a duplicate ACK.
    const payload = envelope.payload as Partial<SyncTerminalInputPayload> | null;
    const sessionId = toOptionalString(payload?.sessionId);
    const data = typeof payload?.data === "string" ? payload.data : null;
    const hasInputId = payload?.inputId != null;
    const inputId = normalizeTerminalInputId(payload?.inputId);
    const sendAck = (ack: SyncTerminalInputAckPayload): void => {
      try {
        if (ctx.sendRequired(peer, "terminal_input_ack", ack, envelope.requestId)) return;
        ctx.logger.warn("sync.terminal_input_ack_not_sent", {
          sessionId: ack.sessionId,
          inputId: ack.inputId ?? null,
          peerDeviceId: ctx.peerDeviceId(peer),
        });
      } catch (error) {
        ctx.logger.warn("sync.terminal_input_ack_send_failed", {
          sessionId: ack.sessionId,
          inputId: ack.inputId ?? null,
          peerDeviceId: ctx.peerDeviceId(peer),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const sendFailure = (
      code: Extract<SyncTerminalInputAckPayload, { ok: false }>["error"]["code"],
      message: string,
    ): void => {
      if (!hasInputId) return;
      const error = code === "not_subscribed"
        ? { code, message, retryable: true as const }
        : { code, message, retryable: false as const };
      sendAck({
        sessionId,
        ...(inputId ? { inputId } : {}),
        ok: false,
        duplicate: false,
        error,
      } satisfies SyncTerminalInputAckPayload);
    };
    if (hasInputId && !inputId) {
      ctx.logger.warn("sync.terminal_input_invalid_input_id", { sessionId });
      sendFailure("invalid_input_id", "Terminal input id must be a bounded non-empty string.");
      return;
    }
    // A routed session takes input only under the project it was subscribed
    // with; a hosted session only under this ingress's own project. A project
    // target with no route yet is a missing subscribe, checked below.
    const route = sessionId ? routeFor(peer, sessionId) : undefined;
    const scopeMatches = target !== null && (
      target.kind === "hosted"
        ? ctx.hostedBackend !== null && !route
        : !route || route.projectId === target.projectId
    );
    if (!scopeMatches) {
      sendFailure("project_mismatch", "Terminal input does not belong to this hosted project.");
      return;
    }
    if (!sessionId || data == null) {
      sendFailure("project_mismatch", "Terminal input is missing its session or data.");
      return;
    }
    const deviceId = ctx.peerDeviceId(peer);
    const dataFingerprint = inputId
      ? createHash("sha256").update(data, "utf8").digest("hex")
      : null;
    // Input with an id is deduplicated per device, session and id.
    const dedupe = inputId && deviceId && dataFingerprint
      ? { inputId, deviceId, dataFingerprint }
      : null;
    if (dedupe) {
      const recordedFingerprint = ctx.dedupeLedger.fingerprint(dedupe.deviceId, sessionId, dedupe.inputId);
      if (recordedFingerprint) {
        if (recordedFingerprint !== dedupe.dataFingerprint) {
          ctx.logger.warn("sync.terminal_input_id_conflict", {
            sessionId,
            peerDeviceId: dedupe.deviceId,
            inputId: dedupe.inputId,
          });
          sendFailure("input_id_conflict", "This terminal input id was already used for different data.");
          return;
        }
        sendAck({
          sessionId,
          inputId: dedupe.inputId,
          ok: true,
          duplicate: true,
        } satisfies SyncTerminalInputAckPayload);
        return;
      }
    }
    const backend = target ? backendForTarget(peer, sessionId, target) : null;
    if (!peer.subscribedSessionIds.has(sessionId) || !backend) {
      ctx.logger.warn("sync.terminal_input_unsubscribed_session", { sessionId });
      sendFailure("not_subscribed", "Subscribe to this terminal before sending input.");
      return;
    }
    const session = backend.sessionService.get(sessionId);
    if (!session) {
      ctx.logger.warn("sync.terminal_input_project_mismatch", { sessionId });
      sendFailure("project_mismatch", "This terminal belongs to a different hosted project.");
      return;
    }
    if (!backend.ptyService.hasLivePty(sessionId)) {
      ctx.logger.info("sync.terminal_input_no_active_pty", { sessionId });
      sendFailure("session_not_live", "This terminal session is no longer live.");
      return;
    }
    if (dedupe && !ctx.dedupeLedger.hasCapacity()) {
      sendFailure("dedupe_capacity", "Too many terminal inputs are awaiting retry-window expiry.");
      return;
    }
    const accepted = backend.ptyService.writeBySessionId(sessionId, data);
    if (!accepted) {
      ctx.logger.info("sync.terminal_input_no_active_pty", { sessionId });
      sendFailure("session_not_live", "This terminal session is no longer live.");
      return;
    }
    if (dedupe) {
      const remembered = ctx.dedupeLedger.remember(dedupe.deviceId, sessionId, dedupe.inputId, dedupe.dataFingerprint);
      if (remembered !== "recorded") {
        // Capacity and duplicate checks run synchronously before the PTY write,
        // so this indicates an internal contract violation. Close rather than
        // acknowledge an untracked write that a retry could duplicate.
        ctx.logger.warn("sync.terminal_input_receipt_failed", { sessionId, remembered });
        ctx.closePeer(peer, 4002, "Terminal input receipt failed");
        return;
      }
      sendAck({
        sessionId,
        inputId: dedupe.inputId,
        ok: true,
        duplicate: false,
      } satisfies SyncTerminalInputAckPayload);
    }
  }

  return {
    /** `terminal_subscribe`, `terminal_unsubscribe`, `terminal_history`, `terminal_resize`. */
    async handleEnvelope(
      peer: P,
      envelope: ParsedSyncEnvelope,
      target: SyncTerminalTarget,
      lifecycleGeneration: number,
      signal?: AbortSignal,
    ): Promise<void> {
      switch (envelope.type) {
        case "terminal_subscribe":
          await subscribe(peer, envelope, target, lifecycleGeneration, signal);
          return;
        case "terminal_unsubscribe":
          unsubscribe(peer, envelope, target);
          return;
        case "terminal_history":
          await history(peer, envelope, target, signal);
          return;
        case "terminal_resize":
          resize(peer, envelope, target);
          return;
        default:
          return;
      }
    },

    /**
     * `terminal_input`: operations with the same device, session and input id
     * run one at a time. `target` is null when the ingress refused the scope.
     */
    async handleInput(peer: P, envelope: ParsedSyncEnvelope, target: SyncTerminalTarget | null): Promise<void> {
      const payload = envelope.payload as Partial<SyncTerminalInputPayload> | null;
      const deviceId = ctx.peerDeviceId(peer);
      const sessionId = toOptionalString(payload?.sessionId);
      const inputId = normalizeTerminalInputId(payload?.inputId);
      if (!deviceId || !sessionId || !inputId) {
        handleInputEnvelope(peer, envelope, target);
        return;
      }
      const key = `${deviceId}\0${sessionId}\0${inputId}`;
      const prior = terminalInputOperationQueues.get(key) ?? Promise.resolve();
      const operation = prior.catch(() => {}).then(() => {
        if (!ctx.isPeerConnected(peer)) return;
        handleInputEnvelope(peer, envelope, target);
      });
      terminalInputOperationQueues.set(key, operation);
      try {
        await operation;
      } finally {
        if (terminalInputOperationQueues.get(key) === operation) {
          terminalInputOperationQueues.delete(key);
        }
      }
    },

    /** Output of this ingress's own project. Routed sessions stream from their runtime. */
    handlePtyData(event: PtyDataEvent): void {
      const payload = dataPayload(event);
      for (const peer of ctx.peers()) {
        if (routeFor(peer, event.sessionId)) continue;
        deliverData(peer, payload);
      }
    },

    handlePtyExit(event: PtyExitEvent): void {
      const payload = exitPayload(event);
      for (const peer of ctx.peers()) {
        if (routeFor(peer, event.sessionId)) continue;
        deliverExit(peer, payload);
      }
    },

    /**
     * A peer's socket closed and the peer left the ingress's peer set: stop
     * its routed streams and give each PTY back its desktop size.
     */
    releasePeer(peer: P): void {
      for (const sessionId of peer.subscribedSessionIds) {
        const backend = backendFor(peer, sessionId);
        dropRoute(peer, sessionId);
        restoreDesktopTerminalSizeIfUnwatched(sessionId, backend);
      }
    },

    /**
     * Stops every routed stream (the ingress is going away). Each watched PTY
     * outlives this ingress, so it gets its desktop size back.
     */
    releaseAll(): void {
      liveTerminalStreamInstances.delete(liveInstance);
      for (const peer of ctx.peers()) {
        for (const sessionId of peer.subscribedSessionIds) {
          const backend = dropRoute(peer, sessionId)?.backend ?? ctx.hostedBackend;
          restoreDesktopTerminalSizeIfUnwatched(sessionId, backend);
        }
        for (const sessionId of [...(routesByPeer.get(peer)?.keys() ?? [])]) dropRoute(peer, sessionId);
      }
    },
  };
}

/** Closes a socket and ignores a failure, because the socket may already be gone. */
export function closeSocketQuietly(
  ws: { close(code: number, reason: string): void },
  code: number,
  reason: string,
): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore close failures
  }
}
