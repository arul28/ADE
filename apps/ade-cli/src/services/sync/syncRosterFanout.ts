import {
  SYNC_ROSTER_CHAT_PAGE_DEFAULT,
  SYNC_ROSTER_CHAT_PAGE_MAX,
} from "../../../../desktop/src/shared/types";
import type {
  SyncRosterChat,
  SyncRosterChatsPayload,
  SyncRosterDeltaPayload,
  SyncRosterProject,
  SyncRosterProjectPatch,
  SyncRosterSnapshotPayload,
} from "../../../../desktop/src/shared/types";
import { createHash } from "node:crypto";
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
  /** projectId → digests of the project last delivered, for deltas. */
  rosterBaseline: Map<string, RosterProjectDigest>;
  /** A partial first snapshot holds this peer's deltas until this time. */
  rosterHoldUntilMs?: number;
};

/** Chats per project in a partial first snapshot (the rest follow). */
export const ROSTER_PRIORITY_SNAPSHOT_CHATS = 30;
/** How long after a partial snapshot the rest of the roster follows. */
export const ROSTER_PRIORITY_REST_DELAY_MS = 3_000;
/** A page request reuses a roster built this recently. */
export const ROSTER_CHAT_PAGE_REUSE_MS = 1_000;

/**
 * A project as a partial first snapshot (and a paged roster) carries it: every
 * chat a client shows in a column other than Done (running, waiting for input,
 * failed, snoozed, or with a scheduled wake), every pinned chat, then the most
 * recent others up to the cap, plus the parent of any chat kept (so a subagent
 * never shows without its parent), in the project's own order. So every chat
 * left out is a Done chat, and a client can count them from `chatTotal`.
 * Counts and lanes are unchanged.
 */
export function priorityRosterProject(project: SyncRosterProject, cap = ROSTER_PRIORITY_SNAPSHOT_CHATS): SyncRosterProject {
  if (project.chats.length <= cap) return project;
  const keep = new Set<string>();
  for (const chat of project.chats) {
    if (
      chat.status === "running"
      || chat.status === "awaiting"
      || chat.status === "failed"
      || chat.pinned
      || chat.awaitingInput
      || chat.snoozedUntil
      || chat.snoozedAt
      || chat.nextWakeAt
    ) {
      keep.add(chat.id);
    }
  }
  const byRecency = [...project.chats].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  for (const chat of byRecency) {
    if (keep.size >= cap) break;
    keep.add(chat.id);
  }
  const byId = new Map(project.chats.map((chat) => [chat.id, chat]));
  for (const id of [...keep]) {
    let parentId = byId.get(id)?.chatSessionId ?? byId.get(id)?.orchestrationParentSessionId ?? null;
    let guard = 0;
    while (parentId && byId.has(parentId) && !keep.has(parentId) && guard < 8) {
      keep.add(parentId);
      parentId = byId.get(parentId)?.chatSessionId ?? byId.get(parentId)?.orchestrationParentSessionId ?? null;
      guard += 1;
    }
  }
  return { ...project, chats: project.chats.filter((chat) => keep.has(chat.id)) };
}

/**
 * A project as a paged roster carries it (`rosterChatPagesV1`): the head rows
 * of `priorityRosterProject`, and `chatTotal`, so the client knows how many
 * `roster_chats_request` can still return.
 */
const pagedRosterProjects = new WeakMap<SyncRosterProject, SyncRosterProject>();

export function pagedRosterProject(project: SyncRosterProject): SyncRosterProject {
  const known = pagedRosterProjects.get(project);
  if (known) return known;
  const paged = { ...priorityRosterProject(project), chatTotal: project.chats.length };
  pagedRosterProjects.set(project, paged);
  return paged;
}

