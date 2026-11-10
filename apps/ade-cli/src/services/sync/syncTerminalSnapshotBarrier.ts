import { nowIso } from "../../../../desktop/src/main/services/shared/utils";
import type {
  PtyDataEvent,
  PtyExitEvent,
  SyncTerminalDataPayload,
  SyncTerminalExitPayload,
  SyncTerminalScreenSnapshot,
  SyncTerminalSnapshotPayload,
} from "../../../../desktop/src/shared/types";
import type { SyncTerminalBackend } from "./syncTerminalStreams";

// The pure snapshot barrier: queued live output, the flush plan that merges
// it with a transcript snapshot, and the snapshot payloads. It sends nothing
// and logs nothing; the terminal streams own the peers and the sends.

const MAX_TERMINAL_SCREEN_SERIALIZED_CHARS = 256_000;

export type TerminalTranscriptSnapshot = {
  data: string;
  startOffset: number | null;
  endOffset: number | null;
};

export type TerminalSessionRow = ReturnType<SyncTerminalBackend["sessionService"]["get"]>;

/** Drops the barrier of a session; with `barrier`, only when it is still the current one. */
export function clearTerminalSnapshotBarrier(
  barriers: Map<string, PendingTerminalSnapshotBarrier>,
  sessionId: string,
  barrier?: PendingTerminalSnapshotBarrier,
): void {
  if (barrier && barriers.get(sessionId) !== barrier) return;
  barriers.delete(sessionId);
}

function readTerminalScreenSnapshot(
  backend: SyncTerminalBackend,
  sessionId: string,
): SyncTerminalScreenSnapshot | null {
  const screen = backend.ptyService.readScreenSnapshot?.(sessionId) ?? null;
  if (!screen?.serialized) return null;
  if (screen.serialized.length > MAX_TERMINAL_SCREEN_SERIALIZED_CHARS) return null;
  if (!Number.isFinite(screen.cols) || !Number.isFinite(screen.rows)) return null;
  if (screen.cols < 1 || screen.rows < 1) return null;
  return {
    cols: Math.floor(screen.cols),
    rows: Math.floor(screen.rows),
    bufferType: screen.bufferType === "alternate" ? "alternate" : "normal",
    serialized: screen.serialized,
  };
}

export function withTerminalScreen(
  backend: SyncTerminalBackend,
  sessionId: string,
  snapshot: SyncTerminalSnapshotPayload,
): SyncTerminalSnapshotPayload {
  if (snapshot.delta === true) return snapshot;
  const screen = readTerminalScreenSnapshot(backend, sessionId);
  return screen ? { ...snapshot, screen } : snapshot;
}

/** A full snapshot that replaces the peer's view of the session. */
export function replacingSnapshotPayload(
  backend: SyncTerminalBackend,
  sessionId: string,
  session: TerminalSessionRow,
  transcript: TerminalTranscriptSnapshot | null,
): SyncTerminalSnapshotPayload {
  return withTerminalScreen(backend, sessionId, {
    sessionId,
    transcript: transcript?.data ?? "",
    status: session?.status ?? null,
    runtimeState: session?.runtimeState ?? null,
    lastOutputPreview: session?.lastOutputPreview ?? null,
    capturedAt: nowIso(),
    startOffset: transcript?.startOffset ?? null,
    endOffset: transcript?.endOffset ?? null,
    live: backend.ptyService.hasLivePty(sessionId),
  });
}

export function dataPayload(event: PtyDataEvent): SyncTerminalDataPayload {
  return {
    sessionId: event.sessionId,
    ptyId: event.ptyId,
    data: event.data,
    at: nowIso(),
    offset: event.offset ?? null,
  };
}

export function exitPayload(event: PtyExitEvent): SyncTerminalExitPayload {
  return {
    sessionId: event.sessionId,
    ptyId: event.ptyId,
    exitCode: event.exitCode,
    at: nowIso(),
  };
}

export const MAX_PENDING_TERMINAL_SNAPSHOT_EVENTS = 256;
export const MAX_PENDING_TERMINAL_SNAPSHOT_BYTES = 2_000_000;

