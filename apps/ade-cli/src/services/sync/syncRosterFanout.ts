import type {
  SyncRosterDeltaPayload,
  SyncRosterProject,
  SyncRosterSnapshotPayload,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";

// All-projects roster (mobile hub) push cadence: trailing-edge debounce, hard
// max-wait cap so a steady event stream still flushes, and a slow safety poll
// that runs only while ≥1 peer is subscribed.
export const ROSTER_DEBOUNCE_MS = 250;
export const ROSTER_MAX_WAIT_MS = 1_000;
export const ROSTER_SAFETY_POLL_MS = 15_000;

// Remote commands that add/remove a roster-visible lane or chat row (possibly
// in a non-active project via projectId routing). A successful one nudges the
// coalesced roster flush; everything else relies on chat events + safety poll.
export const ROSTER_DIRTYING_COMMAND_ACTIONS: ReadonlySet<string> = new Set<string>([
  "chat.create",
  "work.startCliSession",
  "work.resumeCliSession",
  "lanes.create",
  "lanes.createChild",
  "lanes.archive",
  "lanes.delete",
]);

/**
 * Builds the machine-wide all-projects chat roster (mobile hub). Lives where
 * the project registry + project scope registry are both in scope (ade-cli
 * brain). Optional: a host without a roster provider (e.g. single-project
 * desktop) simply never answers `roster_subscribe`, so the phone falls back to
 * the project catalog with no cross-project chats.
 */
export type SyncRosterProvider = {
  buildSnapshot: () => Promise<SyncRosterProject[]>;
};

/** The per-socket roster state every ingress keeps on its peer record. */
export type SyncRosterPeerState = {
  rosterSubscribed: boolean;
  /** Monotonic per-peer seq; a snapshot starts a new epoch at its own seq. */
  rosterSeq: number;
  /** projectId → serialized project last delivered, for per-project deltas. */
  rosterBaseline: Map<string, string>;
};

export function createSyncRosterPeerState(): SyncRosterPeerState {
  return { rosterSubscribed: false, rosterSeq: 0, rosterBaseline: new Map() };
}

/**
 * The roster snapshot/delta contract, shared by the project sync host and the
 * brain fallback handler so a roster socket sees one wire regardless of which
 * ingress it landed on:
 *
 * - `roster_subscribe` → a full `roster_snapshot { seq, projects }`; the
 *   client adopts `seq` as its watermark.
 * - Later changes → `roster_delta { seq: lastSeq + 1, changed?, removed? }`
 *   with whole-project granularity. A peer with nothing changed gets no send
 *   and its seq does not advance, so a client-side gap always means loss.
 * - A delta that cannot be queued rolls its seq back and forces the next flush
 *   to re-snapshot that peer.
 */
export function createSyncRosterFanout<P extends SyncRosterPeerState>(args: {
  provider: SyncRosterProvider | null | undefined;
  /** Authenticated, open, roster-subscribed peers right now. */
  subscribers: () => P[];
  send: (
    peer: P,
    type: "roster_snapshot" | "roster_delta",
    payload: SyncRosterSnapshotPayload | SyncRosterDeltaPayload,
    requestId?: string | null,
  ) => boolean;
  isDisposed: () => boolean;
  logger: Pick<Logger, "warn">;
  /** Log event for a failed snapshot build; each ingress keeps its own prefix. */
  buildFailedLogEvent: string;
}) {
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyPollTimer: ReturnType<typeof setInterval> | null = null;
  let flushInFlight = false;

  function stopSafetyPoll(): void {
    if (!safetyPollTimer) return;
    clearInterval(safetyPollTimer);
    safetyPollTimer = null;
  }

  function clearFlushTimers(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function ensureSafetyPoll(): void {
    if (safetyPollTimer || args.isDisposed()) return;
    // While ≥1 peer is subscribed, a slow poll catches out-of-band on-disk
    // changes in un-booted projects (e.g. a direct `ade` CLI run elsewhere)
    // that emit no in-process event.
    safetyPollTimer = setInterval(() => {
      if (args.subscribers().length === 0) {
        stopSafetyPoll();
        return;
      }
      markDirty();
    }, ROSTER_SAFETY_POLL_MS);
    safetyPollTimer.unref?.();
  }

  // Coalesced recompute+push: trailing-edge debounce with a hard max-wait cap
  // so a steady stream of events still flushes at least once per cap.
  function markDirty(): void {
    if (args.isDisposed() || !args.provider) return;
    if (args.subscribers().length === 0) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, ROSTER_DEBOUNCE_MS);
    flushTimer.unref?.();
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        void flush();
      }, ROSTER_MAX_WAIT_MS);
      maxWaitTimer.unref?.();
    }
  }

  async function buildProjects(): Promise<SyncRosterProject[] | null> {
    if (!args.provider) return null;
    try {
      return await args.provider.buildSnapshot();
    } catch (error) {
      args.logger.warn(args.buildFailedLogEvent, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Send a full snapshot and (re)seed the peer's per-project baseline so the
  // next flush can diff against it. A snapshot resets the peer's seq epoch (the
  // client adopts snapshot.seq as its new watermark), so it is always safe.
  function sendSnapshot(
    peer: P,
    projects: SyncRosterProject[],
    requestId?: string | null,
  ): void {
    const seq = ++peer.rosterSeq;
    const sent = args.send(peer, "roster_snapshot", { seq, projects } satisfies SyncRosterSnapshotPayload, requestId);
    if (!sent) {
      // Backpressured/closed: drop the baseline so the next flush re-snapshots.
      peer.rosterBaseline.clear();
      return;
    }
    peer.rosterBaseline = new Map(projects.map((project) => [project.projectId, JSON.stringify(project)]));
  }

  async function flush(): Promise<void> {
    clearFlushTimers();
    if (args.isDisposed() || flushInFlight) return;
    const subscribers = args.subscribers();
    if (subscribers.length === 0) {
      stopSafetyPoll();
      return;
    }
    flushInFlight = true;
    try {
      const projects = await buildProjects();
      if (projects == null) return;
      const subscribersNow = args.subscribers();
      if (subscribersNow.length === 0) return;
      const serialized = new Map(projects.map((project) => [project.projectId, JSON.stringify(project)]));
      for (const peer of subscribersNow) {
        if (peer.rosterBaseline.size === 0) {
          // No baseline (fresh subscribe / prior drop) → full snapshot.
          sendSnapshot(peer, projects);
          continue;
        }
        const changed: SyncRosterProject[] = [];
        for (const project of projects) {
          if (peer.rosterBaseline.get(project.projectId) !== serialized.get(project.projectId)) {
            changed.push(project);
          }
        }
        const removed: string[] = [];
        for (const projectId of peer.rosterBaseline.keys()) {
          if (!serialized.has(projectId)) removed.push(projectId);
        }
        if (changed.length === 0 && removed.length === 0) {
          // Nothing changed for this peer: skip the send WITHOUT advancing its
          // seq, so its next delta still arrives as lastSeq+1 (no false gap).
          continue;
        }
        const seq = ++peer.rosterSeq;
        const delta: SyncRosterDeltaPayload = {
          seq,
          ...(changed.length > 0 ? { changed } : {}),
          ...(removed.length > 0 ? { removed } : {}),
        };
        const sent = args.send(peer, "roster_delta", delta);
        if (!sent) {
          // Backpressured: roll back the seq + force a fresh snapshot next flush.
          peer.rosterSeq -= 1;
          peer.rosterBaseline.clear();
          continue;
        }
        peer.rosterBaseline = new Map(serialized);
      }
    } finally {
      flushInFlight = false;
    }
  }

  return {
    enabled: Boolean(args.provider),
    markDirty,
    buildProjects,
    sendSnapshot,
    ensureSafetyPoll,
    /** `roster_subscribe`: silent without a provider (the phone falls back). */
    async subscribe(peer: P, requestId: string | null | undefined): Promise<void> {
      if (!args.provider) return;
      peer.rosterSubscribed = true;
      peer.rosterBaseline.clear();
      ensureSafetyPoll();
      const projects = await buildProjects();
      if (projects == null) return;
      sendSnapshot(peer, projects, requestId ?? null);
    },
    unsubscribe(peer: P): void {
      peer.rosterSubscribed = false;
      peer.rosterBaseline.clear();
      if (args.subscribers().length === 0) {
        stopSafetyPoll();
        clearFlushTimers();
      }
    },
    /** A subscribed peer left; stop the timers when it was the last one. */
    peerRemoved(): void {
      if (args.subscribers().length === 0) {
        stopSafetyPoll();
        clearFlushTimers();
      }
    },
    dispose(): void {
      stopSafetyPoll();
      clearFlushTimers();
    },
  };
}

export type SyncRosterFanout<P extends SyncRosterPeerState> = ReturnType<typeof createSyncRosterFanout<P>>;
