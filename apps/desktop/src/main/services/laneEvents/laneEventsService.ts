/**
 * Lane events service — the persisted per-lane story (see
 * docs/features/lanes/lane-story.md).
 *
 * This module is the WRITE half plus the change-notification plumbing:
 * milestone events recorded by the git/PR/lane/chat writers, deduped app-side
 * on `(lane_id, kind, ref)` because `lane_events` deliberately carries no
 * UNIQUE index (that is what keeps it auto-CRR and phone-safe).
 *
 * The READ half lives in `laneEventsReadModel.ts`; this file composes it so
 * callers still see one `LaneEventsService`.
 */
import { randomUUID } from "node:crypto";

import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import type {
  LaneEvent,
  LaneEventActor,
  LaneEventKind,
  LaneEventsChangedEvent,
  LaneEventsListArgs,
  LaneEventsListResult,
  LaneEventsSummaryArgs,
  LaneEventsSummaryResult,
} from "../../../shared/types/laneEvents";
import { chooseHeadWatchSession, identityFromCoAuthors } from "./laneEventTrailers";
import { createLaneEventsGitLog, GIT_TIMEOUT_MS } from "./laneEventsGitLog";
import {
  createLaneEventsReadModel,
  getLaneRow,
  readChatSidecar,
  type LaneEventsBranchProfile,
  type LaneRow,
} from "./laneEventsReadModel";

export type LaneEventsWriteInput = Omit<LaneEvent, "id" | "derived"> & { id?: string };

/** Range of shas to record as `commit` events, used by git ops and head watchers. */
export type LaneEventsCommitRangeArgs = {
  laneId: string;
  preHeadSha: string | null;
  postHeadSha: string | null;
  /** Recorded at write time by a known chat session; required for `session-agent`. */
  actorSessionId?: string | null;
  /**
   * Who to credit, decided by the CALLER — never guessed here:
   * `session-agent` a chat made these commits, `session-human` a person did
   * (the Git pane), `head-watch` they appeared out of band.
   */
  attribution: "session-agent" | "session-human" | "head-watch";
  reason?: string | null;
};

export type LaneEventsService = {
  /** Read: persisted rows merged with derived events. */
  list(args: LaneEventsListArgs): Promise<LaneEventsListResult>;
  /** Read: compact per-lane digest for many lanes. */
  summary(args: LaneEventsSummaryArgs): Promise<LaneEventsSummaryResult>;
  /** Write one event; dedupes on (laneId, kind, ref). Returns the stored event or null when deduped. */
  record(input: LaneEventsWriteInput): Promise<LaneEvent | null>;
  /**
   * Write a `commit` event for every sha in `pre..post` that is not recorded
   * yet. The single entry point for the git-op finish hook and both hosts'
   * head watchers; deduping is what makes double-recording harmless.
   */
  recordCommitRange(args: LaneEventsCommitRangeArgs): Promise<void>;
  /**
   * Drop this lane's in-memory bookkeeping (debounced notification, cap
   * counter). The rows themselves are deleted by the lane teardown transaction
   * that owns every other `lane_id` table, so this never issues SQL.
   */
  forgetLane(laneId: string): void;
  /** Subscribe to change notifications (debounced per lane). */
  onChanged(listener: (event: LaneEventsChangedEvent) => void): () => void;
  dispose(): void;
};

export type { LaneEvent, LaneEventKind, LaneEventsChangedEvent };

// ---------------------------------------------------------------------------
// Structural dependency shapes (kept minimal so this service never has to
// import the concrete lane/pr/chat services and create an import cycle).
// ---------------------------------------------------------------------------