export type PendingTerminalSnapshotEvent =
  | {
      kind: "data";
      payload: SyncTerminalDataPayload;
      byteLength: number;
    }
  | {
      kind: "exit";
      payload: SyncTerminalExitPayload;
      byteLength: 0;
    };

export type PendingTerminalSnapshotBarrier = {
  generation: number;
  captureAttempt: number;
  requiredCaptureAttempt: number;
  requiredSnapshotEndOffset: number | null;
  events: PendingTerminalSnapshotEvent[];
  queuedBytes: number;
  failed: boolean;
};

export function requireFreshTerminalSnapshot(
  barrier: PendingTerminalSnapshotBarrier,
  endOffset?: number | null,
): void {
  barrier.requiredCaptureAttempt = Math.max(
    barrier.requiredCaptureAttempt,
    barrier.captureAttempt + 1,
  );
  if (typeof endOffset === "number" && Number.isSafeInteger(endOffset) && endOffset >= 0) {
    barrier.requiredSnapshotEndOffset = Math.max(
      barrier.requiredSnapshotEndOffset ?? 0,
      endOffset,
    );
  }
}

export function discardTrackedTerminalDataForRecapture(barrier: PendingTerminalSnapshotBarrier): void {
  const retained: PendingTerminalSnapshotEvent[] = [];
  let queuedBytes = 0;
  for (const event of barrier.events) {
    if (event.kind === "data" && event.payload.offset != null) {
      requireFreshTerminalSnapshot(barrier, event.payload.offset);
      continue;
    }
    retained.push(event);
    queuedBytes += event.byteLength;
  }
  barrier.events = retained;
  barrier.queuedBytes = queuedBytes;
}

export function planTerminalSnapshotFlush(
  barrier: PendingTerminalSnapshotBarrier,
  snapshotEndOffset: number | null,
): { needsRecapture: boolean; events: PendingTerminalSnapshotEvent[] } {
  if (
    barrier.requiredCaptureAttempt > barrier.captureAttempt
    || (
      barrier.requiredSnapshotEndOffset != null
      && (snapshotEndOffset == null || snapshotEndOffset < barrier.requiredSnapshotEndOffset)
    )
  ) {
    return { needsRecapture: true, events: [] };
  }

  // A snapshot with no end offset cannot order the queued output: send it as queued.
  if (snapshotEndOffset == null) {
    return { needsRecapture: false, events: [...barrier.events] };
  }
  const recapture = (endOffset: number) => {
    requireFreshTerminalSnapshot(barrier, endOffset);
    discardTrackedTerminalDataForRecapture(barrier);
    return { needsRecapture: true, events: [] };
  };

  const planned: PendingTerminalSnapshotEvent[] = [];
  let watermark = snapshotEndOffset;
  let offsetsAreContinuous = true;
  for (const event of barrier.events) {
    if (event.kind === "exit") {
      planned.push(event);
      continue;
    }
    const endOffset = event.payload.offset;
    const bytes = Buffer.from(event.payload.data, "utf8");
    if (
      !offsetsAreContinuous
      || endOffset == null
      || !Number.isSafeInteger(endOffset)
      || endOffset < bytes.length
    ) {
      planned.push(event);
      offsetsAreContinuous = false;
      continue;
    }
    const startOffset = endOffset - bytes.length;
    if (endOffset <= watermark) {
      continue;
    }
    if (startOffset > watermark) {
      return recapture(endOffset);
    }
    const overlapBytes = watermark - startOffset;
    if (
      overlapBytes > 0
      && overlapBytes < bytes.length
      && (bytes[overlapBytes]! & 0b1100_0000) === 0b1000_0000
    ) {
      return recapture(endOffset);
    }
    const suffix = overlapBytes === 0 ? bytes : bytes.subarray(overlapBytes);
    planned.push({
      ...event,
      payload: {
        ...event.payload,
        data: suffix.toString("utf8"),
      },
      byteLength: suffix.length,
    });
    watermark = endOffset;
  }
  return { needsRecapture: false, events: planned };
}
