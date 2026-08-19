/**
 * Lane events — the persisted, per-lane story of what happened in a lane and
 * who (which agent chat / human / bot) did it. This is the contract shared by
 * the runtime service (`main/services/laneEvents`), the `lane_events` ADE
 * action domain, preload (`window.ade.laneEvents`), the hosted web client
 * adapter, the `ade lane events` CLI command, and the Lanes tab renderer.
 *
 * Design rules (see docs/features/lanes/lane-story.md):
 * - Append-only, low-volume: milestones only (commits, PR transitions, CI and
 *   review transitions, lane lifecycle, chat lifecycle, branch switches,
 *   rebases). Never per-turn or per-token.
 * - Every event names an actor. Unknown actors are `{ kind: "unknown" }`,
 *   never omitted.
 * - Reads MERGE persisted rows with events derived on demand from git / PR /
 *   session state, so lanes that predate the table still tell a full story.
 */

export const LANE_EVENT_KINDS = [
  "lane_created",
  "lane_spawned",
  "branch_switched",
  "commit",
  "rebase",
  "chat_started",
  "chat_ended",
  "pr_opened",
  "pr_checks",
  "pr_review",
  "pr_merged",
  "pr_closed",
] as const;
export type LaneEventKind = (typeof LANE_EVENT_KINDS)[number];

export type LaneEventActorKind = "human" | "agent" | "bot" | "system" | "unknown";

/** Who did it. `agent` actors carry the owning chat session + provider/model when known. */
export type LaneEventActor = {
  kind: LaneEventActorKind;
  /** Chat session id (a `terminal_sessions.id` whose `chat_session_id` equals itself) for `agent`. */
  chatSessionId?: string | null;
  /** Provider family for logos/colors: "claude" | "codex" | "cursor" | "droid" | "opencode" | ... */
  provider?: string | null;
  /** Human-facing model label, e.g. "Opus 5", "grok-4.6". */
  model?: string | null;
  /** Human login / bot name (e.g. GitHub login, "CodeRabbit"). */
  login?: string | null;
  /** How the actor was determined. `trailer` = Co-Authored-By trailer, `session` = recorded at write time, `head-watch` = attributed to the lane's single active session, `inferred` = heuristic. */
  attribution?: "session" | "trailer" | "head-watch" | "inferred" | null;
};

export type LaneCreatedPayload = {
  /** How the lane came to exist. */
  source: "human" | "chat" | "agent-cli" | "linear" | "automation" | "pr-import" | "conflict" | "unknown";
  branchRef: string;
  baseRef: string;
  /** Present when spawned from a chat that lives in another lane. */
  fromLaneId?: string | null;
  fromChatSessionId?: string | null;
  linearIssueIdentifier?: string | null;
  automationRuleId?: string | null;
};

export type LaneSpawnedPayload = {
  /** The child/new lane created from a chat in this lane. */
  laneId: string;
  laneName: string;
  branchRef: string;
  fromChatSessionId?: string | null;
};

export type BranchSwitchedPayload = { fromBranchRef: string | null; toBranchRef: string; baseRef?: string | null };

export type CommitPayload = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName?: string | null;
  authoredAt?: string | null;
  branchRef?: string | null;
  filesChanged?: number | null;
  insertions?: number | null;
  deletions?: number | null;
  /** Co-Authored-By trailer values as found in the message, if any. */
  coAuthors?: string[];
};

export type RebasePayload = { onto: string; outcome: "completed" | "failed" | "auto"; message?: string | null };

export type ChatLifecyclePayload = {
  chatSessionId: string;
  title?: string | null;
  provider?: string | null;
  model?: string | null;
  /** For chat_ended: how it ended. */
  outcome?: "ended" | "failed" | "settled" | null;
};

export type PrPayload = {
  prId: string;
  githubPrNumber: number;
  title?: string | null;
  githubUrl?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  /** pr_checks: the new checks status; pr_review: the new review status; pr_merged: merge method; pr_closed: n/a */
  checksStatus?: string | null;
  reviewStatus?: string | null;
  mergeMethod?: string | null;
  mergedByLogin?: string | null;
};