/** Most recent first; ties by id, so a page cursor names one place. */
function compareChatRecency(
  left: { lastActivityAt?: string | null; id: string },
  right: { lastActivityAt?: string | null; id: string },
): number {
  const byTime = (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

/**
 * One `roster_chats_request` answer from a built roster: the chats the head
 * rows leave out, most recent first, after `before`; or the chats named by
 * `ids`. A page also carries the parents of its rows that are not head rows,
 * so a subagent does not show without its parent.
 */
export function rosterChatsPage(
  projects: SyncRosterProject[],
  request: { projectId?: unknown; before?: unknown; ids?: unknown; limit?: unknown } | null | undefined,
): SyncRosterChatsPayload {
  const projectId = typeof request?.projectId === "string" ? request.projectId.trim() : "";
  const project = projectId ? projects.find((entry) => entry.projectId === projectId) : undefined;
  if (!project) return { projectId, chats: [], hasMore: false, total: 0 };
  const total = project.chats.length;
  if (Array.isArray(request?.ids)) {
    const wanted = new Set(
      request.ids
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .slice(0, SYNC_ROSTER_CHAT_PAGE_MAX)
        .map((id) => id.trim()),
    );
    return { projectId, chats: project.chats.filter((chat) => wanted.has(chat.id)), hasMore: false, total };
  }
  const limitValue = typeof request?.limit === "number" && Number.isFinite(request.limit) ? Math.floor(request.limit) : SYNC_ROSTER_CHAT_PAGE_DEFAULT;
  const limit = Math.min(SYNC_ROSTER_CHAT_PAGE_MAX, Math.max(1, limitValue));
  const headIds = new Set(priorityRosterProject(project).chats.map((chat) => chat.id));
  const rest = project.chats.filter((chat) => !headIds.has(chat.id)).sort(compareChatRecency);
  const before = request?.before && typeof request.before === "object"
    ? request.before as { lastActivityAt?: unknown; id?: unknown }
    : null;
  let start = 0;
  if (before && typeof before.id === "string") {
    const cursor = {
      id: before.id,
      lastActivityAt: typeof before.lastActivityAt === "string" ? before.lastActivityAt : null,
    };
    start = rest.findIndex((chat) => compareChatRecency(chat, cursor) > 0);
    if (start < 0) start = rest.length;
  }
  const page = rest.slice(start, start + limit);
  const pageIds = new Set(page.map((chat) => chat.id));
  const byId = new Map(project.chats.map((chat) => [chat.id, chat]));
  const parents: SyncRosterChat[] = [];
  for (const chat of page) {
    let parentId = chat.chatSessionId ?? chat.orchestrationParentSessionId ?? null;
    let guard = 0;
    while (parentId && !headIds.has(parentId) && !pageIds.has(parentId) && guard < 8) {
      const parent = byId.get(parentId);
      if (!parent) break;
      parents.push(parent);
      pageIds.add(parentId);
      parentId = parent.chatSessionId ?? parent.orchestrationParentSessionId ?? null;
      guard += 1;
    }
  }
  const hasMore = start + limit < rest.length;
  const last = page.at(-1);
  return {
    projectId,
    chats: [...page, ...parents],
    hasMore,
    ...(hasMore && last ? { next: { lastActivityAt: last.lastActivityAt ?? null, id: last.id } } : {}),
    total,
  };
}

/**
 * What a client holds of one project, as digests: the whole project, its
 * head (every field but `chats`), each chat row, and the chat order.
 */
export type RosterProjectDigest = {
  digest: string;
  head: string;
  chats: Map<string, string>;
  order: string;
};

// Roster resume. A snapshot's seq is the start of an epoch drawn from a
// process-wide counter with a random start, and the epoch's deltas count up
// inside its span, so one seq names exactly one delivered roster state on this
// brain. The baseline behind every seq a client was last sent is kept for a
// while after its socket closes; a client that comes back with that seq as
// `sinceSeq` gets a delta against it (only the projects that changed, or an
// empty delta) instead of the whole roster again. Any seq the brain does not
// hold (restart, expiry, another device, an older brain's seq) gets a full
// snapshot, exactly as before. Older clients send no `sinceSeq` after a
// reconnect and never see a difference.
export const ROSTER_SEQ_EPOCH_SPAN = 2 ** 20;
export const ROSTER_RESUME_TTL_MS = 60 * 60 * 1000;
export const ROSTER_RESUME_MAX_ENTRIES = 32;
let rosterSeqEpoch = 1 + Math.floor(Math.random() * 2 ** 30);
type RosterResumeEntry = { identity: string; baseline: Map<string, RosterProjectDigest>; savedAtMs: number };
const rosterResumeBySeq = new Map<number, RosterResumeEntry>();

/**
 * The resume identity of an authenticated peer: its device id and socket role
 * (a phone's primary socket and its roster socket each keep their own seq).
 */
export function rosterResumeIdentity(
  authenticated: boolean,
  metadata: { deviceId?: string | null; syncRole?: string | null } | null | undefined,
): string | null {
  const deviceId = typeof metadata?.deviceId === "string" ? metadata.deviceId.trim() : "";
  if (!authenticated || !deviceId) return null;
  return `${deviceId}\u0000${metadata?.syncRole === "roster" ? "roster" : "primary"}`;
}

function nextRosterEpochSeq(): number {
  rosterSeqEpoch += 1;
  // Keep every seq inside Number.MAX_SAFE_INTEGER (and a Swift Int).
  if (rosterSeqEpoch >= 2 ** 32) rosterSeqEpoch = 1;
  return rosterSeqEpoch * ROSTER_SEQ_EPOCH_SPAN;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("base64");
}

function rosterProjectHead(project: SyncRosterProject): Omit<SyncRosterProject, "chats"> {
  const { chats: _chats, ...head } = project;
  return head;
}

// A roster project object is never changed after it is built, and the builder
// returns the same object for a project that did not change, so its digest
// (and its paged copy) are computed once per object.
const rosterProjectDigests = new WeakMap<SyncRosterProject, RosterProjectDigest>();

function digestRosterProject(project: SyncRosterProject): RosterProjectDigest {
  const known = rosterProjectDigests.get(project);
  if (known) return known;
  const digest = computeRosterProjectDigest(project);
  rosterProjectDigests.set(project, digest);
  return digest;
}

function computeRosterProjectDigest(project: SyncRosterProject): RosterProjectDigest {
  const chats = new Map<string, string>();
  for (const chat of project.chats) chats.set(chat.id, sha1(JSON.stringify(chat)));
  const head = sha1(JSON.stringify(rosterProjectHead(project)));
  const order = sha1(project.chats.map((chat) => chat.id).join("\n"));
  return { digest: sha1(`${head}|${order}|${[...chats.values()].join("|")}`), head, chats, order };
}

/**
 * The per-chat patch that turns `base` into `project`, or null when the whole
 * project is the smaller send (most of its chats changed).
 */
function rosterProjectPatch(
  project: SyncRosterProject,
  base: RosterProjectDigest,
  next: RosterProjectDigest,
): SyncRosterProjectPatch | null {
  const chats: SyncRosterChat[] = [];
  for (const chat of project.chats) {
    if (base.chats.get(chat.id) !== next.chats.get(chat.id)) chats.push(chat);
  }
  const removedChatIds: string[] = [];
  for (const chatId of base.chats.keys()) {
    if (!next.chats.has(chatId)) removedChatIds.push(chatId);
  }
  if (chats.length * 2 > project.chats.length && project.chats.length > 8) return null;
  return {
    projectId: project.projectId,
    ...(base.head !== next.head ? { head: rosterProjectHead(project) } : {}),
    ...(chats.length > 0 ? { chats } : {}),
    ...(removedChatIds.length > 0 ? { removedChatIds } : {}),
    ...(base.order !== next.order ? { order: project.chats.map((chat) => chat.id) } : {}),
  };
}

function rememberRosterResume(previousSeq: number | null, seq: number, identity: string | null, baseline: Map<string, RosterProjectDigest>): void {
  if (previousSeq != null) rosterResumeBySeq.delete(previousSeq);
  if (!identity) return;
  rosterResumeBySeq.set(seq, { identity, baseline, savedAtMs: Date.now() });
  if (rosterResumeBySeq.size <= ROSTER_RESUME_MAX_ENTRIES) return;
  // Map order is insertion order: the first entries are the oldest.
  for (const key of rosterResumeBySeq.keys()) {
    rosterResumeBySeq.delete(key);
    if (rosterResumeBySeq.size <= ROSTER_RESUME_MAX_ENTRIES) break;
  }
}

function takeRosterResume(sinceSeq: unknown, identity: string | null): Map<string, RosterProjectDigest> | null {
  if (!identity || typeof sinceSeq !== "number" || !Number.isSafeInteger(sinceSeq)) return null;
  const entry = rosterResumeBySeq.get(sinceSeq);
  if (!entry || entry.identity !== identity) return null;
  rosterResumeBySeq.delete(sinceSeq);
  if (Date.now() - entry.savedAtMs > ROSTER_RESUME_TTL_MS) return null;
  return entry.baseline;
}

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
 * - Later changes → `roster_delta { seq: lastSeq + 1, changed?, removed?,
 *   patched? }`: whole projects for most clients, per-chat patches for a
 *   client that declared `SYNC_ROSTER_CHAT_DELTA_CAPABILITY` (one streaming
 *   chat no longer resends a 1,000-chat project). A peer with nothing changed gets no send
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
  /**
   * Stable identity of the authenticated client behind a peer (its device id
   * and socket role), or null. Only a client with the same identity can resume
   * a seq; without it every subscribe gets a full snapshot.
   */
  resumeIdentity?: (peer: P) => string | null;
  /** The peer applies `roster_delta.patched` (`SYNC_ROSTER_CHAT_DELTA_CAPABILITY`). */
  acceptsChatPatches?: (peer: P) => boolean;
  /** The peer accepts a partial first snapshot (`SYNC_ROSTER_PRIORITY_SNAPSHOT_CAPABILITY`). */
  acceptsPrioritySnapshot?: (peer: P) => boolean;
  /** The peer takes head rows and pages the rest (`SYNC_ROSTER_CHAT_PAGES_CAPABILITY`). */
  acceptsChatPages?: (peer: P) => boolean;
}) {
  const resumeIdentity = (peer: P): string | null => args.resumeIdentity?.(peer) ?? null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyPollTimer: ReturnType<typeof setInterval> | null = null;
  let flushInFlight = false;
  // A flush that fired while another was building: it may carry a change the
  // in-flight build already missed, so one more flush runs when it ends.
  let flushRequestedInFlight = false;
  // The last roster built, so a page request right after a flush or a
  // subscribe does not build it again.
  let lastBuild: { atMs: number; projects: SyncRosterProject[] } | null = null;

  /** The roster one peer sees: whole projects, or head rows (`rosterChatPagesV1`). */
  type RosterView = { projects: SyncRosterProject[]; digests: Map<string, RosterProjectDigest> };
  function rosterViews(projects: SyncRosterProject[]): { full: () => RosterView; paged: () => RosterView } {
    let full: RosterView | null = null;
    let paged: RosterView | null = null;
    return {
      full: () => (full ??= { projects, digests: digestRosterProjects(projects) }),
      paged: () => {
        if (paged) return paged;
        const pagedProjects = projects.map(pagedRosterProject);
        paged = { projects: pagedProjects, digests: digestRosterProjects(pagedProjects) };
        return paged;
      },
    };
  }
  const viewFor = (peer: P, views: ReturnType<typeof rosterViews>): RosterView =>
    args.acceptsChatPages?.(peer) === true ? views.paged() : views.full();

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
      const projects = await args.provider.buildSnapshot();
      lastBuild = { atMs: Date.now(), projects };
      return projects;
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
    digests?: Map<string, RosterProjectDigest>,
    partial = false,
  ): void {
    const previousSeq = peer.rosterSeq > 0 ? peer.rosterSeq : null;
    const seq = nextRosterEpochSeq();
    peer.rosterSeq = seq;
    const sent = args.send(
      peer,
      "roster_snapshot",
      { seq, projects, ...(partial ? { partial: true as const } : {}) } satisfies SyncRosterSnapshotPayload,
      requestId,
    );
    if (!sent) {
      // Backpressured/closed: drop the baseline so the next flush re-snapshots.
      peer.rosterBaseline = new Map();
      rememberRosterResume(previousSeq, seq, null, peer.rosterBaseline);
      return;
    }
    peer.rosterBaseline = digests ?? digestRosterProjects(projects);
    rememberRosterResume(previousSeq, seq, resumeIdentity(peer), peer.rosterBaseline);
  }

  function digestRosterProjects(projects: SyncRosterProject[]): Map<string, RosterProjectDigest> {
    return new Map(projects.map((project) => [project.projectId, digestRosterProject(project)]));
  }

  /**
   * Send `peer` what changed since its baseline, as `roster_delta` at
   * `rosterSeq + 1`. `always` sends an empty delta when nothing changed (a
   * resumed subscribe must answer, so the client knows the feed is live);
   * otherwise a peer with nothing changed gets no send and keeps its seq.
   */
  function sendDelta(peer: P, projects: SyncRosterProject[], digests: Map<string, RosterProjectDigest>, always: boolean): void {
    const changed: SyncRosterProject[] = [];
    const patched: SyncRosterProjectPatch[] = [];
    const patches = args.acceptsChatPatches?.(peer) === true;
    for (const project of projects) {
      const base = peer.rosterBaseline.get(project.projectId);
      const next = digests.get(project.projectId)!;
      if (base?.digest === next.digest) continue;
      const patch = patches && base ? rosterProjectPatch(project, base, next) : null;
      if (patch) patched.push(patch);
      else changed.push(project);
    }
    const removed: string[] = [];
    for (const projectId of peer.rosterBaseline.keys()) {
      if (!digests.has(projectId)) removed.push(projectId);
    }
    if (changed.length === 0 && patched.length === 0 && removed.length === 0 && !always) {
      // Nothing changed for this peer: skip the send WITHOUT advancing its
      // seq, so its next delta still arrives as lastSeq+1 (no false gap).
      return;
    }
    if ((peer.rosterSeq + 1) % ROSTER_SEQ_EPOCH_SPAN === 0) {
      // The epoch's span is used up; a new epoch starts with a snapshot.
      sendSnapshot(peer, projects, null, digests);
      return;
    }
    const previousSeq = peer.rosterSeq;
    const seq = previousSeq + 1;
    const delta: SyncRosterDeltaPayload = {
      seq,
      ...(changed.length > 0 ? { changed } : {}),
      ...(removed.length > 0 ? { removed } : {}),
      ...(patched.length > 0 ? { patched } : {}),
    };
    const sent = args.send(peer, "roster_delta", delta);
    if (!sent) {
      // Backpressured: force a fresh snapshot next flush.
      peer.rosterBaseline = new Map();
      rememberRosterResume(previousSeq, previousSeq, null, peer.rosterBaseline);
      return;
    }
    peer.rosterSeq = seq;
    peer.rosterBaseline = digests;
    rememberRosterResume(previousSeq, seq, resumeIdentity(peer), digests);
  }

  async function flush(): Promise<void> {
    clearFlushTimers();
    if (args.isDisposed()) return;
    if (flushInFlight) {
      flushRequestedInFlight = true;
      return;
    }
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
      const views = rosterViews(projects);
      const nowMs = Date.now();
      for (const peer of subscribersNow) {
        // The rest of a partial first snapshot waits until its hold ends.
        if ((peer.rosterHoldUntilMs ?? 0) > nowMs) continue;
        const view = viewFor(peer, views);
        if (peer.rosterBaseline.size === 0) {
          // No baseline (fresh subscribe / prior drop) → full snapshot.
          sendSnapshot(peer, view.projects, null, view.digests);
          continue;
        }
        sendDelta(peer, view.projects, view.digests, false);
      }
    } finally {
      flushInFlight = false;
      if (flushRequestedInFlight) {
        flushRequestedInFlight = false;
        // Re-armed through the debounce: one follow-up per missed request,
        // never a loop (a later request only comes from a new dirty mark).
        markDirty();
      }
    }
  }

  return {
    enabled: Boolean(args.provider),
    markDirty,
    buildProjects,
    sendSnapshot,
    ensureSafetyPoll,
    /**
     * `roster_subscribe`: silent without a provider (the phone falls back).
     * A `sinceSeq` this brain still holds for the same client resumes with a
     * delta; anything else gets a full snapshot.
     */
    async subscribe(peer: P, requestId: string | null | undefined, sinceSeq?: unknown): Promise<void> {
      if (!args.provider) return;
      peer.rosterSubscribed = true;
      peer.rosterBaseline = new Map();
      ensureSafetyPoll();
      // A seq another live socket still extends cannot be resumed here: both
      // would write the same next seq with different baselines.
      const seqInUse = args.subscribers().some((other) => other !== peer && other.rosterSeq === sinceSeq);
      const resumeBaseline = seqInUse ? null : takeRosterResume(sinceSeq, resumeIdentity(peer));
      const projects = await buildProjects();
      if (projects == null) return;
      const views = rosterViews(projects);
      if (resumeBaseline && resumeBaseline.size > 0) {
        const view = viewFor(peer, views);
        peer.rosterSeq = sinceSeq as number;
        peer.rosterBaseline = resumeBaseline;
        sendDelta(peer, view.projects, view.digests, true);
        return;
      }
      if (args.acceptsChatPages?.(peer) === true) {
        // Head rows only, and complete as they are: older chats come by page.
        const view = views.paged();
        sendSnapshot(peer, view.projects, requestId ?? null, view.digests);
        return;
      }
      const { digests } = views.full();
      if (args.acceptsPrioritySnapshot?.(peer) === true) {
        // The first screen gets the chats it needs now; the rest follows as a
        // delta against this baseline once the hold ends, so it does not sit
        // in front of the client's first replies on a slow link.
        const priority = projects.map((project) => priorityRosterProject(project));
        const partial = priority.some((project, index) => project !== projects[index]);
        sendSnapshot(peer, priority, requestId ?? null, partial ? digestRosterProjects(priority) : digests, partial);
        if (partial) {
          peer.rosterHoldUntilMs = Date.now() + ROSTER_PRIORITY_REST_DELAY_MS;
          const timer = setTimeout(() => markDirty(), ROSTER_PRIORITY_REST_DELAY_MS + 20);
          timer.unref?.();
        }
        return;
      }
      sendSnapshot(peer, projects, requestId ?? null, digests);
    },
    /**
     * `roster_chats_request`: older chats of one project, or chats by id. Reads
     * the roster built in the last second when there is one.
     */
    async chatPage(request: unknown): Promise<SyncRosterChatsPayload> {
      const projects = lastBuild && Date.now() - lastBuild.atMs < ROSTER_CHAT_PAGE_REUSE_MS
        ? lastBuild.projects
        : await buildProjects();
      return rosterChatsPage(projects ?? [], request as Parameters<typeof rosterChatsPage>[1]);
    },
    unsubscribe(peer: P): void {
      peer.rosterSubscribed = false;
      peer.rosterBaseline = new Map();
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
