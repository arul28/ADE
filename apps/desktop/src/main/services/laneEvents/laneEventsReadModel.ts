/**
 * The READ half of the lane story: persisted rows merged with events derived
 * on demand from git, the `pull_requests` rows and the chat sessions, so a
 * lane created before `lane_events` existed still tells a full story.
 * Persisted always wins over derived on the same `(kind, ref)`.
 *
 * It lives apart from the writer because the two halves share only the row
 * shapes: the writer is transactional and cheap, this side is I/O-bound and
 * cache-governed (see `laneEventsGitLog`).
 */
import fs from "node:fs";
import path from "node:path";

import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import {
  canonicalSessionState,
  canonicalStatusBucket,
} from "../../../shared/sessionCanonicalState";
import {
  emptyLaneEventsListResult,
  type LaneEvent,
  type LaneEventActor,
  type LaneEventKind,
  type LaneEventsBranch,
  type LaneEventsChat,
  type LaneEventsListArgs,
  type LaneEventsListResult,
  type LaneEventsSummary,
  type LaneEventsSummaryArgs,
  type LaneEventsSummaryResult,
  type CommitPayload,
  type PrPayload,
} from "../../../shared/types/laneEvents";
import type { TerminalSessionStatus, TerminalToolType } from "../../../shared/types/sessions";
import { identityFromCoAuthors } from "./laneEventTrailers";
import type { LaneEventsGitLog, LaneEventsGitScope } from "./laneEventsGitLog";
import { validateListArgs, validateSummaryArgs } from "./laneEventsValidation";


export type LaneRow = {
  id: string;
  name: string;
  base_ref: string;
  branch_ref: string;
  worktree_path: string;
  created_at: string;
};

export type LaneEventRow = {
  id: string;
  lane_id: string;
  kind: string;
  ts: string;
  actor_kind: string;
  actor_session_id: string | null;
  actor_provider: string | null;
  actor_model: string | null;
  actor_login: string | null;
  attribution: string | null;
  ref: string | null;
  branch_ref: string | null;
  payload_json: string;
};

export type PrRow = {
  id: string;
  lane_id: string;
  github_pr_number: number;
  github_url: string | null;
  title: string | null;
  state: string;
  base_branch: string | null;
  head_branch: string | null;
  checks_status: string | null;
  review_status: string | null;
  head_sha: string | null;
  merged_at: string | null;
  merged_by_login: string | null;
  merge_method: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatSessionRow = {
  id: string;
  lane_id: string;
  title: string | null;
  tool_type: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  settled_at: string | null;
  settle_override: string | null;
  exit_code: number | null;
  last_output_at: string | null;
  last_output_preview: string | null;
  status_note: string | null;
  attention_requested_at: string | null;
  attention_source: string | null;
  last_turn_failed_at: string | null;
  head_sha_start: string | null;
};

/** The lane row every read and write starts from. */
export function getLaneRow(db: AdeDb, laneId: string): LaneRow | null {
  return db.get<LaneRow>(
    "select id, name, base_ref, branch_ref, worktree_path, created_at from lanes where id = ?",
    [laneId],
  );
}

/** Persisted row -> the wire shape the renderer reads. */
export function toEvent(row: LaneEventRow): LaneEvent {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = {};
  }
  const actor: LaneEventActor = {
    kind: (row.actor_kind as LaneEventActor["kind"]) ?? "unknown",
    chatSessionId: row.actor_session_id,
    provider: row.actor_provider,
    model: row.actor_model,
    login: row.actor_login,
    attribution: (row.attribution as LaneEventActor["attribution"]) ?? null,
  };
  return {
    id: row.id,
    laneId: row.lane_id,
    kind: row.kind as LaneEventKind,
    ts: row.ts,
    actor,
    ref: row.ref,
    branchRef: row.branch_ref,
    payload: payload as LaneEvent["payload"],
    derived: false,
  };
}



/** Branch profiles the lane service knows about but the story has no events for. */
export type LaneEventsBranchProfile = { branchRef: string; baseRef?: string | null };

export type LaneEventsReadModelDeps = {
  db: AdeDb;
  gitLog: LaneEventsGitLog;
  /** `.ade/chat/sessions`, read for provider/model when a chat is not live. */
  chatSessionsDir?: string | null;
  laneService?: {
    listBranchProfiles?: (laneId: string) => LaneEventsBranchProfile[];
  } | null;
  logger?: Logger | null;
  now: () => Date;
};