export type LaneEventPayloadByKind = {
  lane_created: LaneCreatedPayload;
  lane_spawned: LaneSpawnedPayload;
  branch_switched: BranchSwitchedPayload;
  commit: CommitPayload;
  rebase: RebasePayload;
  chat_started: ChatLifecyclePayload;
  chat_ended: ChatLifecyclePayload;
  pr_opened: PrPayload;
  pr_checks: PrPayload;
  pr_review: PrPayload;
  pr_merged: PrPayload;
  pr_closed: PrPayload;
};

export type LaneEvent<K extends LaneEventKind = LaneEventKind> = {
  id: string;
  laneId: string;
  kind: K;
  /** ISO-8601 event time (when it happened, not when it was recorded). */
  ts: string;
  actor: LaneEventActor;
  /** Stable reference for dedupe: commit sha, PR id, chat session id, branch ref, child lane id. */
  ref: string | null;
  /** The branch the event belongs to (so multi-branch lanes can draw rows). Null for lane-level events. */
  branchRef: string | null;
  payload: LaneEventPayloadByKind[K];
  /** True when derived on read (git/PR/session state) rather than persisted. */
  derived: boolean;
};

export type LaneEventsListArgs = {
  laneId: string;
  /** Only events at or after this ISO timestamp. */
  sinceTs?: string | null;
  /** Max events returned, newest kept. Default 500. */
  limit?: number | null;
  /** Skip on-read derivation (persisted rows only). Default false. */
  persistedOnly?: boolean | null;
};

export type LaneEventsBranch = {
  branchRef: string;
  /** Sha on the base branch this branch forked from, when known. */
  forkPointSha?: string | null;
  /** First event ts on this branch. */
  firstTs: string;
  lastTs: string;
  /** Terminal state if any PR on this branch was merged/closed. */
  terminal?: "merged" | "closed" | null;
};

export type LaneEventsChat = {
  chatSessionId: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Canonical bucket from the session state, when the session still exists. */
  status: "running" | "awaiting-input" | "idle" | "ended" | "settled" | "unknown";
  statusNote: string | null;
  lastActivityAt: string | null;
};

export type LaneEventsListResult = {
  laneId: string;
  events: LaneEvent[];
  branches: LaneEventsBranch[];
  chats: LaneEventsChat[];
  /** Base ref the lane's story is measured against (usually main). */
  baseRef: string;
  /** True if any events came from derivation. */
  hasDerived: boolean;
  generatedAt: string;
};

export type LaneEventsSummaryArgs = { laneIds: string[] };

/** Compact per-lane digest for the List view / tab strip. */
export type LaneEventsSummary = {
  laneId: string;
  eventCount: number;
  commitCount: number;
  prCount: number;
  lastEventTs: string | null;
  lastEventKind: LaneEventKind | null;
  /** Up to ~40 most recent events, compact (kind, ts, actor.provider, ref) — enough for a mini spine. */
  spine: Array<{ kind: LaneEventKind; ts: string; provider: string | null; actorKind: LaneEventActorKind; ref: string | null }>;
  /** Live tail: the most relevant chat in the lane right now, if any. */
  tail: LaneEventsChat | null;
};

export type LaneEventsSummaryResult = { summaries: LaneEventsSummary[]; generatedAt: string };

/** Push payload on the runtime event stream when a lane's story changes. */
export type LaneEventsChangedEvent = { laneId: string; kinds: LaneEventKind[]; at: string };

/** Origin descriptor threaded into laneService.create/createChild/createFromUnstaged by callers. */
export type LaneCreationOrigin = {
  source: LaneCreatedPayload["source"];
  chatSessionId?: string | null;
  fromLaneId?: string | null;
  linearIssueIdentifier?: string | null;
  automationRuleId?: string | null;
  actorLogin?: string | null;
};

/** Canonical empty list result — every transport fallback must use this (baseRef defaults to "main"). */
export function emptyLaneEventsListResult(laneId: string): LaneEventsListResult {
  return {
    laneId,
    events: [],
    branches: [],
    chats: [],
    baseRef: "main",
    hasDerived: false,
    generatedAt: new Date().toISOString(),
  };
}

/** Canonical empty summary result — every transport fallback must use this. */
export function emptyLaneEventsSummaryResult(): LaneEventsSummaryResult {
  return { summaries: [], generatedAt: new Date().toISOString() };
}