export type LaneEventsDeps = {
  db: AdeDb;
  projectId?: string;
  getProjectId?: () => string;
  laneService?: {
    listBranchProfiles?: (laneId: string) => LaneEventsBranchProfile[];
  } | null;
  agentChatService?: {
    getSessionSummary?: (
      sessionId: string,
    ) => Promise<{ provider?: string | null; model?: string | null; title?: string | null } | null>;
  } | null;
  /** Directory holding `<chatSessionId>.json` chat sidecars (`.ade/chat/sessions`). */
  chatSessionsDir?: string | null;
  logger?: Logger | null;
  /** Injectable for tests; defaults to the real git runner. */
  runGitCommand?: (
    args: string[],
    opts: { cwd: string; timeoutMs: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now?: () => Date;
  /** Debounce window for `onChanged`; the spec floor is 250ms. */
  changeDebounceMs?: number;
};

/** Per-lane row cap. Past it, the cheapest-to-rederive kinds are dropped first. */
export const LANE_EVENTS_PER_LANE_CAP = 4000;
const CAP_EVICTABLE_KINDS = ["commit", "pr_checks"] as const;
/** `rev-list --max-count` for one head move; past it the story is truncated. */
const COMMIT_RANGE_MAX = 50;
/** Reachability bound when pruning after a history rewrite. */
const REACHABLE_SET_MAX = 5000;
export function createLaneEventsService(deps: LaneEventsDeps): LaneEventsService {
  const db = deps.db;
  const logger = deps.logger ?? null;
  const now = deps.now ?? (() => new Date());
  const git = deps.runGitCommand ?? ((args, opts) => runGit(args, opts));
  const gitLog = createLaneEventsGitLog({ git });
  const readModel = createLaneEventsReadModel({
    db,
    gitLog,
    chatSessionsDir: deps.chatSessionsDir ?? null,
    laneService: deps.laneService ?? null,
    logger,
    now,
  });
  const debounceMs = Math.max(250, deps.changeDebounceMs ?? 250);
  const projectId = (): string => deps.getProjectId?.() ?? deps.projectId ?? "";

  const listeners = new Set<(event: LaneEventsChangedEvent) => void>();
  const pending = new Map<string, { kinds: Set<LaneEventKind>; timer: ReturnType<typeof setTimeout> }>();
  /**
   * Row count per lane, so the cap check on every insert is a map lookup
   * instead of a `count(1)` scan. Primed lazily and re-primed whenever it goes
   * missing, so a cold service or a foreign writer can never make it lie for
   * long.
   */
  const rowCounts = new Map<string, number>();
  let disposed = false;

  const warn = (message: string, error: unknown, extra?: Record<string, unknown>): void => {
    logger?.warn?.(message, {
      ...(extra ?? {}),
      error: error instanceof Error ? error.message : String(error),
    });
  };

  // -------------------------------------------------------------------------
  // Change notification (debounced per lane, coalescing the kinds seen)
  // -------------------------------------------------------------------------

  function notifyChanged(laneId: string, kind: LaneEventKind): void {
    if (disposed) return;
    const existing = pending.get(laneId);
    if (existing) {
      existing.kinds.add(kind);
      return;
    }
    const kinds = new Set<LaneEventKind>([kind]);
    const timer = setTimeout(() => {
      pending.delete(laneId);
      const event: LaneEventsChangedEvent = {
        laneId,
        kinds: [...kinds],
        at: now().toISOString(),
      };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A subscriber must never break the writer.
        }
      }
    }, debounceMs);
    timer.unref?.();
    pending.set(laneId, { kinds, timer });
  }

  // -------------------------------------------------------------------------
  // Row helpers
  // -------------------------------------------------------------------------

  function laneRowCount(laneId: string): number {
    const cached = rowCounts.get(laneId);
    if (cached !== undefined) return cached;
    const row = db.get<{ count: number }>("select count(1) as count from lane_events where lane_id = ?", [laneId]);
    const total = Number(row?.count ?? 0);
    rowCounts.set(laneId, total);
    return total;
  }

  /** Called with the count AFTER the insert that triggered the check. */
  function enforceCap(laneId: string, total: number): void {
    if (total <= LANE_EVENTS_PER_LANE_CAP) return;
    let excess = total - LANE_EVENTS_PER_LANE_CAP;

    // Drop the kinds a read can cheaply re-derive from git and the PR rows
    // first; lane/chat lifecycle events exist nowhere else.
    const evictable = db.all<{ id: string }>(
      `select id from lane_events
        where lane_id = ? and kind in (${CAP_EVICTABLE_KINDS.map(() => "?").join(", ")})
        order by ts asc, created_at asc
        limit ?`,
      [laneId, ...CAP_EVICTABLE_KINDS, excess],
    );
    for (const row of evictable) {
      db.run("delete from lane_events where id = ?", [row.id]);
    }
    rowCounts.set(laneId, Math.max(0, total - evictable.length));
    excess -= evictable.length;
    if (excess <= 0) return;

    const oldest = db.all<{ id: string }>(
      "select id from lane_events where lane_id = ? order by ts asc, created_at asc limit ?",
      [laneId, excess],
    );
    for (const row of oldest) {
      db.run("delete from lane_events where id = ?", [row.id]);
    }
    rowCounts.set(laneId, Math.max(0, total - evictable.length - oldest.length));
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  async function record(input: LaneEventsWriteInput): Promise<LaneEvent | null> {
    if (disposed) return null;
    const laneId = input.laneId?.trim();
    if (!laneId) return null;
    try {
      if (input.ref) {
        const existing = db.get<{ id: string }>(
          "select id from lane_events where lane_id = ? and kind = ? and ref = ? limit 1",
          [laneId, input.kind, input.ref],
        );
        if (existing) return null;
      }
      // Primed BEFORE the insert, so the counter is authoritative afterwards
      // whether or not this is the first write since the service started.
      const before = laneRowCount(laneId);
      const id = input.id ?? randomUUID();
      const createdAt = now().toISOString();
      const actor = input.actor ?? { kind: "unknown" };
      db.run(
        `insert into lane_events (
           id, project_id, lane_id, kind, ts, actor_kind, actor_session_id, actor_provider,
           actor_model, actor_login, attribution, ref, branch_ref, payload_json, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId(),
          laneId,
          input.kind,
          input.ts,
          actor.kind ?? "unknown",
          actor.chatSessionId ?? null,
          actor.provider ?? null,
          actor.model ?? null,
          actor.login ?? null,
          actor.attribution ?? null,
          input.ref ?? null,
          input.branchRef ?? null,
          JSON.stringify(input.payload ?? {}),
          createdAt,
        ],
      );
      const total = before + 1;
      rowCounts.set(laneId, total);
      enforceCap(laneId, total);
      notifyChanged(laneId, input.kind);
      return { ...input, id, actor, derived: false } as LaneEvent;
    } catch (error) {
      warn("lane_events.record_failed", error, { laneId, kind: input.kind });
      return null;
    }
  }

  async function chatIdentity(
    chatSessionId: string | null | undefined,
  ): Promise<{ provider: string | null; model: string | null; title: string | null }> {
    if (!chatSessionId) return { provider: null, model: null, title: null };
    try {
      const summary = await deps.agentChatService?.getSessionSummary?.(chatSessionId);
      if (summary) {
        return {
          provider: summary.provider ?? null,
          model: summary.model ?? null,
          title: summary.title ?? null,
        };
      }
    } catch {
      // Fall through to the sidecar.
    }
    const sidecar = readChatSidecar(deps.chatSessionsDir ?? null, chatSessionId);
    return { provider: sidecar?.provider ?? null, model: sidecar?.model ?? null, title: null };
  }

  async function recordCommitRange(args: LaneEventsCommitRangeArgs): Promise<void> {
    if (disposed) return;
    const post = args.postHeadSha?.trim();
    if (!post) return;
    const lane = getLaneRow(db, args.laneId);
    if (!lane) return;
    try {
      const pre = args.preHeadSha?.trim();
      const headWatch = args.attribution === "head-watch";
      const range = pre && pre !== post ? `${pre}..${post}` : post;
      const revArgs = pre && pre !== post
        ? ["rev-list", `--max-count=${COMMIT_RANGE_MAX}`, range]
        : ["rev-list", "--max-count=1", range];
      // Out-of-band head moves include `pull`/`fetch`+`merge`, which import the
      // BASE branch's history. Excluding the remote base ref drops exactly
      // those; excluding every remote would also drop this lane's own commits
      // once they have been pushed, which is the story we most want to keep.
      if (headWatch) {
        const baseBranch = lane.base_ref.replace(/^refs\/heads\//, "");
        // Prefer the base branch's configured upstream (handles remotes not
        // named `origin` and multi-remote forks); fall back to `origin/<base>`.
        const remoteBase =
          (await gitLog.resolveRef(lane.worktree_path, `${baseBranch}@{upstream}`)) ??
          (await gitLog.resolveRef(lane.worktree_path, `origin/${baseBranch}`));
        if (remoteBase) revArgs.push("--not", remoteBase);
      }
      const revRes = await git(revArgs, { cwd: lane.worktree_path, timeoutMs: GIT_TIMEOUT_MS });
      if (revRes.exitCode !== 0) return;
      const shas = revRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      if (shas.length === 0) return;
      if (shas.length >= COMMIT_RANGE_MAX) {
        logger?.warn?.("lane_events.commit_range_truncated", {
          laneId: args.laneId,
          range,
          maxCount: COMMIT_RANGE_MAX,
        });
      }

      // An amend / rebase --continue REPLACES commits: the old shas are still
      // in this lane's rows but no longer in its history. Only the ops that
      // author commits prune, because a head-watch move can legitimately be a
      // branch switch, where unreachable rows are still the lane's story.
      if (!headWatch && pre && pre !== post) {
        await pruneRewrittenCommits(lane, pre, post);
      }

      const unrecorded = shas.filter((sha) => {
        const existing = db.get<{ id: string }>(
          "select id from lane_events where lane_id = ? and kind = 'commit' and ref = ? limit 1",
          [args.laneId, sha],
        );
        return !existing;
      });
      if (unrecorded.length === 0) return;

      const commits = await gitLog.readCommitsUncached(lane.worktree_path, unrecorded);
      // A caller that knows the session names it; only the head watcher is
      // allowed to guess, and only from the lane's own mid-flight chats.
      const sessionId = args.attribution === "session-agent"
        ? args.actorSessionId ?? null
        : headWatch
          ? args.actorSessionId ?? pickMidFlightChatSession(args.laneId)
          : null;
      const identity = await chatIdentity(sessionId);

      for (const commit of commits) {
        const trailerIdentity = identityFromCoAuthors(commit.coAuthors ?? []);
        const actor: LaneEventActor = sessionId
          ? {
              kind: "agent",
              chatSessionId: sessionId,
              provider: identity.provider ?? trailerIdentity.provider,
              model: identity.model ?? trailerIdentity.model,
              attribution: headWatch ? "head-watch" : "session",
            }
          : args.attribution === "session-human"
            // A commit the person made in the Git pane. It is theirs, and it is
            // known, not inferred — never attributed to a chat that happened to
            // be running at the time.
            ? { kind: "human", attribution: "session" }
            : trailerIdentity.provider
              ? {
                  kind: "agent",
                  provider: trailerIdentity.provider,
                  model: trailerIdentity.model,
                  attribution: "trailer",
                }
              : { kind: "unknown", attribution: "head-watch" };
        await record({
          laneId: args.laneId,
          kind: "commit",
          ts: commit.authoredAt ?? now().toISOString(),
          actor,
          ref: commit.sha,
          branchRef: lane.branch_ref,
          payload: { ...commit, branchRef: lane.branch_ref },
        });
      }
    } catch (error) {
      warn("lane_events.record_commit_range_failed", error, { laneId: args.laneId });
    }
  }

  /**
   * After a history rewrite, drop the `commit` rows whose shas the lane can no
   * longer reach. Best-effort by construction: if the reachable set cannot be
   * computed, or is bigger than we are willing to hold, nothing is deleted —
   * an orphaned row is a much smaller problem than a deleted real one.
   */
  async function pruneRewrittenCommits(lane: LaneRow, pre: string, post: string): Promise<void> {
    const ancestry = await git(["merge-base", "--is-ancestor", pre, post], {
      cwd: lane.worktree_path,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    // Exit 0 means the old head is still in the new history: a fast-forward,
    // nothing was rewritten.
    if (ancestry.exitCode === 0) return;
    if (ancestry.exitCode !== 1) return; // a broken repo, not a rewrite

    const base = await gitLog.mergeBaseUncached(lane.worktree_path, lane.base_ref, post);
    const reachableRange = base ? `${base}..${post}` : post;
    const res = await git(["rev-list", `--max-count=${REACHABLE_SET_MAX}`, reachableRange], {
      cwd: lane.worktree_path,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) return;
    const reachable = new Set(res.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    // A truncated set would make reachable commits look orphaned.
    if (reachable.size === 0 || reachable.size >= REACHABLE_SET_MAX) return;

    // Scope to the branch the rewrite happened on: commit rows recorded on the
    // lane's OTHER branches are unreachable from this branch by construction
    // and must never be treated as orphans (branch_ref null rows are legacy /
    // head-watch rows on the current branch, so they stay in scope).
    const rows = db.all<{ id: string; ref: string | null }>(
      "select id, ref from lane_events where lane_id = ? and kind = 'commit' and ref is not null and (branch_ref = ? or branch_ref is null)",
      [lane.id, lane.branch_ref],
    );
    const stale = rows.filter((row) => row.ref && !reachable.has(row.ref));
    if (stale.length === 0) return;
    // Read the count BEFORE deleting, so a cold counter is not primed from the
    // already-shrunken table and then decremented a second time.
    const before = laneRowCount(lane.id);
    for (const row of stale) db.run("delete from lane_events where id = ?", [row.id]);
    rowCounts.set(lane.id, Math.max(0, before - stale.length));
    logger?.info?.("lane_events.pruned_rewritten_commits", { laneId: lane.id, removed: stale.length });
    notifyChanged(lane.id, "commit");
  }

  /**
   * The lane's single mid-flight chat session, or the most recently talkative
   * one when a fleet is running. See `chooseHeadWatchSession`.
   */
  function pickMidFlightChatSession(laneId: string): string | null {
    try {
      const rows = db.all<{ id: string; last_output_at: string | null }>(
        `select id, last_output_at from terminal_sessions
          where lane_id = ? and chat_session_id = id and ended_at is null
            and head_sha_start is not null and status = 'running'`,
        [laneId],
      );
      return chooseHeadWatchSession(rows.map((row) => ({ chatSessionId: row.id, lastOutputAt: row.last_output_at })));
    } catch {
      return null;
    }
  }

  function forgetLane(laneId: string): void {
    const entry = pending.get(laneId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(laneId);
    }
    rowCounts.delete(laneId);
  }


  return {
    list: (args) => readModel.list(args),
    summary: (args) => readModel.summary(args),
    record,
    recordCommitRange,
    forgetLane,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      listeners.clear();
    },
  };
}