export type LaneEventsReadModel = {
  list(args: LaneEventsListArgs): Promise<LaneEventsListResult>;
  summary(args: LaneEventsSummaryArgs): Promise<LaneEventsSummaryResult>;
};

export function createLaneEventsReadModel(deps: LaneEventsReadModelDeps): LaneEventsReadModel {
  const db = deps.db;
  const gitLog = deps.gitLog;
  const now = deps.now;
  const warn = (message: string, error: unknown, extra?: Record<string, unknown>): void => {
    deps.logger?.warn?.(message, {
      ...(extra ?? {}),
      error: error instanceof Error ? error.message : String(error),
    });
  };

function listPersisted(laneId: string, sinceTs: string | null, limit: number): LaneEvent[] {
  const rows = sinceTs
    ? db.all<LaneEventRow>(
        "select * from lane_events where lane_id = ? and ts >= ? order by ts desc limit ?",
        [laneId, sinceTs, limit],
      )
    : db.all<LaneEventRow>("select * from lane_events where lane_id = ? order by ts desc limit ?", [laneId, limit]);
  return rows.map(toEvent);
}

function listPrRows(laneId: string): PrRow[] {
  try {
    return db.all<PrRow>(
      `select id, lane_id, github_pr_number, github_url, title, state, base_branch, head_branch,
              checks_status, review_status, head_sha, merged_at, merged_by_login, merge_method,
              created_at, updated_at
         from pull_requests where lane_id = ? order by created_at asc`,
      [laneId],
    );
  } catch {
    return [];
  }
}

function listChatRows(laneId: string): ChatSessionRow[] {
  try {
    return db.all<ChatSessionRow>(
      `select id, lane_id, title, tool_type, status, started_at, ended_at, settled_at, settle_override,
              exit_code, last_output_at, last_output_preview, status_note, attention_requested_at,
              attention_source, last_turn_failed_at, head_sha_start
         from terminal_sessions
        where lane_id = ? and chat_session_id = id
        order by started_at asc`,
      [laneId],
    );
  } catch {
    return [];
  }
}

function prPayload(row: PrRow): PrPayload {
  return {
    prId: row.id,
    githubPrNumber: row.github_pr_number,
    title: row.title,
    githubUrl: row.github_url,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    checksStatus: row.checks_status,
    reviewStatus: row.review_status,
    mergeMethod: row.merge_method,
    mergedByLogin: row.merged_by_login,
  };
}

function prChatSessionIds(prId: string): string[] {
  try {
    return db
      .all<{ chat_session_id: string }>(
        "select chat_session_id from pull_request_chat_sessions where pr_id = ?",
        [prId],
      )
      .map((row) => row.chat_session_id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function deriveChat(row: ChatSessionRow): LaneEventsChat {
  const sidecar = readChatSidecar(deps.chatSessionsDir ?? null, row.id);
  const state = canonicalSessionState({
    status: row.status as TerminalSessionStatus,
    toolType: (row.tool_type ?? null) as TerminalToolType | null,
    lastOutputPreview: row.last_output_preview,
    lastActivityAt: row.last_output_at,
    exitCode: row.exit_code,
    settledAt: row.settled_at,
    settleOverride: (row.settle_override ?? null) as never,
    attentionRequestedAt: row.attention_requested_at,
    attentionSource: (row.attention_source ?? null) as never,
    lastTurnFailedAt: row.last_turn_failed_at,
    isChatTool: () => true,
  });
  return {
    chatSessionId: row.id,
    title: row.title,
    provider: sidecar?.provider ?? null,
    model: sidecar?.model ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: canonicalStatusBucket(state.phase),
    statusNote: row.status_note,
    lastActivityAt: row.last_output_at,
  };
}

async function deriveEvents(
  lane: LaneRow,
  scope: LaneEventsGitScope,
  persisted: LaneEvent[],
  chats: LaneEventsChat[],
): Promise<LaneEvent[]> {
  const seen = new Set(persisted.filter((e) => e.ref).map((e) => `${e.kind} ${e.ref}`));
  const has = (kind: LaneEventKind, ref: string | null): boolean =>
    ref !== null && seen.has(`${kind} ${ref}`);
  const derived: LaneEvent[] = [];
  const push = (event: Omit<LaneEvent, "id" | "derived">): void => {
    if (has(event.kind, event.ref)) return;
    derived.push({ ...event, id: `derived:${event.kind}:${event.ref ?? event.ts}`, derived: true });
  };

  // lane_created — synthesized from the lane row when nothing recorded it.
  if (!persisted.some((event) => event.kind === "lane_created")) {
    push({
      laneId: lane.id,
      kind: "lane_created",
      ts: lane.created_at,
      actor: { kind: "unknown" },
      ref: lane.id,
      branchRef: lane.branch_ref,
      payload: { source: "unknown", branchRef: lane.branch_ref, baseRef: lane.base_ref },
    });
  }

  const prRows = listPrRows(lane.id);

  // Commits on the lane branch. A fully merged branch has an empty
  // `base..branch` range, so fall back to the merged PR's head sha.
  let commits: CommitPayload[] = [];
  try {
    commits = await gitLog.readCommitsInRange(scope, `${lane.base_ref}..${lane.branch_ref}`);
    if (commits.length === 0) {
      const merged = prRows.find((row) => row.state === "merged" && row.head_sha);
      if (merged?.head_sha) {
        const base = await gitLog.mergeBase(scope, lane.base_ref, merged.head_sha);
        if (base) commits = await gitLog.readCommitsInRange(scope, `${base}..${merged.head_sha}`);
      }
    }
  } catch (error) {
    warn("lane_events.derive_commits_failed", error, { laneId: lane.id });
  }

  const repoUser = await gitLog.readRepoUserName(lane.worktree_path);
  for (const commit of commits) {
    const identity = identityFromCoAuthors(commit.coAuthors ?? []);
    const actor: LaneEventActor = identity.provider
      ? { kind: "agent", provider: identity.provider, model: identity.model, attribution: "trailer" }
      : commit.authorName && repoUser && commit.authorName === repoUser
        ? { kind: "human", login: null, attribution: "inferred" }
        : { kind: "unknown", attribution: "inferred" };
    push({
      laneId: lane.id,
      kind: "commit",
      ts: commit.authoredAt ?? lane.created_at,
      actor,
      ref: commit.sha,
      branchRef: commit.branchRef ?? lane.branch_ref,
      payload: { ...commit, branchRef: commit.branchRef ?? lane.branch_ref },
    });
  }

  for (const row of prRows) {
    const payload = prPayload(row);
    const chatSessionIds = prChatSessionIds(row.id);
    const openedActor: LaneEventActor = chatSessionIds[0]
      ? { kind: "agent", chatSessionId: chatSessionIds[0], attribution: "session" }
      : { kind: "human", attribution: "inferred" };
    push({
      laneId: lane.id,
      kind: "pr_opened",
      ts: row.created_at,
      actor: openedActor,
      ref: row.id,
      branchRef: row.head_branch ?? lane.branch_ref,
      payload,
    });
    if (row.state === "merged") {
      push({
        laneId: lane.id,
        kind: "pr_merged",
        ts: row.merged_at ?? row.updated_at,
        actor: { kind: "human", login: row.merged_by_login, attribution: "inferred" },
        ref: row.id,
        branchRef: row.head_branch ?? lane.branch_ref,
        payload,
      });
    } else if (row.state === "closed") {
      push({
        laneId: lane.id,
        kind: "pr_closed",
        ts: row.updated_at,
        actor: { kind: "unknown" },
        ref: row.id,
        branchRef: row.head_branch ?? lane.branch_ref,
        payload,
      });
    }
  }

  for (const chat of chats) {
    push({
      laneId: lane.id,
      kind: "chat_started",
      ts: chat.startedAt,
      actor: {
        kind: "agent",
        chatSessionId: chat.chatSessionId,
        provider: chat.provider,
        model: chat.model,
        attribution: "session",
      },
      ref: chat.chatSessionId,
      branchRef: lane.branch_ref,
      payload: {
        chatSessionId: chat.chatSessionId,
        title: chat.title,
        provider: chat.provider,
        model: chat.model,
      },
    });
    if (chat.endedAt) {
      push({
        laneId: lane.id,
        kind: "chat_ended",
        ts: chat.endedAt,
        actor: {
          kind: "agent",
          chatSessionId: chat.chatSessionId,
          provider: chat.provider,
          model: chat.model,
          attribution: "session",
        },
        ref: chat.chatSessionId,
        branchRef: lane.branch_ref,
        payload: {
          chatSessionId: chat.chatSessionId,
          title: chat.title,
          provider: chat.provider,
          model: chat.model,
          outcome: chat.status === "settled" ? "settled" : "ended",
        },
      });
    }
  }

  return derived;
}

async function buildBranches(
  lane: LaneRow,
  scope: LaneEventsGitScope,
  events: LaneEvent[],
): Promise<LaneEventsBranch[]> {
  const byRef = new Map<string, { firstTs: string; lastTs: string }>();
  for (const event of events) {
    const ref = event.branchRef;
    if (!ref) continue;
    const entry = byRef.get(ref);
    if (!entry) byRef.set(ref, { firstTs: event.ts, lastTs: event.ts });
    else {
      if (event.ts < entry.firstTs) entry.firstTs = event.ts;
      if (event.ts > entry.lastTs) entry.lastTs = event.ts;
    }
  }
  const profiles = (() => {
    try {
      return deps.laneService?.listBranchProfiles?.(lane.id) ?? [];
    } catch {
      return [];
    }
  })();
  for (const profile of profiles) {
    if (profile.branchRef && !byRef.has(profile.branchRef)) {
      byRef.set(profile.branchRef, { firstTs: lane.created_at, lastTs: lane.created_at });
    }
  }
  if (!byRef.has(lane.branch_ref)) {
    byRef.set(lane.branch_ref, { firstTs: lane.created_at, lastTs: lane.created_at });
  }

  const prRows = listPrRows(lane.id);
  const terminalByBranch = new Map<string, "merged" | "closed">();
  for (const row of prRows) {
    if (!row.head_branch) continue;
    if (row.state === "merged") terminalByBranch.set(row.head_branch, "merged");
    else if (row.state === "closed" && !terminalByBranch.has(row.head_branch)) {
      terminalByBranch.set(row.head_branch, "closed");
    }
  }

  const branches: LaneEventsBranch[] = [];
  for (const [branchRef, span] of byRef) {
    // A failed merge-base is a missing worktree or a deleted ref, not a fact
    // worth caching — the git log throws, we degrade here, and the next read
    // tries again.
    let forkPointSha: string | null = null;
    try {
      forkPointSha = await gitLog.mergeBase(scope, lane.base_ref, branchRef);
    } catch (error) {
      warn("lane_events.fork_point_failed", error, { laneId: lane.id, branchRef });
    }
    branches.push({
      branchRef,
      forkPointSha,
      firstTs: span.firstTs,
      lastTs: span.lastTs,
      terminal: terminalByBranch.get(branchRef) ?? null,
    });
  }
  branches.sort((a, b) => a.firstTs.localeCompare(b.firstTs));
  return branches;
}

async function list(args: LaneEventsListArgs): Promise<LaneEventsListResult> {
  const { laneId, limit, sinceTs, persistedOnly } = validateListArgs(args);
  const generatedAt = now().toISOString();
  const lane = getLaneRow(db, laneId);
  // An unknown lane answers with the one canonical empty story every transport
  // falls back to, so the shape never depends on which layer produced it.
  if (!lane) return emptyLaneEventsListResult(laneId);

  // One `rev-parse` pins every git answer below to this head, so an unchanged
  // lane answers the next read entirely from the memo.
  const scope = await gitLog.resolveScope({
    cwd: lane.worktree_path,
    branchRef: lane.branch_ref,
    baseRef: lane.base_ref,
  });
  const persisted = listPersisted(laneId, sinceTs, limit);
  const chats = listChatRows(laneId).map(deriveChat);
  const derived = persistedOnly ? [] : await deriveEvents(lane, scope, persisted, chats);

  let events = [...persisted, ...derived];
  if (sinceTs) events = events.filter((event) => event.ts >= sinceTs);
  events.sort((a, b) => (a.ts === b.ts ? a.kind.localeCompare(b.kind) : a.ts.localeCompare(b.ts)));
  if (events.length > limit) events = events.slice(events.length - limit);

  return {
    laneId,
    events,
    branches: await buildBranches(lane, scope, events),
    chats,
    baseRef: lane.base_ref,
    hasDerived: derived.length > 0,
    generatedAt,
  };
}

async function summary(args: LaneEventsSummaryArgs): Promise<LaneEventsSummaryResult> {
  const generatedAt = now().toISOString();
  const laneIds = validateSummaryArgs(args);
  const summaries: LaneEventsSummary[] = [];

  for (const laneId of laneIds) {
    const lane = getLaneRow(db, laneId);
    if (!lane) continue;
    const rows = db.all<LaneEventRow>(
      "select * from lane_events where lane_id = ? order by ts desc limit 40",
      [laneId],
    );
    const counts = db.get<{ total: number; commits: number; prs: number }>(
      `select count(1) as total,
              sum(case when kind = 'commit' then 1 else 0 end) as commits,
              sum(case when kind in ('pr_opened','pr_merged','pr_closed') then 1 else 0 end) as prs
         from lane_events where lane_id = ?`,
      [laneId],
    );
    const chats = listChatRows(laneId).map(deriveChat);
    const tail = pickTailChat(chats);

    let events = rows.map(toEvent).reverse();
    let commitCount = Number(counts?.commits ?? 0);
    let prCount = Number(counts?.prs ?? 0);

    // A lane with ANY persisted row tells its own story; the git fallback is
    // only for lanes that predate the table, so a normal List refresh across
    // many lanes never shells out at all.
    if (rows.length === 0 && Number(counts?.total ?? 0) === 0) {
      // Cheap derived fallback: the last commit and the PR rows only — never
      // a full git log.
      const prRows = listPrRows(laneId);
      prCount = prRows.length;
      const fallback: LaneEvent[] = prRows.map((row) => ({
        id: `derived:pr_opened:${row.id}`,
        laneId,
        kind: "pr_opened" as const,
        ts: row.created_at,
        actor: { kind: "human" as const, attribution: "inferred" as const },
        ref: row.id,
        branchRef: row.head_branch ?? lane.branch_ref,
        payload: prPayload(row),
        derived: true,
      }));
      try {
        const scope = await gitLog.resolveScope({
          cwd: lane.worktree_path,
          branchRef: lane.branch_ref,
          baseRef: lane.base_ref,
        });
        const last = await gitLog.readCommitsAt(scope, [scope.headSha ?? lane.branch_ref]);
        if (last[0]) {
          commitCount = 1;
          fallback.push({
            id: `derived:commit:${last[0].sha}`,
            laneId,
            kind: "commit",
            ts: last[0].authoredAt ?? lane.created_at,
            actor: (() => {
              const identity = identityFromCoAuthors(last[0]!.coAuthors ?? []);
              return identity.provider
                ? {
                    kind: "agent" as const,
                    provider: identity.provider,
                    model: identity.model,
                    attribution: "trailer" as const,
                  }
                : { kind: "unknown" as const };
            })(),
            ref: last[0].sha,
            branchRef: lane.branch_ref,
            payload: { ...last[0], branchRef: lane.branch_ref },
            derived: true,
          });
        }
      } catch {
        // A missing worktree just means no commit in the digest.
      }
      fallback.sort((a, b) => a.ts.localeCompare(b.ts));
      events = fallback;
    }

    const last = events[events.length - 1] ?? null;
    summaries.push({
      laneId,
      eventCount: Number(counts?.total ?? 0) || events.length,
      commitCount,
      prCount,
      lastEventTs: last?.ts ?? null,
      lastEventKind: last?.kind ?? null,
      spine: events.map((event) => ({
        kind: event.kind,
        ts: event.ts,
        provider: event.actor.provider ?? null,
        actorKind: event.actor.kind,
        ref: event.ref,
      })),
      tail,
    });
  }

  return { summaries, generatedAt };
}

  return { list, summary };
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

/** The chat a lane's List row should show: a live one if any, else the newest. */
export function pickTailChat(chats: readonly LaneEventsChat[]): LaneEventsChat | null {
  if (chats.length === 0) return null;
  const rank = (chat: LaneEventsChat): number => {
    if (chat.status === "awaiting-input") return 3;
    if (chat.status === "running") return 2;
    if (chat.status === "settled") return 1;
    return 0;
  };
  let best = chats[0]!;
  for (const chat of chats.slice(1)) {
    const better =
      rank(chat) > rank(best)
      || (rank(chat) === rank(best) && (chat.lastActivityAt ?? chat.startedAt) > (best.lastActivityAt ?? best.startedAt));
    if (better) best = chat;
  }
  return best;
}

type ChatSidecar = { provider: string | null; model: string | null };

/** Best-effort read of a chat's persisted sidecar. Never throws. */
export function readChatSidecar(chatSessionsDir: string | null, sessionId: string): ChatSidecar | null {
  if (!chatSessionsDir) return null;
  // The id becomes a path segment, so it must be an id and nothing else.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  try {
    const raw = fs.readFileSync(path.join(chatSessionsDir, `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
    };
  } catch {
    return null;
  }
}

