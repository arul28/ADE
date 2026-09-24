import {
  collapseActivityPhaseRows,
  mergeReasoningFragment,
  mergeReasoningTextFragments,
  type ActivityPhaseMergeMeta,
} from "../../../shared/chatActivityPhase";
import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatScheduledWorkStatus, AgentChatSpawnKind, AgentChatStopSource, CodexWebSearchResult } from "../../../shared/types";
import {
  deriveSubagentCardName,
  isBackgroundShellCommand,
  isGenericSubagentName,
  isRealSubagent,
  longerSubagentText,
  normalizeSubagentLifecycleEvent,
  preferSubagentSummary,
  preferredSubagentAgentType,
  subagentAgentKey,
  SUBAGENT_PLACEHOLDER_SUMMARY,
  isSubagentPlaceholderSummary,
  type NormalizedSubagentLifecycleEvent,
} from "../../../shared/chatSubagents";
import { backgroundCommandLabel } from "../../../shared/chatScheduledWork";
import { sceneRowIdentity } from "../../../shared/chatScene";
import { adeCardProgressTotal, adeCardRowKey } from "../../../shared/adeCard";
import {
  contextCompactMergeKey,
  isContextCompactionChatEvent,
  mergeNormalizedContextCompact,
  normalizeContextCompactEvent,
  toContextCompactChatEvent,
} from "../../../shared/contextCompaction";
import {
  hostSleepNoticeMergeKey,
  isHostResumedNoticeEvent,
  isHostSleepNoticeEvent,
  type HostSleepNoticeShape,
} from "../../../shared/hostSleepNotice";
import { isLegacyProviderRetryNotice } from "../../../shared/providerRetryPresentation";
import { groupStoppedSubagentResultCards, subagentResultKey, subagentSpawnKey } from "./chatSubagentCardGrid";
import { groupedEnvelopeTurnId } from "./chatTranscriptTurnFolds";
import {
  isChatTaskListEvent,
  reduceChatTaskList,
  type ChatTaskListSnapshot,
} from "../../../shared/chatTaskList";
import {
  classifyTurnFoldEvent,
  inferTurnEndTurnId,
  isForeignTurnEnd,
  snapshotTurnEnd,
  type TurnFold,
  type TurnEndSnapshot,
  type TurnEndStatus,
} from "../../../shared/chatTurnFold";

export type ChatWorkLogStatus = "running" | "completed" | "failed" | "interrupted";
export type ChatWorkLogEntryKind = "tool" | "command" | "file_change" | "web_search" | "hook";
export type ChatWorkLogEntryTone = "tool" | "info" | "error";

export type ChatLocalhostUrl = {
  url: string;
  href: string;
  host: string;
  port: number | null;
};

export type ChatWorkLogFileChange = {
  path: string;
  kind: Extract<AgentChatEvent, { type: "file_change" }>["kind"];
  additions: number;
  deletions: number;
  diff: string;
};

export type ChatWorkLogEntry = {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<ChatWorkLogFileChange>;
  tone: ChatWorkLogEntryTone;
  status: ChatWorkLogStatus;
  entryKind: ChatWorkLogEntryKind;
  toolName?: string;
  mcp?: NonNullable<Extract<AgentChatEvent, { type: "tool_call" }>["mcp"]>;
  args?: unknown;
  result?: unknown;
  output?: string;
  localUrls?: ReadonlyArray<ChatLocalhostUrl>;
  cwd?: string;
  query?: string;
  action?: string;
  actions?: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["actions"]>;
  /** Structured web-search results (max 8), rendered as compact external links. */
  results?: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["results"]>;
  /** Result count before the producer capped `results` — drives the "+N more" line. */
  resultsTotal?: number;
  itemId?: string;
  turnId?: string;
  parentItemId?: string;
};

type HiddenTranscriptEvent =
  | Extract<AgentChatEvent, { type: "activity" }>
  | Extract<AgentChatEvent, { type: "step_boundary" }>
  | Extract<AgentChatEvent, { type: "tool_call" }>
  | Extract<AgentChatEvent, { type: "tool_result" }>
  | Extract<AgentChatEvent, { type: "command" }>
  | Extract<AgentChatEvent, { type: "file_change" }>
  | Extract<AgentChatEvent, { type: "web_search" }>
  | Extract<AgentChatEvent, { type: "reasoning" }>
  | Extract<AgentChatEvent, { type: "pending_input_resolved" }>
  | Extract<AgentChatEvent, { type: "tokens" }>
  | Extract<AgentChatEvent, { type: "api_retry" }>
  | Extract<AgentChatEvent, { type: "codex_moderation_metadata" }>
  // Answer citations feed Sources, the turn chip, and the fold count only.
  | Extract<AgentChatEvent, { type: "sources" }>
  // Token usage drives the chat-column-bottom token footer; inline transcript
  // rows would be duplicate noise.
  | Extract<AgentChatEvent, { type: "codex_token_usage" }>;

type ChatTranscriptVisibleEvent = Exclude<AgentChatEvent, HiddenTranscriptEvent>;

export type RenderReasoningEvent = Extract<AgentChatEvent, { type: "reasoning" }> & {
  /** First fragment's timestamp; the row's own timestamp is the latest one. */
  startTimestamp?: string;
  /**
   * Set only on an activity-phase merge (thought → tool → thought): when the
   * LAST merged thinking run started. The live timer counts from here, and a
   * finished row shows no duration because its span also covers tool work.
   */
  latestStartTimestamp?: string;
  /**
   * Set only by `mergeAdjacentThoughtRows` (chatThoughtRuns.ts): the drawn
   * Thought row stands for these rows, the first of which lends its key.
   */
  thoughtMemberKeys?: string[];
  /**
   * The merged row's duration: every member's measured duration summed, or
   * null when any member has none. Read only when `thoughtMemberKeys` is set.
   */
  thoughtRunDurationSeconds?: number | null;
};

type WorkLogRenderEvent = {
  type: "work_log_entry";
  entry: ChatWorkLogEntry;
  collapseKey?: string;
};

export type ChatWorkLogGroupEvent = {
  type: "work_log_group";
  entries: ChatWorkLogEntry[];
  summary?: string;
  toolUseIds?: string[];
  turnId?: string | null;
};

export type ChatActivityBundleItem = {
  key: string;
  timestamp: string;
  event: Extract<AgentChatEvent, { type: "scheduled_work_update" }>;
};

export type ChatActivityBundleEvent = {
  type: "activity_bundle";
  items: ChatActivityBundleItem[];
  turnId?: string | null;
};

type SubagentCardStatus = "running" | "completed" | "stopped" | "failed";
type SubagentCardTerminalStatus = Exclude<SubagentCardStatus, "running">;

/**
 * Anchor row for a real subagent, pushed once where the agent started and then
 * mutated IN PLACE (new object, same key) as progress arrives. When the agent
 * ends, this same row becomes its {@link SubagentResultCardRenderEvent}: same
 * position, same key. The thread keeps one card per agent.
 * Row key: `subagent-spawn:${agentKey}`.
 */
export type SubagentSpawnAnchorRenderEvent = {
  type: "subagent_spawn_anchor";
  agentKey: string;
  description: string;
  agentType: string | null;
  /** Explicit provider for spawned ADE chats; absent for runtime-native tasks. */
  provider: string | null;
  /**
   * Explicit display name from the lifecycle events (Claude Task `name`, Codex
   * nickname, Cursor label). The card title comes from
   * `deriveSubagentCardName` over description, label, and agentType.
   */
  label?: string | null;
  background: boolean;
  status: "running";
  /** Last meaningful progress summary (placeholder summaries never displace a real one). */
  statusLine: string | null;
  lastToolName: string | null;
  toolCount: number | null;
  startedAt: string;
  /** A reopened card has no settled end or prior result. */
  endedAt?: null;
  resultSummary?: null;
  /**
   * Spawned-ADE-chat navigation. Set only when the source lifecycle event carried
   * a `chat:<id>` taskId (a spawned peer/subagent chat, not a runtime-native
   * subagent). The whole card becomes a button that navigates to this session.
   */
  childSessionId: string | null;
  /** Provider task id for the per-task stop control; null when this card navigates. */
  taskId: string | null;
  /** Cosmetic relationship + completion-report policy; null for runtime-native subagents. */
  spawnKind: AgentChatSpawnKind | null;
  /** Best-effort parent label (parent's description/agentType); null/absent if unknown. */
  parentLabel?: string | null;
};

/**
 * A settled agent's card. Normally the agent's spawn row converted IN PLACE,
 * so it keeps the spawn's position and its `subagent-spawn:${agentKey}` key.
 * Only when the window holds no spawn row for the agent (its start sits in an
 * unloaded older page) is the card appended where the result arrives, under
 * `subagent-result:${agentKey}`. Either way it is mutated in place if a richer
 * summary arrives later. Jumps that name `subagent-result:${agentKey}` resolve
 * to whichever key the card holds (`subagentCardRowKeyCandidates`).
 */
export type SubagentResultCardRenderEvent = {
  type: "subagent_result_card";
  agentKey: string;
  /** Task title, carried so the stopped-group card can label each folded agent. */
  description: string | null;
  /** Agent type and explicit label, carried for the card name (`deriveSubagentCardName`). */
  agentType?: string | null;
  /** Explicit provider for spawned ADE chats; absent for runtime-native tasks. */
  provider?: string | null;
  background?: boolean;
  label?: string | null;
  status: SubagentCardTerminalStatus;
  summaryPreview: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  toolUseCount: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  parentLabel: string | null;
  /** WHO stopped this agent; "unknown" for an event that did not say. */
  stopSource: AgentChatStopSource;
  /** Plain clause naming the cause of a non-user stop. */
  stopReason: string | null;
  /** Last thing this agent was observed doing before it ended. */
  lastActivity: string | null;
  /** True when a real report had already landed before the stop. */
  resultLanded: boolean;
  /**
   * Spawned-ADE-chat navigation, carried over from the running card so a
   * settled child chat stays openable. Null for runtime-native subagents.
   */
  childSessionId: string | null;
  /** Cosmetic relationship; null for runtime-native subagents. */
  spawnKind: AgentChatSpawnKind | null;
};

/** One folded agent inside a {@link SubagentStoppedGroupEvent}. */
export type SubagentStoppedGroupItem = {
  agentKey: string;
  title: string;
  /** What it was doing when it ended; null when nothing was ever observed. */
  lastActivity: string | null;
  /**
   * Whether this agent's report had already landed. A folded row that says
   * only "stopped" hides the difference between work that was lost and work
   * that was finished and then discarded by the fold.
  */
  resultLanded: boolean;
};

/**
 * Why a run of subagents all ended at once. Only same-cause runs fold together:
 * "12 agents stopped" is a useful sentence exactly when the twelve share one
 * explanation, and a lie the moment they do not.
 */
export type SubagentStoppedGroupCause = "interrupt" | "usage_limit";

/**
 * A run of more than `SUBAGENT_CARD_GRID_MAX_COLUMNS` consecutive subagent
 * result cards that all ended for the same reason with no report, folded into
 * one calm card so a mass stop (a dozen — or fifty — agents) renders as a
 * single line instead of a wall of identical cards.
 * Produced by the second-layer grouping pass; never emitted by the first-layer
 * collapse. Row key: `subagent-stopped-group:${cause}:${firstAgentKey}`.
 */
export type SubagentStoppedGroupEvent = {
  type: "subagent_stopped_group";
  cause: SubagentStoppedGroupCause;
  /**
   * Who stopped the run. Only `user` earns "when you interrupted"; every other
   * source has to name itself, because an ADE restart and a sibling brain
   * taking the chat over both used to render as the reader's own doing.
   */
  stopSource: AgentChatStopSource;
  /** Plain clause rendered after "N agents stopped: " for a non-user stop. */
  stopReason: string | null;
  count: number;
  items: SubagentStoppedGroupItem[];
  /**
   * Row keys of the folded result cards (`subagent-spawn:<agentKey>` for a card
   * that settled in place, `subagent-result:<agentKey>` for one appended without
   * its spawn). A jump or event anchor that names one of them lands on this
   * group row.
   */
  memberKeys: string[];
};

/**
 * The whole in-thread presence of a backgrounded shell command: ONE quiet
 * one-liner, pushed where the job started and mutated in place through to its
 * terminal state (no spawn/result cards, and never a second row).
 *
 * It used to be a finish-only chip, so a job that ran for minutes left the
 * thread completely silent while the sidebar flipped to a duration-less
 * "Working" — the two together read as a stalled turn. Showing the line from
 * the start costs no extra rows (the terminal update reuses this one) and gives
 * the run somewhere to point at.
 *
 * TWO producers feed this one row type, and they must land on the SAME key or a
 * mixed transcript renders the job twice:
 *   - the live Claude runtime, which reports background shells as
 *     `scheduled_work_update {kind:"background_task"}` (see
 *     `emitClaudeBackgroundTaskUpdate`) — this is the only producer a running
 *     app actually emits;
 *   - legacy `subagent_*` lifecycle events carrying `taskType: background`,
 *     which is all that older persisted transcripts contain.
 *
 * Row key: `background-chip:${agentKey}` — unchanged from the finish-chip era on
 * purpose; the virtualizer's measuredHeights are keyed by it.
 *
 * Modelled as a union so "running ⇒ no outcome yet" is enforced by the type
 * rather than by a comment on four independently-nullable fields.
 */
export type BackgroundJobLineRenderEvent = {
  type: "background_job_line";
  agentKey: string;
  label: string;
  startedAt: string | null;
  /** Provider task id when ADE can stop this job via `stopTask`. */
  taskId?: string | null;
} & (
  | { status: "running" }
  | {
      status: SubagentCardTerminalStatus;
      /** Null when the producer reports no exit code (the live runtime does not). */
      exitCode: number | null;
      /** Wall-clock between the job's first and last row update. */
      durationMs: number | null;
    }
);

/** One job inside a {@link BackgroundJobGroupRenderEvent}: the line row it stands for. */
export type BackgroundJobGroupMember = {
  key: string;
  timestamp: string;
  event: BackgroundJobLineRenderEvent;
};

/**
 * A run of 2+ consecutive background job lines, whatever their labels and
 * statuses, drawn as ONE compact row (`$ 5 background jobs · 1 running · 3 done
 * · 1 failed ›`) that expands inline to one line per job. Five separate job
 * lines in a row filled a viewport with rules; the chat actions pane already
 * lists each job, so the thread only needs the fact that they ran.
 *
 * Produced by `groupBackgroundJobRuns` (`chatBackgroundJobRuns.ts`) on the
 * drawn rows, after the presentation filter and before the turn fold, so rows
 * the timeline never draws cannot split a run and the fold sees one row. The
 * row key is the FIRST member's own row key (like `subagent_card_grid`), so a
 * lone job line that gains a neighbour stays mounted and keeps its measured
 * height. Never emitted by the collapse pass.
 */
export type BackgroundJobGroupRenderEvent = {
  type: "background_job_group";
  members: BackgroundJobGroupMember[];
  /**
   * Every member's row key, first to last. A job's row key is fixed at first
   * sighting, so the turn fold's turn-end snapshot, jumps, and scroll memory
   * resolve a member through these.
   */
  memberKeys: string[];
};

export type ScheduledWakeDividerRenderEvent = {
  type: "scheduled_wake_divider";
  scheduleId: string;
  kind: "wakeup" | "cron" | "loop";
  reason: string | null;
  firedAt: string;
  late: boolean;
  turnId?: string;
};

/**
 * Header row rendered above a completion message delivered when a spawned
 * `subagent` finished (`user_message.metadata.spawnCompletion`). Carries the
 * child session id so the row's `[open ›]` affordance navigates to the child.
 * Row key: `spawn-wake:${childSessionId}:${turnId}`.
 */
export type SpawnWakeDividerRenderEvent = {
  type: "spawn_wake_divider";
  childSessionId: string;
  childTitle: string;
  spawnKind: AgentChatSpawnKind;
  status: "completed" | "failed" | "stopped";
  summary: string | null;
  turnId?: string;
};

/** One member of a {@link SubagentCardGridEvent}: the card row as the collapse built it. */
export type SubagentCardGridMember = {
  key: string;
  timestamp: string;
  event: SubagentSpawnAnchorRenderEvent | SubagentResultCardRenderEvent;
};

/**
 * A run of 2+ consecutive subagent cards of ANY state (running, finished,
 * failed, stopped), drawn side by side as one grid row. Cards settle in place,
 * so a grid keeps its cards and their order while agents finish one by one.
 * Produced by {@link groupSubagentCardGrids} on the presented rows, before the
 * turn fold.
 *
 * Row key: the FIRST member's own row key. A lone card renders through the
 * same grid component, so a second card joining keeps the first mounted, and
 * the row keeps its measured height (a side-by-side row is about as tall as
 * one card).
 */
export type SubagentCardGridEvent = {
  type: "subagent_card_grid";
  members: SubagentCardGridMember[];
  /** Member row keys, first to last (`members[0].key` is the row key). */
  memberKeys: string[];
};

/**
 * One CTO voice call, folded into a single row. Produced by the grouping pass
 * only — nothing persists it and no emitter produces it. Deliberately NOT part
 * of `ChatTranscriptRenderEvent`: it can only exist after grouping, so it lives
 * in `ChatTranscriptGroupedEnvelope["event"]`.
 * Row key: `voice-call:${callId}`.
 */
export type VoiceCallGroupRenderEvent = {
  type: "voice_call_group";
  callId: string;
  /** Wall-clock the folded rows span, ms. Null when only one timestamp exists. */
  durationMs: number | null;
  /** How many things the user said in the call (user_message rows). */
  exchanges: number;
  /** The first thing the user said, one line, clipped. Null if nothing was said. */
  openingLine: string | null;
  /** True when the call raised at least one approval. */
  hadApproval: boolean;
  /** The folded rows, in order, already grouped by the normal passes. */
  rows: ChatTranscriptGroupedEnvelope[];
};

/**
 * The one row a finished turn's intermediate work folds into
 * (`Worked for 4m 12s · 18 tools`). Presentation only and produced last, by
 * {@link applyChatTranscriptTurnFolds}: nothing persists it, no emitter produces
 * it, and no grouping pass sees it. Row key: `turn-fold:${turnId}`.
 */
export type TurnFoldRenderEvent = {
  type: "turn_fold";
  foldId: string;
  turnId: string;
  /** Row key of the turn's `done` row (duration, tools, and files are keyed by it). */
  turnEndKey: string;
  status: TurnEndStatus;
  /** Rows hidden while the fold is closed. */
  hiddenCount: number;
  subagentCount: number;
  /** Background jobs in the span, and how many failed (`· 5 jobs (1 failed)`). */
  jobCount?: number;
  failedJobCount?: number;
};

export type TurnDiagnosticsEvent = Extract<AgentChatEvent, { type: "turn_diagnostics" }>;
export type TurnRecoveryReceiptEvent = Extract<AgentChatEvent, { type: "turn_recovery" | "codex_turn_recovery" }>;

/**
 * ONE "Turn details" row per turn: every `turn_diagnostics` snapshot and the
 * recovery receipt (`turn_recovery` / legacy `codex_turn_recovery`) of that
 * turn. Produced by the collapse pass only. Codex emits diagnostics under two
 * keys — its session-startup key (MCP startup, before the turn has an id) and
 * the turn id — so the id-less snapshot joins the details row of the window it
 * arrived in (see {@link upsertTurnDetailsRow}); keying by the emitter's key
 * drew two "Turn details" rows for one turn.
 *
 * Row key: `turn-details:<turnId>`, or the first event's own row key when the
 * first contribution had no turn id. Both are identity-based, so a replay
 * assigns the same key.
 */
export type TurnDetailsRenderEvent = {
  type: "turn_details";
  /** The turn these details belong to, once any contribution named it. */
  turnId?: string;
  /** Latest cumulative diagnostics snapshot per emitter key, first-seen order. */
  diagnostics: ReadonlyArray<{ source: string; event: TurnDiagnosticsEvent }>;
  /** The turn's latest recovery receipt; the provider-neutral shape wins over the Codex alias. */
  recovery: TurnRecoveryReceiptEvent | null;
};

/**
 * The chat's ONE task list (see `shared/chatTaskList.ts`). Every `plan` and
 * `todo_update` that writes the list moves this single row to where that event
 * landed — the row is removed from its old position and appended, keeping its
 * key — so the thread shows exactly one task list, at the turn of its latest
 * update. A list that is cleared removes the row.
 *
 * Row key: `task-list:<sessionId>` ({@link taskListRowKey}).
 */
export type TaskListRenderEvent = {
  type: "task_list";
  list: ChatTaskListSnapshot;
  /** Turn of the event that last moved the row, for fold-window membership. */
  turnId?: string;
};

export const TASK_LIST_ROW_KEY_PREFIX = "task-list:";

export function taskListRowKey(sessionId: string): string {
  return `${TASK_LIST_ROW_KEY_PREFIX}${sessionId}`;
}

export function isTaskListRowKey(key: string): boolean {
  return key.startsWith(TASK_LIST_ROW_KEY_PREFIX);
}

/** What a Turn details row adds up to: summed checks, integrations deduped by name. */
export function summarizeTurnDetails(event: TurnDetailsRenderEvent): {
  moderationChecks: number;
  integrations: Array<{ integration: string; message?: string | null }>;
} {
  let moderationChecks = 0;
  const integrations = new Map<string, { integration: string; message?: string | null }>();
  for (const { event: diagnostics } of event.diagnostics) {
    moderationChecks += Math.max(0, diagnostics.moderationChecks ?? 0);
    for (const failure of diagnostics.optionalIntegrationFailures ?? []) {
      const previous = integrations.get(failure.integration);
      integrations.set(failure.integration, failure.message ? failure : previous ?? failure);
    }
  }
  return { moderationChecks, integrations: [...integrations.values()] };
}

export type ChatTranscriptRenderEvent =
  | ChatTranscriptVisibleEvent
  | RenderReasoningEvent
  | WorkLogRenderEvent
  | SubagentSpawnAnchorRenderEvent
  | SubagentResultCardRenderEvent
  | BackgroundJobLineRenderEvent
  | ScheduledWakeDividerRenderEvent
  | SpawnWakeDividerRenderEvent
  | TurnDetailsRenderEvent
  | TaskListRenderEvent;

export type ChatTranscriptRenderEnvelope = {
  key: string;
  timestamp: string;
  event: ChatTranscriptRenderEvent;
  /**
   * How many folded events this row stands for. Set only by the adjacency fold
   * for `spawn_completed` notices, which the chip renders as a trailing `×N`.
   * Render-side only: nothing persists it and no emitter produces it.
   */
  repeatCount?: number;
  /**
   * The CTO voice call this row was produced by, copied off the source
   * envelope's `provenance.voiceCallId`. Consecutive rows sharing one id fold
   * into a single `voice_call_group` row (see {@link groupVoiceCallRows}).
   */
  voiceCallId?: string;
  /**
   * What names this row on disk for a scene drawn in it.
   *
   * Derived here, from the row's own event and key, because row identity is a
   * property of the row: the renderer had been recomputing it at the point of
   * use, which put the one function whose answer is a FILE NAME in the project
   * — stable across every rebuild of the transcript, or the scene re-runs and
   * re-files on every reopen — in a component's render body. See
   * {@link sceneRowIdentity}.
   *
   * Optional only because the row builders below construct envelopes literally;
   * every row that leaves this module through a collapse entry point has been
   * stamped, so a reader may treat an absent one as "this row cannot hold a
   * scene" rather than "not computed yet".
   */
  sceneScopeKey?: string;
};

export type ChatTranscriptGroupedEnvelope = {
  key: string;
  timestamp: string;
  event:
    | ChatTranscriptRenderEvent
    | ChatWorkLogGroupEvent
    | ChatActivityBundleEvent
    | SubagentStoppedGroupEvent
    | SubagentCardGridEvent
    | BackgroundJobGroupRenderEvent
    | VoiceCallGroupRenderEvent
    | TurnFoldRenderEvent;
  /** Carried through from `ChatTranscriptRenderEnvelope`; see its `repeatCount`. */
  repeatCount?: number;
  /** Carried through from `ChatTranscriptRenderEnvelope`; see its `voiceCallId`. */
  voiceCallId?: string;
  /** Carried through from `ChatTranscriptRenderEnvelope`; see its `sceneScopeKey`. */
  sceneScopeKey?: string;
};

type PlanTranscriptEvent = Extract<AgentChatEvent, { type: "plan" }>;
type TodoUpdateTranscriptEvent = Extract<AgentChatEvent, { type: "todo_update" }>;
type TaskListSourceEvent = PlanTranscriptEvent | TodoUpdateTranscriptEvent;

/**
 * Live per-subagent state threaded through the collapse pass. `rowIndex` lets an
 * appended progress/result event index back into the rows array and mutate the
 * anchor in place. Subagent lifecycle handling splices exactly one kind of row —
 * a stale background-job line the scheduled-work producer opened for what turns
 * out to be a real subagent; transcript retractions remove text rows. Both
 * repair every stored position afterwards.
 */
type SubagentAnchorState = {
  agentKey: string;
  /**
   * Stable identity used for row keys. Fixed at creation from the first agentKey
   * seen and NEVER changed on rebind — the virtualizer's measuredHeights and
   * sticky-bottom depend on it. The displayed `agentKey` may migrate taskId →
   * agentId, but the render keys stay put.
   */
  renderKeyBase: string;
  /**
   * Index of the agent's ONE card row: the spawn anchor, which the terminal
   * event converts in place into the result card (null for background-shell
   * commands, and until the first card lands).
   */
  rowIndex: number | null;
  /**
   * Key of that card row: `subagent-spawn:` when the spawn was in the window,
   * `subagent-result:` when the result arrived without it. Fixed once set, so
   * the card keeps its measured height across the running -> settled change.
   */
  cardKey: string | null;
  /** Index of the background finish-chip row (null unless a background shell). */
  /**
   * Latched once this task has opened a background-job line. Classification is
   * derived per event and can legitimately FLIP: a late `agentType` upgrades
   * `background` to a real subagent type, which would otherwise strand the
   * running one-liner forever AND push a full result card for the same task.
   * Once the line exists, the task stays a background job.
   */
  backgroundLineOpened: boolean;
  /**
   * Longest description any lifecycle event carried. Drives classification and
   * the job-line label, NOT the card title: Claude's `task_progress` frames put
   * the current activity ("Running …", "Reading <path>") in `description`.
   */
  description: string | null;
  /** The card title: the description the FIRST `subagent_started` carried. */
  title: string | null;
  /** First explicit display name (Claude Task `name`, Codex nickname, Cursor label). */
  label: string | null;
  agentType: string | null;
  provider: string | null;
  taskType: string | null;
  command: string | null;
  background: boolean;
  startedAt: string;
  endedAt: string | null;
  progressSummary: string | null;
  statusLine: string | null;
  lastToolName: string | null;
  toolCount: number | null;
  status: SubagentCardStatus;
  resultSummary: string | null;
  error: string | null;
  /** Child session id for a spawned ADE chat (`chat:<id>` taskId); null otherwise. */
  childSessionId: string | null;
  /**
   * Provider task id for per-task stop. Null for spawned ADE chats (`chat:<id>`)
   * — those navigate rather than stop in-place.
   */
  taskId: string | null;
  /** Spawn-kind carried on the `subagent_started` event; null for runtime-native subagents. */
  spawnKind: AgentChatSpawnKind | null;
  /** Result-only usage/worktree metadata surfaced on the result card. */
  totalTokens: number | null;
  toolUseCount: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  /** Parent agent id carried on any lifecycle event; resolves the parent label. */
  parentAgentId: string | null;
};

type CollapseTranscriptContext = {
  latestTodoItemsByTurn: Map<string, TodoUpdateTranscriptEvent["items"]>;
  /** Subagent lifecycle state keyed by agentKey (agentId ?? taskId). */
  subagentAnchors: Map<string, SubagentAnchorState>;
  /** Semantic provider failures already rendered for a specific turn. */
  errorKeysByTurn: Set<string>;
  /** Durable user-message lifecycle rows keyed by ADE steer id. */
  userMessageRowIndexBySteer: Map<string, number>;
  /** Resolution events that arrived before their durable user-message row. */
  unmatchedUserMessageResolutionsBySteer: Map<
    string,
    Extract<AgentChatEvent, { type: "user_message_resolution" }>
  >;
  /** The one `turn_details` row of each turn, keyed by turn id. */
  turnDetailsRowIndexByTurn: Map<string, number>;
  /**
   * The `turn_details` row of the current window (since the last user message
   * or own turn end), which an id-less diagnostics snapshot joins. Null when
   * the window has none yet.
   */
  turnDetailsWindowRowIndex: number | null;
  /** Actionable stalled-turn card keyed by turn id. */
  stalledRowIndexByTurn: Map<string, number>;
  /**
   * `ade_card` rows keyed by `cardId`. A repeat emit mutates the stored row IN
   * PLACE (new object, SAME key) so the virtualizer's measured height survives
   * the update — the same discipline as the subagent spawn anchor above.
   */
  adeCardRowIndexById: Map<string, number>;
  /**
   * `background_job_line` rows keyed by their row key. Keyed by row key rather
   * than task id because two different producers (live scheduled-work updates
   * and legacy subagent lifecycle events) upsert into the same key space.
   */
  backgroundJobRowIndexByKey: Map<string, number>;
  /**
   * Identical system notices already rendered, scoped per turn. Dedupe used to
   * compare against the IMMEDIATELY previous row, so any row pushed between two
   * copies of the same notice — a background job line, a work-log entry — broke
   * the adjacency and the notice repeated. A real transcript ended up with the
   * same `Approaching Claude plan limit` card half a dozen times in one turn.
   *
   * Keyed by the full notice signature INCLUDING its turn id, so a different
   * kind, different text, different detail, or a later turn all still render.
   */
  systemNoticeSignatures: Set<string>;
  /** Approval / question item ids that already received `pending_input_resolved`. */
  resolvedInputItemIds: Set<string>;
  /**
   * What was live when each turn's `done` arrived, keyed by turn id. Taken once
   * (the first `done` for a turn wins) while events replay in order, so the
   * turn fold's keep-visible decision is sticky and a reload reproduces it.
   */
  turnEndSnapshots: Map<string, TurnEndSnapshot>;
  /**
   * How many events so far share each row-key base (see
   * `allocateTranscriptEventRowKey`). Carried so an incremental append numbers
   * a repeated base exactly as a full replay does.
   */
  eventRowKeyOrdinals: Map<string, number>;
  /**
   * Row keys of `done` rows that ended someone else's window (a subagent's
   * turn inside the parent's; see `isForeignTurnEnd`). The parent's snapshot
   * walks back over them instead of stopping, whichever order the two arrive.
   */
  foreignTurnEndKeys: Set<string>;
  /** Position of the one `task_list` row, or null while the chat has none. */
  taskListRowIndex: number | null;
};

export function createCollapseTranscriptContext(): CollapseTranscriptContext {
  return {
    latestTodoItemsByTurn: new Map(),
    subagentAnchors: new Map(),
    errorKeysByTurn: new Set(),
    userMessageRowIndexBySteer: new Map(),
    unmatchedUserMessageResolutionsBySteer: new Map(),
    turnDetailsRowIndexByTurn: new Map(),
    turnDetailsWindowRowIndex: null,
    stalledRowIndexByTurn: new Map(),
    adeCardRowIndexById: new Map(),
    backgroundJobRowIndexByKey: new Map(),
    systemNoticeSignatures: new Set(),
    resolvedInputItemIds: new Set(),
    turnEndSnapshots: new Map(),
    eventRowKeyOrdinals: new Map(),
    foreignTurnEndKeys: new Set(),
    taskListRowIndex: null,
  };
}

/** Turn-end snapshots recorded by a collapse pass; empty without a context. */
export function readTurnEndSnapshots(
  context: CollapseTranscriptContext | null | undefined,
): ReadonlyMap<string, TurnEndSnapshot> {
  return context?.turnEndSnapshots ?? EMPTY_TURN_END_SNAPSHOTS;
}

const EMPTY_TURN_END_SNAPSHOTS: ReadonlyMap<string, TurnEndSnapshot> = new Map();

function renderEventTurnId(event: ChatTranscriptRenderEvent): string | null {
  const value = (event as { turnId?: unknown }).turnId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Record what was live when this turn ended. The window is every row after the
 * turn's user message (or the previous turn end that owned its window), in its
 * state right now — keyed rows mutate in place later, which is exactly why this
 * is taken here. The window rules match `deriveTurnFolds`: a subagent's `done`
 * inside the window is stepped over (and recorded as foreign, so no snapshot
 * is taken for it), and an id-less `done` is filed under the inferred turn id.
 */
function recordTurnEndSnapshot(
  rows: ChatTranscriptRenderEnvelope[],
  event: Extract<AgentChatEvent, { type: "done" }>,
  rowKey: string,
  context: CollapseTranscriptContext,
): void {
  let start = rows.length;
  let boundaryTurnId: string | null = null;
  const windowTurnIds = new Set<string>();
  while (start > 0) {
    const row = rows[start - 1]!;
    if (row.event.type === "done") {
      if (!context.foreignTurnEndKeys.has(row.key)) break;
    } else if (classifyTurnFoldEvent(row.event) === "boundary") {
      boundaryTurnId = renderEventTurnId(row.event);
      if (boundaryTurnId) windowTurnIds.add(boundaryTurnId);
      break;
    } else {
      const rowTurnId = renderEventTurnId(row.event);
      if (rowTurnId) windowTurnIds.add(rowTurnId);
    }
    start -= 1;
  }
  const ownTurnId = event.turnId?.trim() || null;
  if (isForeignTurnEnd(ownTurnId, windowTurnIds)) {
    context.foreignTurnEndKeys.add(rowKey);
    return;
  }
  const windowRows = rows.slice(start);
  const turnId = ownTurnId ?? inferTurnEndTurnId(
    boundaryTurnId,
    windowRows.map((row) => ({ role: classifyTurnFoldEvent(row.event), turnId: renderEventTurnId(row.event) })),
  );
  if (!turnId || context.turnEndSnapshots.has(turnId)) return;
  context.turnEndSnapshots.set(turnId, snapshotTurnEnd(windowRows, {
    isInputResolved: (itemId) => context.resolvedInputItemIds.has(itemId),
    isTodoListUnfinished: (todoTurnId) => (
      context.latestTodoItemsByTurn.get(todoSnapshotKey(todoTurnId))
        ?.some((item) => item.status !== "completed") ?? false
    ),
  }));
}

/**
 * Identity of a system notice for per-turn dedupe: everything a reader would use
 * to tell two notices apart, plus the turn they belong to.
 */
function systemNoticeSignature(
  event: Extract<AgentChatEvent, { type: "system_notice" }>,
): string {
  return JSON.stringify([
    event.turnId ?? null,
    event.noticeKind ?? null,
    event.message.trim(),
    event.detail ?? null,
  ]);
}

/**
 * Where a turn-details contribution lands: the row already holding this turn
 * id, else the current window's row when the two cannot disagree (either side
 * has no turn id yet, or both name the same turn). Without a carried context,
 * the same answer comes from a reverse scan of the window.
 */
function findTurnDetailsRowIndex(
  rows: readonly ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext | undefined,
  turnId: string | null,
): number | null {
  const joinsWindowRow = (index: number | null | undefined): index is number => {
    if (index == null) return false;
    const event = rows[index]?.event;
    return event?.type === "turn_details" && (!turnId || !event.turnId || event.turnId === turnId);
  };
  if (context) {
    const byTurn = turnId ? context.turnDetailsRowIndexByTurn.get(turnId) : undefined;
    if (byTurn != null && rows[byTurn]?.event.type === "turn_details") return byTurn;
    return joinsWindowRow(context.turnDetailsWindowRowIndex) ? context.turnDetailsWindowRowIndex : null;
  }
  let windowRow: number | null = null;
  let inWindow = true;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index]!.event;
    if (event.type === "done" || classifyTurnFoldEvent(event) === "boundary") {
      if (!turnId) break;
      inWindow = false;
      continue;
    }
    if (event.type !== "turn_details") continue;
    if (turnId && event.turnId === turnId) return index;
    if (inWindow && windowRow === null && joinsWindowRow(index)) windowRow = index;
  }
  return windowRow;
}

/**
 * Merge one diagnostics snapshot or recovery receipt into its turn's single
 * `turn_details` row, creating the row (at this position) when the turn has
 * none. The row keeps its key and position on every update, so its measured
 * height and its place inside the turn fold's span survive.
 */
function upsertTurnDetailsRow(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  rowKey: string,
  context: CollapseTranscriptContext | undefined,
  turnId: string | null,
  apply: (details: TurnDetailsRenderEvent) => TurnDetailsRenderEvent,
): void {
  const index = findTurnDetailsRowIndex(rows, context, turnId);
  const existing = index != null ? rows[index] : undefined;
  if (index != null && existing?.event.type === "turn_details") {
    const next = apply(existing.event);
    rows[index] = {
      ...existing,
      timestamp: envelope.timestamp,
      event: turnId && !next.turnId ? { ...next, turnId } : next,
    };
    if (turnId) context?.turnDetailsRowIndexByTurn.set(turnId, index);
    return;
  }
  const rowIndex = rows.length;
  rows.push({
    key: turnId ? `turn-details:${turnId}` : `turn-details:${rowKey}`,
    timestamp: envelope.timestamp,
    event: apply({ type: "turn_details", ...(turnId ? { turnId } : {}), diagnostics: [], recovery: null }),
  });
  if (context) {
    if (turnId) context.turnDetailsRowIndexByTurn.set(turnId, rowIndex);
    context.turnDetailsWindowRowIndex = rowIndex;
  }
}

function todoSnapshotKey(turnId: string | null): string {
  return turnId ?? "__global__";
}

/**
 * Row position of the one `task_list` row. The carried index is the fast path;
 * the reverse scan keeps a context-free append (and the parity with a full
 * replay) correct.
 */
function findTaskListRowIndex(
  rows: readonly ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext | undefined,
): number | null {
  const stored = context?.taskListRowIndex;
  if (stored != null && rows[stored]?.event.type === "task_list") return stored;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]!.event.type === "task_list") return index;
  }
  return null;
}

/**
 * Apply a list event to the chat's one task list and move its row to the end
 * (where this event lands). The row keeps its key through every move, so its
 * open state and measured height follow it; the list anchor keeps a reader who
 * is scrolled up where they are when the row leaves the rows above them.
 */
function upsertTaskListRow(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  event: TaskListSourceEvent,
  context: CollapseTranscriptContext | undefined,
): void {
  const index = findTaskListRowIndex(rows, context);
  const existing = index != null ? rows[index] : undefined;
  const current = existing?.event.type === "task_list" ? existing.event.list : null;
  const next = reduceChatTaskList(current, event);
  if (next === current) return;
  if (index != null) {
    rows.splice(index, 1);
    if (context) repairIndexedTranscriptRowsAfterSplice(context, index);
  }
  if (!next) return;
  const turnId = event.turnId?.trim() || null;
  rows.push(stampSceneScopeKey({
    key: existing?.key ?? taskListRowKey(envelope.sessionId),
    timestamp: envelope.timestamp,
    event: { type: "task_list", list: next, ...(turnId ? { turnId } : {}) },
  }));
  if (context) context.taskListRowIndex = rows.length - 1;
}

function mergePlanTranscriptEvent(previous: PlanTranscriptEvent, incoming: PlanTranscriptEvent): PlanTranscriptEvent {
  const hasIncomingSteps = incoming.steps.length > 0;
  const nextState = incoming.state ?? (hasIncomingSteps ? "updated" : previous.state);
  const preserveStreamingText = nextState === "delta" && !hasIncomingSteps && incoming.streamingText == null;
  return {
    ...previous,
    ...incoming,
    turnId: incoming.turnId ?? previous.turnId,
    itemId: incoming.itemId ?? previous.itemId,
    state: nextState,
    steps: hasIncomingSteps ? incoming.steps : previous.steps,
    explanation: incoming.explanation ?? previous.explanation,
    streamingText: preserveStreamingText ? previous.streamingText : incoming.streamingText,
  };
}

/**
 * Replace a row in place while keeping its voice-call stamp. The stamp is
 * applied by the collapse callers AFTER `appendCollapsedChatTranscriptEvent`
 * returns, so a later event that rewrites an earlier row wholesale (rather than
 * spreading it) would otherwise drop the id and split the call's fold.
 */
function replaceRowPreservingVoiceCall(
  rows: ChatTranscriptRenderEnvelope[],
  index: number,
  next: ChatTranscriptRenderEnvelope,
): void {
  const voiceCallId = rows[index]?.voiceCallId;
  rows[index] = stampSceneScopeKey(voiceCallId ? { ...next, voiceCallId } : next);
}

/**
 * Give a row its scene identity. Recomputed rather than carried, because it is
 * a pure function of the two fields already on the row and a rewritten row has
 * a new event.
 */
function stampSceneScopeKey<T extends ChatTranscriptRenderEnvelope>(row: T): T {
  // Read defensively: the row union is every render event, and only some of
  // them name a message at all. `sceneRowIdentity` falls back to the row key.
  const event = row.event as { messageId?: string | null; turnId?: string | null; itemId?: string | null };
  return { ...row, sceneScopeKey: sceneRowIdentity(event, row.key) };
}

export function summarizeInlineText(value: string, maxChars = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.length) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/**
 * How many rows were appended after `anchorKey`. Fails quiet (0) when the anchor
 * is gone: the row set gets re-grouped, so a missing anchor is expected churn
 * rather than an error worth surfacing.
 */
export function countRowsAppendedSince(rowKeys: readonly string[], anchorKey: string | null): number {
  if (anchorKey === null) return 0;
  const anchorIndex = rowKeys.indexOf(anchorKey);
  if (anchorIndex < 0) return 0;
  return rowKeys.length - anchorIndex - 1;
}

/**
 * {@link countRowsAppendedSince} for a timeline with turn folds applied. The
 * anchor is placed on the LOGICAL (unfolded) row order, so a turn that folds
 * the anchor row away does not reset the count to 0; only rows the timeline
 * draws are counted, so rows hidden in a closed fold are never counted and the
 * fold row counts once, and only when its span starts after the anchor.
 *
 * `visibleKeys` are the drawn rows (folds applied), `logicalKeys` the unfolded
 * rows the folds were derived from; drawn rows other than fold rows are a
 * subsequence of `logicalKeys`. Walks back from the tail, so the cost is the
 * rows after the anchor plus one `indexOf`.
 */
export function countVisibleRowsAppendedSince({
  visibleKeys,
  logicalKeys,
  folds,
  anchorKey,
}: {
  visibleKeys: readonly string[];
  logicalKeys: readonly string[];
  folds: readonly Pick<TurnFold, "foldId" | "spanStartIndex">[];
  anchorKey: string | null;
}): number {
  if (anchorKey === null) return 0;
  if (!folds.length) return countRowsAppendedSince(visibleKeys, anchorKey);
  const spanStartByFoldId = new Map(folds.map((fold) => [fold.foldId, fold.spanStartIndex]));
  // A fold row sits just before its span's first row.
  const anchorFoldStart = spanStartByFoldId.get(anchorKey);
  const anchorLogicalIndex = logicalKeys.indexOf(anchorKey);
  const anchorPosition = anchorLogicalIndex >= 0
    ? anchorLogicalIndex
    : anchorFoldStart !== undefined ? anchorFoldStart - 0.5 : null;
  if (anchorPosition === null) return 0;
  let count = 0;
  let cursor = logicalKeys.length - 1;
  for (let index = visibleKeys.length - 1; index >= 0; index -= 1) {
    const key = visibleKeys[index]!;
    const foldStart = spanStartByFoldId.get(key);
    let position: number;
    if (foldStart !== undefined) {
      position = foldStart - 0.5;
    } else {
      while (cursor >= 0 && logicalKeys[cursor] !== key) cursor -= 1;
      if (cursor < 0) break;
      position = cursor;
    }
    if (position <= anchorPosition) break;
    count += 1;
  }
  return count;
}

function isLowValueHookNotice(event: Extract<AgentChatEvent, { type: "system_notice" }>): boolean {
  if (event.noticeKind !== "hook") return false;
  const message = event.message.trim();
  return /^hook:\s+.+\s+started$/i.test(message)
    || message.toLowerCase() === "trimmed large tool output before sending it back to claude.";
}

function summarizePreToolUseHookError(event: Extract<AgentChatEvent, { type: "system_notice" }>): string | null {
  if (event.noticeKind !== "hook") return null;
  const message = event.message.replace(/\s+/g, " ").trim();
  const match = message.match(/^hook:\s*(PreToolUse:[^\n]+?\s+error)$/i);
  return match?.[1]?.trim() ?? null;
}

const LOCALHOST_URL_PATTERN =
  /https?:\/\/(?<host>localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(?<port>\d{1,5}))?(?<suffix>[^\s<>"']*)?/giu;

function stripTrailingUrlPunctuation(value: string): string {
  let next = value;
  while (/[.,)\]}]$/u.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizeLocalhostHref(url: string, host: string): string {
  if (host === "localhost") return url;
  return url.replace(`://${host}`, "://localhost");
}

export function extractLocalhostUrlsFromText(text: string): ChatLocalhostUrl[] {
  const urls: ChatLocalhostUrl[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(LOCALHOST_URL_PATTERN)) {
    const host = match.groups?.host;
    const portText = match.groups?.port;
    if (!host) continue;
    const port = portText ? Number.parseInt(portText, 10) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) continue;

    const url = stripTrailingUrlPunctuation(match[0]);
    const href = normalizeLocalhostHref(url, host);
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push({ url, href, host, port });
  }

  return urls;
}

function collectTextValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length >= 80 || value == null) return out;
  if (typeof value === "string") {
    if (value.trim().length) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTextValues(entry, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectTextValues(entry, depth + 1, out);
    }
  }
  return out;
}

function appendLocalhostUrls(
  target: ChatLocalhostUrl[],
  seen: Set<string>,
  text: string | undefined,
): void {
  if (!text) return;
  for (const url of extractLocalhostUrlsFromText(text)) {
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    target.push(url);
  }
}

export function deriveLocalhostUrlsForWorkLogEntry(entry: ChatWorkLogEntry): ChatLocalhostUrl[] {
  const urls: ChatLocalhostUrl[] = [];
  const seen = new Set<string>();
  appendLocalhostUrls(urls, seen, entry.command);
  appendLocalhostUrls(urls, seen, entry.output);
  appendLocalhostUrls(urls, seen, entry.detail);
  appendLocalhostUrls(urls, seen, entry.label);
  for (const value of collectTextValues(entry.args)) appendLocalhostUrls(urls, seen, value);
  for (const value of collectTextValues(entry.result)) appendLocalhostUrls(urls, seen, value);
  return urls;
}

function withLocalhostUrls(entry: ChatWorkLogEntry): ChatWorkLogEntry {
  const localUrls = deriveLocalhostUrlsForWorkLogEntry(entry);
  const { localUrls: _previousLocalUrls, ...rest } = entry;
  return localUrls.length > 0 ? { ...rest, localUrls } : rest;
}

function mergeStreamingText(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing}${incoming}`;
}

export function eventHasPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

export function summarizeDiffStats(diff: string): { additions: number; deletions: number } {
  // Both wordings are matched on purpose. The notice is now user-facing (the
  // same compaction feeds phones, so it can no longer talk about "stored chat
  // history"), but transcripts already on disk carry the old text and must keep
  // being recognized as shortened rather than counted as real diff lines.
  // Anchored at the start: the compactor always emits this header as the first
  // line. An unanchored search matched a real diff whose own changed lines
  // quoted the notice — editing this file, for instance — and reported that
  // change as having no additions or deletions.
  const shortenedDiff = diff.startsWith("[ADE] Large file diff was shortened")
    && (diff.includes("bytes were left out.") || diff.includes("bytes omitted from stored chat history."));
  if (shortenedDiff) {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (!line.length) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isGenericToolIdentifier(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !normalized.length || normalized === "other" || normalized === "tool";
}

function readToolTitle(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title.length ? title : null;
}

export function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readIdentityField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * What names an event independently of where it sits in the loaded window.
 *
 * Precedence matches `sceneRowIdentity`: the provider's `messageId` (plus the
 * text `phase`, which splits a Codex commentary from its answer under one id),
 * then `turnId` + `logicalItemId`/`itemId`, then the event's own timestamp.
 * The event type is part of every base, so a tool call and its approval that
 * share an item id never compete for one key.
 */
function transcriptEventIdentityBase(envelope: AgentChatEventEnvelope): string {
  const event = envelope.event as {
    type: string;
    messageId?: unknown;
    phase?: unknown;
    turnId?: unknown;
    itemId?: unknown;
    logicalItemId?: unknown;
  };
  const messageId = readIdentityField(event.messageId);
  if (messageId) {
    const phase = event.type === "text" ? readIdentityField(event.phase) : null;
    return phase ? `${event.type}:m:${messageId}:${phase}` : `${event.type}:m:${messageId}`;
  }
  const turnId = readIdentityField(event.turnId);
  const itemId = readIdentityField(event.logicalItemId) ?? readIdentityField(event.itemId);
  if (turnId && itemId) return `${event.type}:i:${turnId}:${itemId}`;
  return `${event.type}@${envelope.timestamp}`;
}

/**
 * The row key for the row an event opens (if it opens one).
 *
 * Built from the event's own identity, never its index in the loaded list: a
 * prepended older page, a front trim of a background chat, a snapshot merge, or
 * a late mid-list insert must leave every other row's key alone, because the
 * virtualizer's measured heights, React's row identity, scroll memory, and the
 * turn fold all hang off it. `n` counts earlier events in the window with the
 * same base (`#n`, omitted for the first), which only moves when events with
 * that exact base are added before it — two same-type events in the same
 * millisecond split by a page boundary, not ordinary paging.
 *
 * Allocated once per event, eagerly, whether or not the event opens a row, so
 * `buildTranscriptEventRowKeys` can replay it without a collapse pass.
 */
export function allocateTranscriptEventRowKey(
  envelope: AgentChatEventEnvelope,
  ordinals: Map<string, number>,
): string {
  const base = `${envelope.sessionId}:${transcriptEventIdentityBase(envelope)}`;
  const ordinal = ordinals.get(base) ?? 0;
  ordinals.set(base, ordinal + 1);
  return ordinal === 0 ? base : `${base}#${ordinal}`;
}

/** Every event's candidate row key, exactly as a collapse pass over `events` assigns them. */
export function buildTranscriptEventRowKeys(events: readonly AgentChatEventEnvelope[]): string[] {
  const ordinals = new Map<string, number>();
  return events.map((envelope) => allocateTranscriptEventRowKey(envelope, ordinals));
}

function getTextIdentity(event: Extract<AgentChatEvent, { type: "text" }>): string | null {
  const messageId = event.messageId?.trim();
  return messageId?.length ? messageId : null;
}

function turnAndItemMatch(
  a: { turnId?: string; itemId?: string },
  b: { turnId?: string; itemId?: string },
): boolean {
  const aTurnId = a.turnId ?? null;
  const bTurnId = b.turnId ?? null;
  if (!aTurnId || !bTurnId || aTurnId !== bTurnId) return false;
  const aItemId = a.itemId ?? null;
  const bItemId = b.itemId ?? null;
  return !aItemId || !bItemId || aItemId === bItemId;
}

function shouldMergeTextRows(
  previous: Extract<AgentChatEvent, { type: "text" }>,
  next: Extract<AgentChatEvent, { type: "text" }>,
): boolean {
  // Codex labels narration (`commentary`) and the answer (`final_answer`), and
  // ADE reuses one messageId across consecutive assistant text until a tool
  // call flushes it — so the two can share an id. Keep them as separate rows
  // when both are labelled and the labels differ; the turn fold picks the
  // answer by that label. Unlabelled text (every other provider) is unchanged.
  if (previous.phase && next.phase && previous.phase !== next.phase) return false;
  const previousIdentity = getTextIdentity(previous);
  const nextIdentity = getTextIdentity(next);

  if (previousIdentity || nextIdentity) {
    if (previousIdentity && nextIdentity) {
      return previousIdentity === nextIdentity;
    }
    return turnAndItemMatch(previous, next);
  }

  if (turnAndItemMatch(previous, next)) return true;

  return !previous.turnId && !next.turnId && !previous.itemId && !next.itemId;
}

function buildCollapseKey(
  prefix: string,
  event: { turnId?: string; itemId?: string; logicalItemId?: string },
  suffix?: string,
): string {
  const parts = [prefix];
  if (event.turnId) parts.push(event.turnId);
  const stableItemId = event.logicalItemId ?? event.itemId;
  if (stableItemId) parts.push(stableItemId);
  if (suffix) parts.push(suffix);
  return parts.join("::");
}

function buildWorkLogEntryId(
  collapseKey: string | undefined,
  event: { itemId?: string; logicalItemId?: string },
): string {
  return collapseKey ?? event.logicalItemId ?? event.itemId ?? "work-log-entry";
}

function deriveTone(status: ChatWorkLogStatus, normalTone: ChatWorkLogEntryTone): ChatWorkLogEntryTone {
  return status === "failed" ? "error" : normalTone;
}

function toolResultWebResults(
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
): Pick<ChatWorkLogEntry, "results" | "resultsTotal"> {
  if (event.type !== "tool_result" || !event.sources?.length) return {};
  const web = event.sources.filter((source) => source.url);
  if (!web.length) return {};
  return {
    results: web.slice(0, 8).map((source) => ({
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
      ...(source.snippet ? { snippet: source.snippet } : {}),
    })),
    resultsTotal: web.length,
  };
}

function buildToolWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const status = event.type === "tool_call" ? "running" : (event.status ?? "completed");
  const titleFallback = readToolTitle(event.type === "tool_call" ? event.args : event.result);
  const resolvedToolName = isGenericToolIdentifier(event.tool) && titleFallback ? titleFallback : event.tool;
  const connectorLabel = event.mcp?.appContext?.appName ?? event.mcp?.pluginId ?? event.mcp?.server;
  const connectorAction = event.mcp?.appContext?.actionName ?? event.mcp?.tool;
  const collapseKey = buildCollapseKey("tool", event);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: withLocalhostUrls({
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: connectorLabel ?? resolvedToolName,
      tone: deriveTone(status, "tool"),
      status,
      entryKind: "tool",
      toolName: resolvedToolName,
      ...(event.mcp ? { mcp: event.mcp } : {}),
      ...(connectorAction
        ? { detail: connectorAction }
        : titleFallback && titleFallback !== resolvedToolName ? { detail: titleFallback } : {}),
      ...(event.type === "tool_call" ? { args: event.args } : {}),
      ...(event.type === "tool_result" ? { result: event.result } : {}),
      // Provider web tools (Cursor, OpenCode, Claude WebSearch, …) carry their
      // hits as `sources`; the row lists them like a native web search.
      ...toolResultWebResults(event),
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
    }),
  };
}

function buildCommandWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "command" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const collapseKey = buildCollapseKey("command", event, event.command);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: withLocalhostUrls({
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: event.source === "userShell" ? "User shell" : "Shell",
      command: event.command,
      output: event.output,
      cwd: event.cwd,
      tone: deriveTone(event.status, "info"),
      status: event.status,
      entryKind: "command",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    }),
  };
}

function buildFileWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "file_change" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const stats = summarizeDiffStats(event.diff);
  const collapseKey = buildCollapseKey("file", event);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: event.path,
      changedFiles: [{
        path: event.path,
        kind: event.kind,
        additions: stats.additions,
        deletions: stats.deletions,
        diff: event.diff,
      }],
      tone: deriveTone(event.status ?? "completed", "info"),
      status: event.status ?? "completed",
      entryKind: "file_change",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

export type WebSearchResultDisplay = {
  /** Openable http(s) URL, or null when the result carries no usable link. */
  href: string | null;
  /** Title, falling back to the domain, then the raw URL. */
  title: string;
  /** Host (www-stripped) shown subtly next to the title when it differs from it. */
  domain: string | null;
};

/**
 * Normalize a structured web-search result into the fields the transcript rows
 * render: an openable href, a primary title (title → domain → url), and the
 * domain to show subtly beside the title. Pure so both renderers stay in step.
 */
export function deriveWebSearchResultDisplay(result: CodexWebSearchResult): WebSearchResultDisplay {
  const url = result.url?.trim() ?? "";
  let domain: string | null = null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        domain = parsed.hostname.replace(/^www\./i, "");
      }
    } catch {
      // Non-URL text falls through to the raw-string fallback below.
    }
  }
  const title = result.title?.trim() || domain || url || "Result";
  return {
    href: url.length ? url : null,
    title,
    domain: domain && domain !== title ? domain : null,
  };
}

function buildWebSearchWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "web_search" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const collapseKey = buildCollapseKey("web-search", event, event.query);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: "Web search",
      detail: event.action,
      query: event.query,
      action: event.action,
      ...(event.actions?.length ? { actions: event.actions } : {}),
      ...(event.results?.length ? { results: event.results } : {}),
      ...(typeof event.resultsTotal === "number" ? { resultsTotal: event.resultsTotal } : {}),
      tone: deriveTone(event.status, "info"),
      status: event.status,
      entryKind: "web_search",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

function buildHookErrorWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "system_notice" }>,
  timestamp: string,
  rowKey: string,
  summary: string,
): WorkLogRenderEvent {
  const detail = eventHasPayload(event.detail) ? formatStructuredValue(event.detail) : undefined;
  return {
    type: "work_log_entry",
    entry: withLocalhostUrls({
      id: ["hook-error", event.turnId ?? "no-turn", rowKey, summary].join("::"),
      createdAt: timestamp,
      label: "Hook",
      detail: summary,
      ...(detail ? { output: detail } : {}),
      tone: "error",
      status: "failed",
      entryKind: "hook",
      ...(event.turnId ? { turnId: event.turnId } : {}),
    }),
  };
}

function mergeFileChanges(
  previous: ReadonlyArray<ChatWorkLogFileChange> | undefined,
  next: ReadonlyArray<ChatWorkLogFileChange> | undefined,
): ChatWorkLogFileChange[] {
  const merged = new Map<string, ChatWorkLogFileChange>();

  const ingest = (change: ChatWorkLogFileChange) => {
    const existing = merged.get(change.path);
    if (!existing) {
      merged.set(change.path, change);
      return;
    }
    const diff = mergeStreamingText(existing.diff, change.diff);
    const stats = summarizeDiffStats(diff);
    merged.set(change.path, {
      ...existing,
      ...change,
      additions: stats.additions,
      deletions: stats.deletions,
      diff,
    });
  };

  for (const change of previous ?? []) ingest(change);
  for (const change of next ?? []) ingest(change);

  const fileChanges = [...merged.values()];
  const knownFiles = fileChanges.filter((change) => change.path !== "(pending file)");
  if (knownFiles.length > 0) {
    return knownFiles;
  }
  return fileChanges;
}

function mergeWorkLogEntries(previous: ChatWorkLogEntry, next: ChatWorkLogEntry): ChatWorkLogEntry {
  const mergedOutput = (() => {
    if (typeof previous.output !== "string" && typeof next.output !== "string") return undefined;
    return mergeStreamingText(previous.output ?? "", next.output ?? "");
  })();

  const changedFiles = mergeFileChanges(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const result = eventHasPayload(next.result) ? next.result : previous.result;
  const toolName = isGenericToolIdentifier(next.toolName) && !isGenericToolIdentifier(previous.toolName)
    ? previous.toolName
    : (next.toolName ?? previous.toolName);
  const label = isGenericToolIdentifier(next.label) && !isGenericToolIdentifier(previous.label)
    ? previous.label
    : (next.label || previous.label);

  return withLocalhostUrls({
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    label,
    tone: next.status === "failed" ? "error" : next.tone ?? previous.tone,
    ...(toolName ? { toolName } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(mergedOutput ? { output: mergedOutput } : {}),
    ...(result !== undefined ? { result } : {}),
  });
}

function findMatchingWorkLogEntryIndex(
  rows: ChatTranscriptRenderEnvelope[],
  collapseKey: string | undefined,
): number {
  if (!collapseKey) return -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index];
    if (!candidate || candidate.event.type !== "work_log_entry") continue;
    if (candidate.event.collapseKey === collapseKey) return index;
  }
  return -1;
}

function appendWorkLogRow(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  rowKey: string,
  nextEvent: WorkLogRenderEvent,
): void {
  const matchIndex = findMatchingWorkLogEntryIndex(rows, nextEvent.collapseKey);
  if (matchIndex >= 0) {
    const existing = rows[matchIndex];
    if (existing?.event.type === "work_log_entry") {
      rows[matchIndex] = {
        ...existing,
        timestamp: envelope.timestamp,
        event: {
          ...existing.event,
          entry: mergeWorkLogEntries(existing.event.entry, nextEvent.entry),
        },
      };
      return;
    }
  }

  rows.push({
    key: rowKey,
    timestamp: envelope.timestamp,
    event: nextEvent,
  });
}

// ── Subagent lifecycle rows ────────────────────────────────────────────────
// A real subagent renders as exactly ONE row: a spawn anchor (mutated in place
// as progress arrives) that the terminal event converts IN PLACE into the
// result card, keeping its position and key. Only a result whose spawn is not
// in the window appends a card where it arrives. Background shell commands
// render NO cards — only a single compact job line. Keys are identity-derived
// and stable so the virtualizer's measuredHeights survive mutation and rebind
// (load-bearing for sticky-bottom).

function subagentText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function meaningfulProgressSummary(summary: string | null): string | null {
  return summary && !SUBAGENT_PLACEHOLDER_SUMMARY.test(summary) ? summary : null;
}

/**
 * Key of the card a subagent lifecycle event lands on, or null for any other
 * event (or an agent with no card, e.g. a background shell). A progress tick or
 * a result updates a card that sits earlier in the rows, so the last row is not
 * the event's row; event anchors use this to land on the card. The card's
 * `agentKey` is the first id the agent was seen under, so both ids are tried.
 */
export function subagentCardKeyForLifecycleEvent(
  rows: readonly ChatTranscriptRenderEnvelope[],
  event: AgentChatEvent,
): string | null {
  if (event.type !== "subagent_started" && event.type !== "subagent_progress" && event.type !== "subagent_result") {
    return null;
  }
  const ids = new Set([subagentText(event.agentId), subagentText(event.taskId)].filter(Boolean));
  if (!ids.size) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.event.type !== "subagent_spawn_anchor" && row.event.type !== "subagent_result_card") continue;
    if (ids.has(row.event.agentKey)) return row.key;
  }
  return null;
}

function backgroundChipKey(agentKey: string): string {
  return `background-chip:${agentKey}`;
}

/** Position of the agent's card row, verified by its key; repairs a stale index. */
function resolveSubagentCardRowIndex(
  rows: ChatTranscriptRenderEnvelope[],
  state: SubagentAnchorState,
): number | null {
  const expectedKey = state.cardKey;
  if (!expectedKey) return null;
  const storedIndex = state.rowIndex;
  if (storedIndex != null && rows[storedIndex]?.key === expectedKey) return storedIndex;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.key !== expectedKey) continue;
    state.rowIndex = index;
    return index;
  }

  state.rowIndex = null;
  return null;
}

/**
 * The child a `spawn_completed` system notice reports on, or `null` for
 * anything else — including a notice whose detail lost its `spawnCompletion`
 * (an old or truncated transcript). An unidentified completion folds into
 * nothing, so it keeps its own row rather than silently absorbing a different
 * child's.
 *
 * Takes the RENDER event type, not `AgentChatEvent`: the fold compares an
 * incoming event against one already stored on a row, and a row holds the
 * render union. Narrowing on `type` rejects the synthetic render-only members
 * anyway, so widening the parameter costs nothing and removes a cast.
 */
function readSpawnCompletionChildId(event: ChatTranscriptRenderEvent): string | null {
  if (event.type !== "system_notice") return null;
  if (event.noticeKind !== "info" || event.status !== "spawn_completed") return null;
  const detail = event.detail;
  if (!detail || typeof detail === "string") return null;
  return detail.spawnCompletion?.childSessionId?.trim() || null;
}

function repairSubagentRowPositionsAfterSplice(
  context: CollapseTranscriptContext,
  removedIndex: number,
): void {
  for (const state of new Set(context.subagentAnchors.values())) {
    const storedIndex = state.rowIndex;
    if (storedIndex === removedIndex) state.rowIndex = null;
    else if (storedIndex != null && storedIndex > removedIndex) state.rowIndex = storedIndex - 1;
  }
}

function repairIndexedTranscriptRowsAfterSplice(
  context: CollapseTranscriptContext,
  removedIndex: number,
): void {
  repairSubagentRowPositionsAfterSplice(context, removedIndex);
  const windowDetailsIndex = context.turnDetailsWindowRowIndex;
  if (windowDetailsIndex === removedIndex) context.turnDetailsWindowRowIndex = null;
  else if (windowDetailsIndex != null && windowDetailsIndex > removedIndex) {
    context.turnDetailsWindowRowIndex = windowDetailsIndex - 1;
  }
  const taskListIndex = context.taskListRowIndex;
  if (taskListIndex === removedIndex) context.taskListRowIndex = null;
  else if (taskListIndex != null && taskListIndex > removedIndex) context.taskListRowIndex = taskListIndex - 1;
  for (const rowIndexes of [
    context.userMessageRowIndexBySteer,
    context.turnDetailsRowIndexByTurn,
    context.stalledRowIndexByTurn,
    context.adeCardRowIndexById,
    context.backgroundJobRowIndexByKey,
  ]) {
    for (const [key, storedIndex] of rowIndexes) {
      if (storedIndex === removedIndex) rowIndexes.delete(key);
      else if (storedIndex > removedIndex) rowIndexes.set(key, storedIndex - 1);
    }
  }
}

/**
 * Row position of an existing `ade_card`. The carried context is the fast path;
 * the reverse scan is the correctness path — it is what keeps the full-recompute
 * and incremental collapses byte-identical (the parity test) even when a caller
 * appends without a context, and it guarantees a `cardId` can never mint two
 * rows sharing one React key. Both agree because only one row ever holds a key.
 */
function resolveKeyedRowIndex(
  rows: ChatTranscriptRenderEnvelope[],
  rowIndexes: Map<string, number> | undefined,
  lookupKey: string,
  expectedKey: string,
): number | null {
  const stored = rowIndexes?.get(lookupKey);
  if (stored != null && rows[stored]?.key === expectedKey) return stored;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.key === expectedKey) return index;
  }
  return null;
}

function resolveAdeCardRowIndex(
  rows: ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext | undefined,
  cardId: string,
  expectedKey: string,
): number | null {
  return resolveKeyedRowIndex(rows, context?.adeCardRowIndexById, cardId, expectedKey);
}

type AdeCardEvent = Extract<AgentChatEvent, { type: "ade_card" }>;

/**
 * Merge a repeat `ade_card` emit into the row that is already in the transcript.
 *
 * A re-emit is a PATCH, not a replacement — but the emitters do not honour that
 * on their own: `buildPrCiCard` always writes `rows` and `progress`, so a poll
 * that came back from a rate-limited GitHub used to overwrite a good card with
 * `rows: []` and an all-zero progress bar. A card that has already shown real
 * detail therefore keeps it whenever the incoming payload has none, and is
 * flagged `stale` so the surface can say "this is the last thing we knew"
 * rather than silently showing old numbers as current.
 *
 * The flag clears itself the moment a healthy detail refresh lands, including
 * a successful refresh whose rows and totals are genuinely empty.
 */
function mergeAdeCardEvent(
  existing: AdeCardEvent,
  incoming: AdeCardEvent,
  cardId: string,
): AdeCardEvent {
  const merged: AdeCardEvent = { ...existing, ...incoming, cardId };

  const incomingRows = incoming.rows ?? [];
  const incomingMetrics = incoming.metrics ?? [];
  const incomingProgressTotal = adeCardProgressTotal(incoming.progress);
  const existingHadDetail = (existing.rows?.length ?? 0) > 0
    || (existing.metrics?.length ?? 0) > 0
    || adeCardProgressTotal(existing.progress) > 0;
  const incomingIsDetailRefresh = incoming.rows !== undefined
    || incoming.metrics !== undefined
    || incoming.progress !== undefined;

  if (existingHadDetail && incoming.degradedReason) {
    if (!incomingRows.length && existing.rows?.length) merged.rows = existing.rows;
    if (!incomingMetrics.length && existing.metrics?.length) merged.metrics = existing.metrics;
    if (incomingProgressTotal === 0 && existing.progress) merged.progress = existing.progress;
    if (existing.rowsTruncated != null && incoming.rowsTruncated == null) {
      merged.rowsTruncated = existing.rowsTruncated;
    }
    merged.stale = true;
    return merged;
  }

  // Healthy emit: drop every degradation-only field the previous failed fetch
  // left behind. Full healthy card payloads omit the retry action and reason,
  // so the initial spread cannot distinguish recovery from a partial patch.
  if (incomingIsDetailRefresh && !incoming.degradedReason) {
    merged.stale = incoming.stale ?? false;
    merged.degradedReason = incoming.degradedReason ?? undefined;
    merged.actions = incoming.actions ?? [];
  }
  return merged;
}

function removeCollapsedTranscriptRow(
  rows: ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext,
  index: number,
): void {
  rows.splice(index, 1);
  repairIndexedTranscriptRowsAfterSplice(context, index);
}

function durationMsBetween(startedAt: string | null, endedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function backgroundExitCode(event: NormalizedSubagentLifecycleEvent): number | null {
  const value = (event as { exitCode?: unknown }).exitCode;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Human label for a background job's one-liner. `backgroundCommandLabel` strips
 * the shell noise (`cd /repo && …`) down to the part worth reading; the raw
 * command and description are the fallbacks, in that order.
 */
function backgroundJobLabel(state: SubagentAnchorState): string {
  return backgroundCommandLabel(state.command ?? state.description ?? "")
    || state.command
    || state.description
    || "Background command";
}

/**
 * Row position of an existing background-job line, keyed by its own row key.
 */
function resolveBackgroundJobRowIndex(
  rows: ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext | undefined,
  expectedKey: string,
): number | null {
  return resolveKeyedRowIndex(rows, context?.backgroundJobRowIndexByKey, expectedKey, expectedKey);
}

/**
 * Drop a background-job line that a later event proved was never a background
 * job at all — see the real-subagent guard in the `background_task` handler.
 */
function removeBackgroundJobLine(
  rows: ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext,
  expectedKey: string,
): void {
  const rowIndex = resolveBackgroundJobRowIndex(rows, context, expectedKey);
  if (rowIndex == null) return;
  rows.splice(rowIndex, 1);
  repairIndexedTranscriptRowsAfterSplice(context, rowIndex);
}

/**
 * Push the job's one-liner, or mutate the existing one in place — a NEW object
 * under the SAME row key, matching how the spawn anchor updates. Keeping one
 * row for the job's whole life is what stops a busy turn from stacking a
 * running row and a finished row for every background command it starts, and is
 * what lets the live and legacy producers converge on one row.
 *
 * A terminal row is never reopened. Providers do emit a trailing progress tick
 * after a job has already settled, and rewriting the row back to `running`
 * would drop its exit code and duration and restart a ticker that then never
 * stops.
 */
function upsertBackgroundJobLine(
  rows: ChatTranscriptRenderEnvelope[],
  context: CollapseTranscriptContext | undefined,
  expectedKey: string,
  timestamp: string,
  event: BackgroundJobLineRenderEvent,
): void {
  const rowIndex = resolveBackgroundJobRowIndex(rows, context, expectedKey);
  if (rowIndex == null) {
    context?.backgroundJobRowIndexByKey.set(expectedKey, rows.length);
    rows.push({ key: expectedKey, timestamp, event });
    return;
  }
  const existing = rows[rowIndex]!.event;
  if (existing.type === "background_job_line" && existing.status !== "running") {
    if (event.status === "running") return;
  }
  context?.backgroundJobRowIndexByKey.set(expectedKey, rowIndex);
  replaceRowPreservingVoiceCall(rows, rowIndex, { key: expectedKey, timestamp, event });
}

/**
 * The job's start anchor: whatever the row already recorded, so a terminal
 * update computes its duration from the first sighting rather than from itself.
 */
function backgroundJobStartedAt(
  rows: ChatTranscriptRenderEnvelope[],
  rowIndex: number | null,
  fallback: string,
): string {
  if (rowIndex == null) return fallback;
  const existing = rows[rowIndex]?.event;
  if (existing?.type !== "background_job_line") return fallback;
  return existing.startedAt ?? fallback;
}

/**
 * Scheduled-work status → the job line's status. `paused` has no meaning for a
 * background shell (nothing pauses one) and is treated as still running rather
 * than inventing a terminal outcome the runtime never reported.
 */
function backgroundJobStatusFromScheduledWork(
  status: AgentChatScheduledWorkStatus,
): SubagentCardStatus {
  // Enumerated rather than defaulted: a terminal status added to
  // AgentChatScheduledWorkStatus later must fail the build here instead of
  // silently rendering as a job that never finishes.
  switch (status) {
    case "completed":
      return "completed";
    case "stopped":
    case "cancelled":
      return "stopped";
    case "failed":
    case "missed":
      return "failed";
    case "scheduled":
    case "paused":
    case "running":
    case "fired":
      return "running";
  }
}

// Best-effort parent label from the anchors map — the parent's card name
// (`deriveSubagentCardName`). Null when the parent isn't (yet) in the map.
function resolveParentLabel(
  state: SubagentAnchorState,
  anchors: Map<string, SubagentAnchorState>,
): string | null {
  if (!state.parentAgentId) return null;
  const parent = anchors.get(state.parentAgentId);
  if (!parent) return null;
  return deriveSubagentCardName({
    description: subagentTitleDescription(parent),
    label: parent.label,
    agentType: parent.agentType,
  });
}

/**
 * The description a card is titled from. The spawn's own description when the
 * window holds the `subagent_started`; otherwise (its start sits in an older,
 * unloaded page) a label or agent type names the agent better than a progress
 * description, which on Claude is an activity line. Only with neither does the
 * longest description stand in.
 */
function subagentTitleDescription(state: SubagentAnchorState): string | null {
  if (state.title) return state.title;
  if (state.label || state.agentType) return null;
  return state.description;
}

function spawnAnchorEvent(
  state: SubagentAnchorState,
  anchors?: Map<string, SubagentAnchorState>,
): SubagentSpawnAnchorRenderEvent {
  // agentKey mirrors the stable renderKeyBase so the jump affordances derive the
  // same row keys the collapse pass assigned (see subagentCardRowKeyCandidates).
  return {
    type: "subagent_spawn_anchor",
    agentKey: state.renderKeyBase,
    description: subagentTitleDescription(state) ?? "Subagent task",
    agentType: state.agentType,
    provider: state.provider,
    label: state.label,
    background: state.background,
    status: "running",
    statusLine: state.statusLine,
    lastToolName: state.lastToolName,
    toolCount: state.toolCount,
    startedAt: state.startedAt,
    endedAt: null,
    resultSummary: null,
    childSessionId: state.childSessionId,
    taskId: state.taskId,
    spawnKind: state.spawnKind,
    parentLabel: anchors ? resolveParentLabel(state, anchors) : null,
  };
}

// The single-line live status (statusLine) always prefers the last MEANINGFUL
// progress summary; "Task updated"/"Status: …" placeholders never displace a
// real one — falling back to lastToolName, then the description.
function computeStatusLine(state: SubagentAnchorState): string | null {
  return meaningfulProgressSummary(state.progressSummary)
    ?? state.lastToolName
    ?? state.description;
}

function enrichSubagentStateFromEvent(
  state: SubagentAnchorState,
  event: NormalizedSubagentLifecycleEvent,
): void {
  const record = event as NormalizedSubagentLifecycleEvent & {
    background?: unknown;
    description?: unknown;
    command?: unknown;
    spawnKind?: unknown;
    provider?: unknown;
  };
  state.description = longerSubagentText(state.description, subagentText(record.description));
  if (event.type === "subagent_started") state.title = nextSubagentTitle(state.title, subagentText(record.description));
  if (!state.label) state.label = subagentText(event.label);
  state.agentType = preferredSubagentAgentType(state.agentType, subagentText(event.agentType));
  state.provider = subagentText(record.provider) ?? state.provider;
  state.taskType = subagentText(event.taskType) ?? state.taskType;
  state.command = longerSubagentText(state.command, subagentText(record.command));
  if (record.background === true) state.background = true;
  // A spawned ADE chat carries a `chat:<id>` taskId; the child session id (for
  // navigation) is the agentId, equivalently taskId.slice("chat:".length).
  const taskId = subagentText(event.taskId);
  if (taskId && taskId.startsWith("chat:") && !state.childSessionId) {
    state.childSessionId = subagentText(event.agentId) ?? (taskId.slice("chat:".length) || null);
  }
  if (taskId && !taskId.startsWith("chat:") && !state.taskId) {
    state.taskId = taskId;
  }
  if (record.spawnKind === "subagent" || record.spawnKind === "peer") {
    state.spawnKind = record.spawnKind;
  }
  const parentAgentId = subagentText((event as { parentAgentId?: unknown }).parentAgentId);
  if (parentAgentId) state.parentAgentId = parentAgentId;
}

/**
 * The card title comes from `subagent_started` only, never a progress frame:
 * Claude's progress `description` is the current activity ("Running …",
 * "Reading <path>"), which the longest-description rule used to promote to the
 * title. A repeated start (a late enriched snapshot) replaces the title only
 * when it names the same task more fully ("Find" -> "Find update modal
 * component") or the current title is a placeholder ("Background work"); a
 * re-emitted start that carries an activity line is ignored.
 */
function nextSubagentTitle(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current || isGenericSubagentName(current)) return incoming;
  return incoming.length > current.length && incoming.startsWith(current) ? incoming : current;
}

function classificationInput(state: SubagentAnchorState) {
  return {
    taskType: state.taskType,
    agentType: state.agentType,
    command: state.command,
    description: state.description,
  };
}

/**
 * Handle one of the three subagent lifecycle events. Returns true if the event
 * was consumed (caller should stop). Mutates rows and context in place.
 *
 * INVARIANT: splices go through `repairIndexedTranscriptRowsAfterSplice`.
 * The stale background-job-line drop is the only splice here: an agent's card
 * is pushed once at the tail and every later event (progress, the result, a
 * richer re-emitted result) replaces it by its stored index, after verifying
 * the stable key and repairing a stale position.
 */
function handleSubagentLifecycleEvent(
  rows: ChatTranscriptRenderEnvelope[],
  event: NormalizedSubagentLifecycleEvent,
  timestamp: string,
  context: CollapseTranscriptContext,
  eventVoiceCallId: string | undefined,
): boolean {
  const anchors = context.subagentAnchors;
  const agentKey = subagentAgentKey(event);
  if (!agentKey) return true;

  const taskId = subagentText(event.taskId);
  const agentId = subagentText(event.agentId);

  // Rebind: an anchor created under a taskId, then a later event carries agentId
  // for the same task. Move the map key but KEEP the original renderKey + rows.
  let state = anchors.get(agentKey)
    ?? (agentId && taskId ? anchors.get(taskId) : undefined);
  if (state && state.agentKey !== agentKey) {
    anchors.delete(state.agentKey);
    state.agentKey = agentKey;
    anchors.set(agentKey, state);
  }
  // Keep the taskId alias pointing at the same state so a taskId-only later event
  // still resolves after rebind.
  if (state && taskId) anchors.set(taskId, state);

  if (!state) {
    state = {
      agentKey,
      renderKeyBase: agentKey,
      rowIndex: null,
      cardKey: null,
      backgroundLineOpened: false,
      description: null,
      title: null,
      label: null,
      agentType: null,
      provider: null,
      taskType: null,
      command: null,
      background: false,
      startedAt: timestamp,
      endedAt: null,
      progressSummary: null,
      statusLine: null,
      lastToolName: null,
      toolCount: null,
      status: "running",
      resultSummary: null,
      error: null,
      childSessionId: null,
      taskId: taskId && !taskId.startsWith("chat:") ? taskId : null,
      spawnKind: null,
      totalTokens: null,
      toolUseCount: null,
      worktreeBranch: null,
      worktreePath: null,
      parentAgentId: null,
    };
    anchors.set(agentKey, state);
    if (taskId) anchors.set(taskId, state);
  }

  enrichSubagentStateFromEvent(state, event);
  const backgroundShell = state.backgroundLineOpened
    || isBackgroundShellCommand(classificationInput(state));

  // The counterpart to the real-subagent guard in the `background_task` handler:
  // scheduled-work and lifecycle ordering is unspecified, so the job line may
  // already exist by the time this task proves itself a real subagent. Drop it
  // before any card lands, or the agent renders as a job line AND a card pair.
  //
  // Hoisted above the event-type split deliberately: a truncated or replayed
  // transcript can deliver `subagent_result` as a task's ONLY lifecycle event,
  // which never passes through the spawn branch.
  //
  // Note the two guards are counterparts, NOT complements: that one requires
  // `isRealSubagent`, this one only requires "not proven a background shell".
  // A task with neither `taskType` nor `agentType` satisfies neither, so it can
  // still have its line re-created by a later scheduled-work update. That gap is
  // unreachable today — the runtime emits no lifecycle events for background
  // tasks — so both sides are deliberately left as they are rather than flipped
  // blind to a predicate the tests do not pin.
  if (!backgroundShell) {
    for (const identity of [state.renderKeyBase, agentKey, taskId]) {
      if (identity) removeBackgroundJobLine(rows, context, backgroundChipKey(identity));
    }
  }

  if (event.type === "subagent_started" || event.type === "subagent_progress") {
    // Background shell → the single one-liner, never spawn/result cards. Pushed
    // on the first lifecycle event so the run is visible while it runs; the
    // terminal event below mutates this same row rather than adding another.
    // A progress tick that arrives AFTER the job settled is ignored rather than
    // reopening the finished row (`upsertBackgroundJobLine` enforces the same
    // rule for the live producer).
    if (backgroundShell) {
      if (state.endedAt == null) {
        state.backgroundLineOpened = true;
        upsertBackgroundJobLine(rows, context, backgroundChipKey(state.renderKeyBase), timestamp, {
          type: "background_job_line",
          agentKey: state.renderKeyBase,
          label: backgroundJobLabel(state),
          status: "running",
          startedAt: state.startedAt,
          taskId: state.taskId,
        });
      }
      return true;
    }
    if (event.type === "subagent_started" && event.resumed === true) {
      // A tracked CLI child can be resumed after its earlier result settled
      // the card. Reuse the same anchor and row key, but clear run-specific
      // state so the new invocation reads as running on every client.
      state.status = "running";
      state.startedAt = timestamp;
      state.endedAt = null;
      state.progressSummary = null;
      state.statusLine = null;
      state.lastToolName = null;
      state.toolCount = null;
      state.resultSummary = null;
      state.error = null;
      state.totalTokens = null;
      state.toolUseCount = null;
      state.worktreeBranch = null;
      state.worktreePath = null;
    }
    // A settled agent keeps its result card only. A late progress tick must not
    // turn the settled card back into a running one, nor mint a second card.
    if (state.status !== "running" || state.endedAt != null) {
      return true;
    }
    if (state.cardKey == null) {
      // First lifecycle → push the spawn anchor and record its index.
      state.status = "running";
      state.statusLine = computeStatusLine(state);
      const cardKey = subagentSpawnKey(state.renderKeyBase);
      state.cardKey = cardKey;
      state.rowIndex = rows.length;
      rows.push({
        key: cardKey,
        timestamp,
        event: spawnAnchorEvent(state, anchors),
      });
    }

    if (event.type === "subagent_progress") {
      state.progressSummary = preferSubagentSummary(state.progressSummary, event.summary);
      const lastToolName = subagentText(event.lastToolName);
      if (lastToolName) state.lastToolName = lastToolName;
      if (typeof event.usage?.toolUses === "number") state.toolCount = event.usage.toolUses;
      if (state.status === "running") state.status = "running";
    }
    state.statusLine = computeStatusLine(state);

    // Mutate the anchor row IN PLACE — a NEW object with the SAME key.
    const rowIndex = resolveSubagentCardRowIndex(rows, state);
    if (rowIndex != null) {
      replaceRowPreservingVoiceCall(rows, rowIndex, {
        key: state.cardKey!,
        timestamp,
        event: spawnAnchorEvent(state, anchors),
      });
    }
    return true;
  }

  // subagent_result
  const incomingSummary = preferSubagentSummary(event.summary, event.finalSummary);
  const terminalStatus = event.status;

  if (backgroundShell) {
    state.endedAt = timestamp;
    state.backgroundLineOpened = true;
    upsertBackgroundJobLine(rows, context, backgroundChipKey(state.renderKeyBase), timestamp, {
      type: "background_job_line",
      agentKey: state.renderKeyBase,
      label: backgroundJobLabel(state),
      status: terminalStatus,
      exitCode: backgroundExitCode(event),
      durationMs: durationMsBetween(state.startedAt, timestamp),
      startedAt: state.startedAt,
      taskId: state.taskId,
    });
    return true;
  }

  // A restart or takeover sweep ("system" / "foreign-brain") only ever closes
  // rows it believes are still open. When the agent already settled — its
  // completed, failed, or stopped card is in the stream — that stop is a stale
  // verdict: it must not turn a finished card into "stopped · the ADE brain
  // restarted", nor stretch the card's duration to the sweep's clock.
  const sweepStop = terminalStatus === "stopped"
    && event.type === "subagent_result"
    && (event.stopSource === "system" || event.stopSource === "foreign-brain");
  if (sweepStop && state.endedAt != null && state.status !== "running") return true;

  // Real subagent terminal: the agent's card settles in place.
  state.status = terminalStatus;
  if (event.type === "subagent_result") {
    if (typeof event.totalTokens === "number") state.totalTokens = event.totalTokens;
    if (typeof event.toolUseCount === "number") state.toolUseCount = event.toolUseCount;
    const wb = subagentText(event.worktreeBranch);
    if (wb) state.worktreeBranch = wb;
    const wp = subagentText(event.worktreePath);
    if (wp) state.worktreePath = wp;
  }
  state.endedAt = timestamp;
  // Read BEFORE the merge: once the stop summary lands, "had a report already"
  // and "only has the stop sentence" are indistinguishable.
  const resultLandedBeforeStop = !isSubagentPlaceholderSummary(state.resultSummary);
  state.resultSummary = preferSubagentSummary(state.resultSummary, incomingSummary);
  if (terminalStatus === "failed") {
    state.error = state.resultSummary ?? state.error;
  }

  const resultEvent: SubagentResultCardRenderEvent = {
    type: "subagent_result_card",
    agentKey: state.renderKeyBase,
    description: subagentTitleDescription(state),
    agentType: state.agentType,
    provider: state.provider,
    background: state.background,
    label: state.label,
    status: terminalStatus,
    summaryPreview: state.resultSummary,
    error: terminalStatus === "failed" ? state.error : null,
    startedAt: state.startedAt,
    endedAt: timestamp,
    durationMs: durationMsBetween(state.startedAt, timestamp),
    totalTokens: state.totalTokens,
    toolUseCount: state.toolUseCount,
    worktreeBranch: state.worktreeBranch,
    worktreePath: state.worktreePath,
    parentLabel: resolveParentLabel(state, anchors),
    stopSource: event.type === "subagent_result" && event.stopSource ? event.stopSource : "unknown",
    stopReason: event.type === "subagent_result" ? subagentText(event.stopReason) : null,
    // Never the description echoed back: the anchor seeds `statusLine` from the
    // task title, and "Explore auth flow · Explore auth flow" is not evidence.
    lastActivity: ((): string | null => {
      const activity = subagentText(state.statusLine) ?? subagentText(state.progressSummary);
      return activity && activity !== subagentText(state.description) ? activity : null;
    })(),
    resultLanded: resultLandedBeforeStop,
    childSessionId: state.childSessionId,
    spawnKind: state.spawnKind,
  };
  // Settle IN PLACE: the card row keeps its position and key (and the voice
  // call it was stamped with), so a grid keeps its cards in order and React
  // keeps the row mounted with its measured height. Late results — after the
  // parent's `done`, even during a later turn — land here the same way.
  const rowIndex = resolveSubagentCardRowIndex(rows, state);
  if (rowIndex != null) {
    replaceRowPreservingVoiceCall(rows, rowIndex, { key: state.cardKey!, timestamp, event: resultEvent });
    return true;
  }
  // No card in the window: the spawn sits in an unloaded older page (or the
  // result is the agent's only lifecycle event). Append the card where the
  // result arrives. The row claims the call this terminal event was spoken
  // under: a splice above (a dropped job line) can net the append to zero new
  // rows, and `appendCollapsedEventWithVoiceStamp` stamps only appended rows.
  const cardKey = subagentResultKey(state.renderKeyBase);
  state.cardKey = cardKey;
  state.rowIndex = rows.length;
  rows.push(eventVoiceCallId
    ? { key: cardKey, timestamp, event: resultEvent, voiceCallId: eventVoiceCallId }
    : { key: cardKey, timestamp, event: resultEvent });
  return true;
}

export function appendCollapsedChatTranscriptEvent(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  rowKey: string,
  context?: CollapseTranscriptContext,
): void {
  const { event } = envelope;

  // `api_retry` is a live provider-health signal, not durable transcript
  // content. Its compact replacement is emitted on the activity stream.
  if (event.type === "api_retry") return;

  if (event.type === "user_message") {
    const steerId = event.steerId?.trim();
    const pendingResolution = steerId
      ? context?.unmatchedUserMessageResolutionsBySteer.get(steerId)
      : undefined;
    const existingIndex = steerId ? context?.userMessageRowIndexBySteer.get(steerId) : undefined;
    const existing = existingIndex != null ? rows[existingIndex] : null;
    if (existingIndex != null && existing?.event.type === "user_message") {
      rows[existingIndex] = {
        ...existing,
        event: {
          ...existing.event,
          ...event,
          text: event.text || existing.event.text,
          displayText: event.displayText ?? existing.event.displayText,
          attachments: event.attachments ?? existing.event.attachments,
          contextAttachments: event.contextAttachments ?? existing.event.contextAttachments,
          metadata: event.metadata || existing.event.metadata || pendingResolution
            ? {
                ...(existing.event.metadata ?? {}),
                ...(event.metadata ?? {}),
                ...(pendingResolution
                  ? {
                      unprocessedMessageResolution: {
                        action: pendingResolution.action,
                        state: pendingResolution.state,
                        resolvedAt: pendingResolution.resolvedAt,
                        ...(pendingResolution.replacementMessageId
                          ? { replacementMessageId: pendingResolution.replacementMessageId }
                          : {}),
                      },
                    }
                  : {}),
              }
            : existing.event.metadata,
          turnId: event.turnId ?? existing.event.turnId,
        },
      };
      if (steerId && pendingResolution) {
        context?.unmatchedUserMessageResolutionsBySteer.delete(steerId);
      }
      return;
    }
    const wake = event.metadata?.scheduledWake;
    if (
      wake
      && typeof wake.scheduleId === "string"
      && (wake.kind === "wakeup" || wake.kind === "cron" || wake.kind === "loop")
      && typeof wake.firedAt === "string"
    ) {
      rows.push({
        key: `scheduled-wake:${wake.scheduleId}:${event.turnId ?? rowKey}`,
        timestamp: envelope.timestamp,
        event: {
          type: "scheduled_wake_divider",
          scheduleId: wake.scheduleId,
          kind: wake.kind,
          reason: typeof wake.reason === "string" && wake.reason.trim().length ? wake.reason.trim() : null,
          firedAt: wake.firedAt,
          late: wake.late === true,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    }
    // A spawned `subagent` that finished delivers a message carrying a
    // `spawnCompletion` metadata payload — render a distinct completion header
    // whether it steered the active turn or woke an idle chat. Read the typed
    // slot; keep runtime guards since transcript payloads arrive off the wire.
    const completion = event.metadata?.spawnCompletion;
    if (completion) {
      const childSessionId = completion.childSessionId?.trim() ?? "";
      const spawnKind = completion.spawnKind === "subagent" || completion.spawnKind === "peer"
        ? completion.spawnKind
        : null;
      const status = completion.status === "completed" || completion.status === "failed" || completion.status === "stopped"
        ? completion.status
        : null;
      if (childSessionId && spawnKind && status) {
        rows.push({
          key: `spawn-wake:${childSessionId}:${event.turnId ?? rowKey}`,
          timestamp: envelope.timestamp,
          event: {
            type: "spawn_wake_divider",
            childSessionId,
            childTitle: completion.childTitle?.trim() || "spawned chat",
            spawnKind,
            status,
            summary: completion.summary?.trim() || null,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          },
        });
      }
    }
  }

  if (event.type === "user_message_resolution") {
    const steerId = event.steerId.trim();
    const existingIndex = context?.userMessageRowIndexBySteer.get(steerId);
    const existing = existingIndex != null ? rows[existingIndex] : null;
    if (existingIndex != null && existing?.event.type === "user_message") {
      rows[existingIndex] = {
        ...existing,
        timestamp: envelope.timestamp,
        event: {
          ...existing.event,
          metadata: {
            ...(existing.event.metadata ?? {}),
            unprocessedMessageResolution: {
              action: event.action,
              state: event.state,
              resolvedAt: event.resolvedAt,
              ...(event.replacementMessageId ? { replacementMessageId: event.replacementMessageId } : {}),
            },
          },
        },
      };
    } else if (steerId) {
      context?.unmatchedUserMessageResolutionsBySteer.set(steerId, event);
    }
    return;
  }

  if (event.type === "pending_input_resolved") {
    context?.resolvedInputItemIds.add(event.itemId);
    return;
  }

  if (event.type === "step_boundary" || event.type === "activity") {
    return;
  }

  // Provider token usage drives the end-of-turn footer; inline transcript rows
  // would be duplicate noise. Cursor's `tokens` event used to fall through to
  // the generic renderer and draw a bare horizontal divider labelled "event"
  // immediately above the footer that already contained the same numbers.
  if (
    event.type === "tokens"
    || event.type === "codex_token_usage"
    || event.type === "codex_moderation_metadata"
    // Data-only citations: Sources derives from them; they draw no row.
    || event.type === "sources"
  ) {
    return;
  }

  if (event.type === "turn_diagnostics") {
    upsertTurnDetailsRow(rows, envelope, rowKey, context, event.turnId?.trim() || null, (details) => {
      const source = event.turnId?.trim() || "__session_startup__";
      const diagnostics = details.diagnostics.some((entry) => entry.source === source)
        ? details.diagnostics.map((entry) => (entry.source === source ? { source, event } : entry))
        : [...details.diagnostics, { source, event }];
      return { ...details, diagnostics };
    });
    return;
  }

  if (event.type === "turn_recovery" || event.type === "codex_turn_recovery") {
    const turnKey = event.turnId.trim();
    if (event.state === "recovered" && context) {
      const stalledIndex = context.stalledRowIndexByTurn.get(turnKey);
      if (stalledIndex != null && rows[stalledIndex]?.event.type === "codex_turn_stalled") {
        removeCollapsedTranscriptRow(rows, context, stalledIndex);
      }
    }
    upsertTurnDetailsRow(rows, envelope, rowKey, context, turnKey || null, (details) => (
      // Provider-neutral receipts are canonical when a legacy alias arrives too.
      event.type === "codex_turn_recovery" && details.recovery?.type === "turn_recovery"
        ? details
        : { ...details, recovery: event }
    ));
    return;
  }

  if (event.type === "codex_turn_stalled") {
    const turnKey = event.turnId.trim();
    const detailsIndex = context?.turnDetailsRowIndexByTurn.get(turnKey);
    const detailsEvent = detailsIndex != null ? rows[detailsIndex]?.event : null;
    if (detailsEvent?.type === "turn_details" && detailsEvent.recovery?.state === "recovered") {
      return;
    }
    const existingIndex = context?.stalledRowIndexByTurn.get(turnKey);
    if (existingIndex != null && rows[existingIndex]?.event.type === "codex_turn_stalled") {
      rows[existingIndex] = {
        ...rows[existingIndex]!,
        timestamp: envelope.timestamp,
        event,
      };
      return;
    }
    const rowIndex = rows.length;
    rows.push({
      key: `codex-turn-stalled:${turnKey}`,
      timestamp: envelope.timestamp,
      event,
    });
    context?.stalledRowIndexByTurn.set(turnKey, rowIndex);
    return;
  }

  if (event.type === "turn_health") {
    const recoveryOptions = event.supportedActions.flatMap((action) => {
      switch (action) {
        case "wait":
          return ["wait" as const];
        case "nudge":
          return ["steer" as const];
        case "retry_same_runtime":
          return ["interrupt_retry_same_thread" as const];
        case "restart_resume":
          return ["restart_resume_thread" as const];
      }
    });
    const legacyStall: Extract<AgentChatEvent, { type: "codex_turn_stalled" }> = {
      type: "codex_turn_stalled",
      turnId: event.turnId,
      reason: event.reason === "runtime_state_unknown"
        ? "app_server_state_unknown"
        : event.reason,
      message: event.message,
      recoveryOptions,
      detectedAt: event.detectedAt,
      turnStartedAt: event.turnStartedAt,
      lastProgressAt: event.lastProgressAt,
      automaticRecoveryAttempted: event.automaticRecoveryAttempted,
      sourceSessionId: event.sourceSessionId,
    };
    appendCollapsedChatTranscriptEvent(
      rows,
      { ...envelope, event: legacyStall },
      rowKey,
      context,
    );
    return;
  }

  if (event.type === "status") {
    const normalizedMessage = summarizeInlineText(event.message ?? "", 120).toLowerCase();
    const keepStatus =
      event.turnStatus === "failed"
      || event.turnStatus === "interrupted"
      || (normalizedMessage.length > 0
        && normalizedMessage !== event.turnStatus.toLowerCase()
        && normalizedMessage !== "started"
        && normalizedMessage !== "completed");
    if (!keepStatus) return;

    // Deduplicate consecutive identical status events (e.g. multiple "interrupted")
    const previous = rows[rows.length - 1];
    if (
      previous?.event.type === "status"
      && previous.event.turnStatus === event.turnStatus
      && (previous.event.turnId ?? null) === (event.turnId ?? null)
      && (previous.event.message ?? "") === (event.message ?? "")
    ) {
      return;
    }
  }

  if (event.type === "error" && event.turnId?.trim()) {
    const semanticKey = JSON.stringify([
      event.turnId.trim(),
      event.message.trim(),
      event.detail?.trim() ?? null,
      event.errorInfo ?? null,
    ]);
    if (context?.errorKeysByTurn.has(semanticKey)) return;
    context?.errorKeysByTurn.add(semanticKey);
  }

  if (event.type === "system_notice") {
    // Automatic retries are live provider health, not conversation content.
    // Hide this legacy durable shape during replay so old transcripts upgrade
    // to the same calm presentation as new events.
    if (isLegacyProviderRetryNotice(event)) return;
    if (event.noticeKind === "info" && event.message.trim().toLowerCase() === "session ready") {
      return;
    }
    if (isLowValueHookNotice(event)) {
      return;
    }
    const preToolUseHookError = summarizePreToolUseHookError(event);
    if (preToolUseHookError) {
      appendWorkLogRow(
        rows,
        envelope,
        rowKey,
        buildHookErrorWorkLogEvent(event, envelope.timestamp, rowKey, preToolUseHookError),
      );
      return;
    }
  }

  if (event.type === "delegation_state") {
    const normalizedMessage = summarizeInlineText(event.message ?? "", 140);
    const keepDelegation =
      normalizedMessage.length > 0
      || event.contract.status === "blocked"
      || event.contract.status === "launch_failed"
      || event.contract.status === "failed";
    if (!keepDelegation) return;
  }

  if (event.type === "reasoning") {
    const nextTurn = event.turnId ?? null;
    const nextItemId = event.itemId ?? null;
    const nextSummaryIndex = event.summaryIndex ?? null;
    let matchIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (!candidate || candidate.event.type !== "reasoning") break;
      const sameReasoningBlock = nextItemId !== null
        ? (candidate.event.itemId ?? null) === nextItemId
          && (candidate.event.summaryIndex ?? null) === nextSummaryIndex
        : nextTurn !== null
          && (candidate.event.turnId ?? null) === nextTurn
          && (candidate.event.itemId ?? null) === null;
      if (sameReasoningBlock) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex >= 0) {
      const existing = rows[matchIndex];
      if (existing?.event.type === "reasoning") {
        rows[matchIndex] = {
          ...existing,
          timestamp: envelope.timestamp,
          event: {
            ...existing.event,
            text: mergeReasoningFragment(existing.event.text, event.text),
            startTimestamp: existing.event.startTimestamp ?? existing.timestamp,
          },
        };
        return;
      }
    }
  }

  if (event.type === "transcript_retraction") {
    const retractedIds = new Set(event.messageIds.map((messageId) => messageId.trim()).filter(Boolean));
    if (!retractedIds.size) return;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.event.type === "text" && row.event.messageId && retractedIds.has(row.event.messageId)) {
        rows.splice(index, 1);
        if (context) repairIndexedTranscriptRowsAfterSplice(context, index);
      }
    }
    return;
  }

  if (event.type === "text") {
    if (!event.text.trim().length) return;
    const previous = rows[rows.length - 1];
    if (previous?.event.type === "text" && shouldMergeTextRows(previous.event, event)) {
      const nextTurn = event.turnId ?? null;
      const nextItem = event.itemId ?? null;
      rows[rows.length - 1] = {
        ...previous,
        timestamp: envelope.timestamp,
        event: {
          ...previous.event,
          text: `${previous.event.text}${event.text}`,
          ...(nextTurn && !previous.event.turnId ? { turnId: nextTurn } : {}),
          ...(nextItem && !previous.event.itemId ? { itemId: nextItem } : {}),
          ...(event.messageId && !previous.event.messageId ? { messageId: event.messageId } : {}),
          // The phase label may ride only on a later fragment; the merged row
          // is the answer (or narration) as a whole.
          ...(event.phase && !previous.event.phase ? { phase: event.phase } : {}),
        },
      };
      return;
    }
  }

  if (event.type === "system_notice") {
    // Per-TURN, not per-previous-row: rows pushed between two copies of the same
    // notice (background job lines, work-log rows) used to break the adjacency
    // check and let the notice repeat. Replayed history self-heals — there is no
    // stored state to migrate.
    if (context) {
      const signature = systemNoticeSignature(event);
      if (context.systemNoticeSignatures.has(signature)) return;
      context.systemNoticeSignatures.add(signature);
    } else {
      const previous = rows[rows.length - 1];
      if (
        previous?.event.type === "system_notice"
        && previous.event.noticeKind === event.noticeKind
        && previous.event.message.trim() === event.message.trim()
        && JSON.stringify(previous.event.detail ?? null) === JSON.stringify(event.detail ?? null)
        && (previous.event.turnId ?? null) === (event.turnId ?? null)
      ) {
        return;
      }
    }
  }

  // Every plan/todo update feeds the chat's one task-list row; none renders a
  // row of its own. Only Codex plan-mode proposals (no steps, streamed text)
  // fall through to the plan card below.
  if ((event.type === "todo_update" || event.type === "plan") && isChatTaskListEvent(event)) {
    if (event.type === "todo_update") {
      context?.latestTodoItemsByTurn.set(todoSnapshotKey(event.turnId ?? null), event.items);
    }
    upsertTaskListRow(rows, envelope, event, context);
    return;
  }

  if (event.type === "plan") {
    const nextTurn = event.turnId ?? null;
    if (nextTurn !== null) {
      const matchIndex = [...rows]
        .reverse()
        .findIndex((candidate) =>
          candidate.event.type === "plan"
          && (candidate.event.turnId ?? null) === nextTurn,
        );
      if (matchIndex >= 0) {
        const actualIndex = rows.length - 1 - matchIndex;
        const merged = mergePlanTranscriptEvent(rows[actualIndex]!.event as PlanTranscriptEvent, event);
        rows[actualIndex] = {
          ...rows[actualIndex]!,
          timestamp: envelope.timestamp,
          event: merged,
        };
        return;
      }
    }
  }

  // `background_task` scheduled work IS how the live Claude runtime reports a
  // backgrounded shell command — `emitClaudeBackgroundTaskUpdate` fires one of
  // these on spawn and one on exit, and deliberately emits no subagent
  // lifecycle events for these tasks at all. This used to be dropped outright
  // ("the actions pane owns it"), which left a running job with no in-thread
  // presence whatsoever while the sidebar flipped to a bare "Working" — the two
  // together read as a hung turn. It now drives the same single one-liner the
  // legacy subagent path produces, on the same row key, so a transcript holding
  // both shapes still renders exactly one row per job.
  //
  // Other scheduled kinds (wakeup/cron/loop) keep their existing behavior.
  if (event.type === "scheduled_work_update" && event.kind === "background_task") {
    const taskKey = event.sourceTaskId?.trim() || event.id;
    if (!taskKey) return;
    // A REAL subagent can also be reported through this stream: the level-set
    // path (`applyClaudeBackgroundTasksLevel`) gates only on task_type, so an
    // agent that reports none falls through to the background emitter. Without
    // this guard the agent gets its spawn/result card pair AND a job line
    // wedged between them. The identity filter matches the one
    // `deriveBackgroundItems` and the iOS timeline already apply.
    const anchor = context?.subagentAnchors.get(taskKey);
    if (anchor && isRealSubagent(classificationInput(anchor))) return;
    const expectedKey = backgroundChipKey(taskKey);
    const rowIndex = resolveBackgroundJobRowIndex(rows, context, expectedKey);
    const startedAt = backgroundJobStartedAt(rows, rowIndex, envelope.timestamp);
    const status = backgroundJobStatusFromScheduledWork(event.status);
    const label = backgroundCommandLabel(event.title ?? "")
      || event.title
      || "Background command";
    const providerTaskId = event.sourceTaskId?.trim() || null;
    upsertBackgroundJobLine(
      rows,
      context,
      expectedKey,
      envelope.timestamp,
      status === "running"
        ? {
            type: "background_job_line",
            agentKey: taskKey,
            label,
            startedAt,
            status,
            taskId: providerTaskId,
          }
        : {
            type: "background_job_line",
            agentKey: taskKey,
            label,
            startedAt,
            status,
            taskId: providerTaskId,
            // The scheduled-work wire format carries no exit code; duration is
            // measured from the row's own first sighting instead of trusting
            // the free-text summary the emitter composes.
            exitCode: null,
            durationMs: durationMsBetween(startedAt, envelope.timestamp),
          },
    );
    return;
  }

  // Subagent lifecycle → two-row spawn/result cards (or a single live one-liner
  // for background shell commands). Normalize canonical dotted events first, then
  // fold every lifecycle event into the anchor state (handled BEFORE the generic
  // passthrough so no raw subagent_* row ever reaches the activity bundler).
  if (event.type === "codex_image_generation" || event.type === "codex_image_view") {
    const matchIndex = [...rows]
      .reverse()
      .findIndex((candidate) =>
        candidate.event.type === event.type
        && candidate.event.itemId === event.itemId
        && (candidate.event.turnId ?? null) === (event.turnId ?? null),
      );
    if (matchIndex >= 0) {
      const actualIndex = rows.length - 1 - matchIndex;
      const previous = rows[actualIndex]!;
      if (event.type === "codex_image_generation" && previous.event.type === "codex_image_generation") {
        rows[actualIndex] = {
          ...previous,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            ...event,
            prompt: event.prompt ?? previous.event.prompt,
            revisedPrompt: event.revisedPrompt ?? previous.event.revisedPrompt,
            result: event.result ?? previous.event.result,
            savedPath: event.savedPath ?? previous.event.savedPath,
          },
        };
        return;
      }
      if (event.type === "codex_image_view" && previous.event.type === "codex_image_view") {
        rows[actualIndex] = {
          ...previous,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            ...event,
            path: event.path ?? previous.event.path,
            url: event.url ?? previous.event.url,
            title: event.title ?? previous.event.title,
          },
        };
        return;
      }
    }
  }
  // `ade_card` — a PERMANENT chronological transcript row (like a file-change
  // summary), not activity: it is never classified by `classifyActivityPhaseRow`
  // and never bundled, so an interleaved reasoning/work phase cannot swallow it.
  // Repeat emits with the same `cardId` merge into the row already in the list.
  if (event.type === "ade_card") {
    const cardId = event.cardId?.trim();
    // A card with no identity has no merge key and no stable render key; a
    // transcript can hold arbitrary wire payloads, so drop it rather than mint
    // an index-derived key the virtualizer would remeasure on every append.
    if (!cardId) return;
    const key = adeCardRowKey(cardId);
    const existingIndex = resolveAdeCardRowIndex(rows, context, cardId, key);
    const existing = existingIndex != null ? rows[existingIndex] : null;
    if (existingIndex != null && existing?.event.type === "ade_card") {
      replaceRowPreservingVoiceCall(rows, existingIndex, {
        key,
        timestamp: envelope.timestamp,
        event: mergeAdeCardEvent(existing.event, event, cardId),
      });
      context?.adeCardRowIndexById.set(cardId, existingIndex);
      return;
    }
    const rowIndex = rows.length;
    rows.push({ key, timestamp: envelope.timestamp, event: { ...event, cardId } });
    context?.adeCardRowIndexById.set(cardId, rowIndex);
    return;
  }

  const normalizedSubagentEvent = normalizeSubagentLifecycleEvent(event);
  if (normalizedSubagentEvent) {
    const activeContext = context ?? createCollapseTranscriptContext();
    handleSubagentLifecycleEvent(
      rows,
      normalizedSubagentEvent,
      envelope.timestamp,
      activeContext,
      envelope.provenance?.voiceCallId?.trim() || undefined,
    );
    return;
  }

  if (event.type === "tool_call" || event.type === "tool_result") {
    appendWorkLogRow(rows, envelope, rowKey, buildToolWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "command") {
    appendWorkLogRow(rows, envelope, rowKey, buildCommandWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "file_change") {
    appendWorkLogRow(rows, envelope, rowKey, buildFileWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "web_search") {
    appendWorkLogRow(rows, envelope, rowKey, buildWebSearchWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (isContextCompactionChatEvent(event)) {
    const incoming = normalizeContextCompactEvent(event);
    if (!incoming) return;
    const mergeKey = contextCompactMergeKey(incoming);
    const matchIndex = [...rows]
      .reverse()
      .findIndex((candidate) => {
        const candidateEvent = candidate.event;
        if (!isContextCompactionChatEvent(candidateEvent as AgentChatEvent)) return false;
        const existing = normalizeContextCompactEvent(candidateEvent as AgentChatEvent);
        if (!existing) return false;
        if (contextCompactMergeKey(existing) !== mergeKey) return false;
        return existing.state === "started" || incoming.state === "completed" || incoming.state === "failed";
      });
    if (matchIndex >= 0) {
      const actualIndex = rows.length - 1 - matchIndex;
      const previous = normalizeContextCompactEvent(rows[actualIndex]!.event as AgentChatEvent);
      if (previous) {
        rows[actualIndex] = {
          ...rows[actualIndex]!,
          timestamp: envelope.timestamp,
          event: toContextCompactChatEvent(mergeNormalizedContextCompact(previous, incoming)),
        };
        return;
      }
    }
    rows.push({
      key: `context-compact:${mergeKey}:${rowKey}`,
      timestamp: envelope.timestamp,
      event: toContextCompactChatEvent(incoming),
    });
    return;
  }

  // ── Host sleep: ONE chip per sleep ──
  // The paused half pushes a row; the resumed half replaces that same row
  // instead of appending under it, so a machine that slept mid-turn never
  // leaves two artifacts behind and never pushes the transcript around. The
  // sleep id is the identity, so a second sleep in the same turn still gets its
  // own chip rather than overwriting the first sleep's resolved one.
  if (isHostSleepNoticeEvent(event)) {
    const mergeKey = hostSleepNoticeMergeKey(event);
    const rowKey = `host-sleep:${mergeKey}`;
    const existingIndex = rows.findIndex((candidate) => candidate.key === rowKey);
    if (existingIndex >= 0) {
      // Resolved wins, whatever the arrival order. Last-wins alone would let a
      // paused half delivered after its resume — a sequence inversion, or a host
      // clock corrected across the wake — settle the row on "Paused" for a
      // machine that is demonstrably awake, which is the exact class of lie this
      // branch exists to remove. iOS applies the same guard.
      const existingEvent = rows[existingIndex]!.event as HostSleepNoticeShape;
      if (isHostResumedNoticeEvent(existingEvent) && !isHostResumedNoticeEvent(event)) {
        return;
      }
      rows[existingIndex] = {
        ...rows[existingIndex]!,
        timestamp: envelope.timestamp,
        event: event as ChatTranscriptVisibleEvent,
      };
      return;
    }
    rows.push({
      key: rowKey,
      timestamp: envelope.timestamp,
      event: event as ChatTranscriptVisibleEvent,
    });
    return;
  }

  // ── Spawned-chat turn completions: ONE chip per adjacent run ──
  // A parent that spawned a peer gets one `spawn_completed` notice per sibling
  // TURN, which stacks identical rows. Fold an incoming notice into the LAST
  // row when that row is a completion for the SAME child, carrying a
  // `repeatCount` the chip renders as `×N`. Adjacency-only on purpose:
  // anything the parent said or did in between separates the runs, and
  // consulting only the row just appended is what keeps the incremental and
  // full collapses byte-identical.
  const spawnCompletionChildId = readSpawnCompletionChildId(event);
  if (spawnCompletionChildId) {
    const last = rows[rows.length - 1];
    if (last && readSpawnCompletionChildId(last.event) === spawnCompletionChildId) {
      rows[rows.length - 1] = {
        ...last,
        timestamp: envelope.timestamp,
        event: event as ChatTranscriptVisibleEvent,
        repeatCount: (last.repeatCount ?? 1) + 1,
      };
      return;
    }
  }

  if (event.type === "done" && context) {
    recordTurnEndSnapshot(rows, event, rowKey, context);
  }

  const pendingResolution = event.type === "user_message" && event.steerId?.trim()
    ? context?.unmatchedUserMessageResolutionsBySteer.get(event.steerId.trim())
    : undefined;
  const renderEvent: ChatTranscriptVisibleEvent = event.type === "user_message" && pendingResolution
    ? {
        ...event,
        metadata: {
          ...(event.metadata ?? {}),
          unprocessedMessageResolution: {
            action: pendingResolution.action,
            state: pendingResolution.state,
            resolvedAt: pendingResolution.resolvedAt,
            ...(pendingResolution.replacementMessageId
              ? { replacementMessageId: pendingResolution.replacementMessageId }
              : {}),
          },
        },
      }
    : event as ChatTranscriptVisibleEvent;
  const rowIndex = rows.length;
  rows.push({
    key: rowKey,
    timestamp: envelope.timestamp,
    event: renderEvent,
  });
  if (event.type === "user_message" && event.steerId?.trim()) {
    const steerId = event.steerId.trim();
    context?.userMessageRowIndexBySteer.set(steerId, rowIndex);
    if (pendingResolution) {
      context?.unmatchedUserMessageResolutionsBySteer.delete(steerId);
    }
  }
  // A new window starts at a user message or at this turn's own end (a
  // subagent's `done` inside the turn does not end it): later id-less
  // diagnostics must not join the previous turn's details row.
  if (
    context
    && (
      (event.type === "user_message" && classifyTurnFoldEvent(event) === "boundary")
      || (event.type === "done" && !context.foreignTurnEndKeys.has(rowKey))
    )
  ) {
    context.turnDetailsWindowRowIndex = null;
  }
}

/**
 * Result of a collapse pass. The context is opaque to callers except that the
 * incremental path caches it so appended progress/result events can index back
 * into stored row positions (see {@link collapseChatTranscriptEventsIncrementalWithContext}).
 */
export type CollapseTranscriptResult = {
  rows: ChatTranscriptRenderEnvelope[];
  context: CollapseTranscriptContext;
};

/**
 * Append one collapsed event and stamp whatever rows it produced with the voice
 * call it belongs to. Stamping happens HERE rather than inside
 * `appendCollapsedChatTranscriptEvent` because that function pushes rows from
 * dozens of branches; the caller only has to look at what the row count did.
 */
function appendCollapsedEventWithVoiceStamp(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  context: CollapseTranscriptContext,
): void {
  const callId = envelope.provenance?.voiceCallId?.trim() || null;
  const before = rows.length;
  const rowKey = allocateTranscriptEventRowKey(envelope, context.eventRowKeyOrdinals);
  appendCollapsedChatTranscriptEvent(rows, envelope, rowKey, context);
  for (let index = before; index < rows.length; index += 1) {
    const row = rows[index]!;
    rows[index] = stampSceneScopeKey(callId ? { ...row, voiceCallId: callId } : row);
  }
}

export function collapseChatTranscriptEventsWithContext(
  events: AgentChatEventEnvelope[],
): CollapseTranscriptResult {
  const rows: ChatTranscriptRenderEnvelope[] = [];
  const context = createCollapseTranscriptContext();
  for (const envelope of events) {
    appendCollapsedEventWithVoiceStamp(rows, envelope, context);
  }
  return { rows, context };
}

export function collapseChatTranscriptEvents(events: AgentChatEventEnvelope[]): ChatTranscriptRenderEnvelope[] {
  return collapseChatTranscriptEventsWithContext(events).rows;
}

/**
 * Incremental collapse that carries its {@link CollapseTranscriptContext} so
 * appended progress/result events index back into `previousRows.slice()` and
 * mutate the subagent anchor row by its stored `rowIndex`. Falls back to a fresh
 * full recompute on divergence/shrink (those rebuild the context). Retraction
 * splices and task-list moves repair the carried positions. The full-recompute path MUST produce identical output
 * to the incremental path (guarded by a parity test).
 */
export function collapseChatTranscriptEventsIncrementalWithContext(
  events: AgentChatEventEnvelope[],
  previousEvents: AgentChatEventEnvelope[],
  previousRows: ChatTranscriptRenderEnvelope[],
  previousContext: CollapseTranscriptContext | null,
): CollapseTranscriptResult {
  if (events === previousEvents && previousContext) {
    return { rows: previousRows, context: previousContext };
  }
  if (!previousEvents.length || events.length < previousEvents.length || !previousContext) {
    return collapseChatTranscriptEventsWithContext(events);
  }

  if (events[previousEvents.length - 1] !== previousEvents[previousEvents.length - 1]) {
    return collapseChatTranscriptEventsWithContext(events);
  }

  const rows = previousRows.slice();
  for (let index = previousEvents.length; index < events.length; index += 1) {
    appendCollapsedEventWithVoiceStamp(rows, events[index]!, previousContext);
  }
  return { rows, context: previousContext };
}

export function collapseChatTranscriptEventsIncremental(
  events: AgentChatEventEnvelope[],
  previousEvents: AgentChatEventEnvelope[],
  previousRows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  // Legacy signature (no carried context): recompute a context from the previous
  // events so appended subagent lifecycle rows still resolve their anchors.
  const previousContext = previousEvents.length
    ? collapseChatTranscriptEventsWithContext(previousEvents).context
    : null;
  return collapseChatTranscriptEventsIncrementalWithContext(
    events,
    previousEvents,
    previousRows,
    previousContext,
  ).rows;
}

export function groupConsecutiveWorkLogRows(
  rows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const grouped: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;

  const absorbToolSummary = (
    toolSummary: Extract<AgentChatEvent, { type: "tool_use_summary" }>,
  ): boolean => {
    const summary = toolSummary.summary.trim();
    const toolUseIds = toolSummary.toolUseIds.filter((id) => id.trim().length > 0);
    const candidate = grouped[grouped.length - 1];
    if (!candidate || candidate.event.type !== "work_log_group") return false;

    const candidateEvent = candidate.event;
    const candidateTurnId = candidateEvent.turnId ?? candidateEvent.entries[0]?.turnId ?? null;
    if (toolSummary.turnId && candidateTurnId && candidateTurnId !== toolSummary.turnId) return false;

    if (toolUseIds.length > 0) {
      const candidateToolIds = new Set(
        candidateEvent.entries
          .filter((entry) => entry.entryKind === "tool" && typeof entry.itemId === "string" && entry.itemId.trim().length > 0)
          .map((entry) => entry.itemId!.trim()),
      );
      const hasMatch = toolUseIds.some((toolUseId) => candidateToolIds.has(toolUseId));
      if (!hasMatch) return false;
    }

    grouped[grouped.length - 1] = {
      ...candidate,
      event: {
        ...candidateEvent,
        ...(summary.length > 0 ? { summary } : {}),
        ...(toolUseIds.length > 0
          ? {
              toolUseIds: [
                ...(candidateEvent.toolUseIds ?? []),
                ...toolUseIds.filter((toolUseId) => !(candidateEvent.toolUseIds ?? []).includes(toolUseId)),
              ],
            }
          : {}),
        turnId: candidateTurnId ?? toolSummary.turnId ?? null,
      },
    };
    return true;
  };

  while (index < rows.length) {
    const row = rows[index]!;
    if (row.event.type === "tool_use_summary") {
      const prevRow = index > 0 ? rows[index - 1] : null;
      const prevIsWorkLog = prevRow?.event.type === "work_log_entry";
      if (prevIsWorkLog && absorbToolSummary(row.event)) {
        index += 1;
        continue;
      }
    }

    if (row.event.type === "work_log_entry") {
      const entries: ChatWorkLogEntry[] = [];
      let cursor = index;
      while (cursor < rows.length && rows[cursor]!.event.type === "work_log_entry") {
        entries.push((rows[cursor]!.event as WorkLogRenderEvent).entry);
        cursor += 1;
      }
      grouped.push({
        key: `work-log:${row.key}`,
        timestamp: rows[cursor - 1]!.timestamp,
        event: {
          type: "work_log_group",
          entries,
          turnId: entries[0]?.turnId ?? null,
        },
      });
      index = cursor;
      continue;
    }

    if (isActivityBundleSourceEvent(row.event)) {
      const items: ChatActivityBundleItem[] = [];
      const baseTurnId = activityBundleTurnId(row.event);
      let cursor = index;
      while (cursor < rows.length) {
        const candidate = rows[cursor]!;
        if (!isActivityBundleSourceEvent(candidate.event)) break;
        const candidateEvent = candidate.event;
        const candidateTurnId = activityBundleTurnId(candidateEvent);
        if (items.length > 0 && (!baseTurnId || !candidateTurnId || baseTurnId !== candidateTurnId)) break;
        items.push({
          key: candidate.key,
          timestamp: candidate.timestamp,
          event: candidateEvent,
        });
        cursor += 1;
      }
      grouped.push({
        key: `activity:${row.key}`,
        timestamp: rows[cursor - 1]!.timestamp,
        event: {
          type: "activity_bundle",
          items,
          turnId: baseTurnId,
        },
      });
      index = cursor;
      continue;
    }

    // Group consecutive reasoning events into a single merged reasoning event.
    // Same-turn blocks merge even when the provider gave them different item
    // ids (Claude persists one thought twice, under the stream index and the
    // snapshot index); identical text collapses instead of repeating. The
    // fragments are collected and merged in ONE call so a cumulative re-emit
    // covering two earlier blocks drops both, which a pairwise fold cannot see.
    if (row.event.type === "reasoning") {
      const firstReasoning = row.event;
      const mergedStartTimestamp = firstReasoning.startTimestamp ?? row.timestamp;
      const firstTurnId = firstReasoning.turnId ?? null;
      // Fold deltas of the SAME reasoning item with `mergeReasoningFragment`
      // first, so a streamed delta split across a removed hidden row rejoins as
      // "Hello world" rather than two `---`-separated blocks. Claude's
      // double-persist gives the snapshot a different item id, so cross-item
      // containment in `mergeReasoningTextFragments` still collapses it.
      const blocks: string[] = [];
      let currentItemKey = `${firstReasoning.itemId ?? ""}\u0000${firstReasoning.summaryIndex ?? ""}`;
      let currentText = firstReasoning.text ?? "";
      let cursor = index + 1;
      const flushBlock = () => {
        if (currentText.length) blocks.push(currentText);
      };
      while (cursor < rows.length) {
        const nextRow = rows[cursor]!;
        if (nextRow.event.type !== "reasoning") break;
        if ((nextRow.event.turnId ?? null) !== firstTurnId) break;
        const nextItemKey = `${nextRow.event.itemId ?? ""}\u0000${nextRow.event.summaryIndex ?? ""}`;
        if (nextItemKey === currentItemKey) {
          currentText = mergeReasoningFragment(currentText, nextRow.event.text ?? "");
        } else {
          flushBlock();
          currentText = nextRow.event.text ?? "";
          currentItemKey = nextItemKey;
        }
        cursor += 1;
      }
      if (cursor > index + 1) {
        // Multiple consecutive reasoning events — merge them
        flushBlock();
        const lastRow = rows[cursor - 1]!;
        grouped.push({
          key: `reasoning-group:${row.key}`,
          timestamp: lastRow.timestamp,
          event: {
            ...firstReasoning,
            text: mergeReasoningTextFragments(blocks),
            startTimestamp: mergedStartTimestamp,
          },
        });
        index = cursor;
        continue;
      }
    }

    // Deduplicate consecutive status events with the same turnStatus
    if (row.event.type === "status") {
      const prev = grouped[grouped.length - 1];
      if (
        prev
        && prev.event.type === "status"
        && (prev.event as any).turnStatus === (row.event as any).turnStatus
        && ((prev.event as any).turnId ?? null) === ((row.event as any).turnId ?? null)
        && ((prev.event as any).message ?? "") === ((row.event as any).message ?? "")
      ) {
        // Keep the later one (replace the previous)
        grouped[grouped.length - 1] = row;
        index += 1;
        continue;
      }
    }

    grouped.push(row);
    index += 1;
  }

  return consolidateInterruptedTerminus(grouped);
}

function isActivityBundleSourceEvent(event: ChatTranscriptRenderEvent): event is ChatActivityBundleItem["event"] {
  // Subagent lifecycle events now render as dedicated spawn/result/job-line rows
  // and never reach here. `background_task` scheduled work is consumed by the
  // collapse pass into a `background_job_line`; other scheduled kinds keep
  // bundling.
  return event.type === "scheduled_work_update" && event.kind !== "background_task";
}

function activityBundleTurnId(event: ChatActivityBundleItem["event"]): string | null {
  return "turnId" in event ? event.turnId ?? null : null;
}

function classifyActivityPhaseRow(
  row: ChatTranscriptGroupedEnvelope,
): { kind: "reasoning" | "work"; turnId: string | null } | null {
  if (row.event.type === "reasoning") {
    return { kind: "reasoning", turnId: (row.event as RenderReasoningEvent).turnId ?? null };
  }
  if (row.event.type === "work_log_group") {
    return { kind: "work", turnId: row.event.turnId ?? row.event.entries[0]?.turnId ?? null };
  }
  return null;
}

function mergeActivityPhaseRows(
  phase: readonly ChatTranscriptGroupedEnvelope[],
  meta: ActivityPhaseMergeMeta,
): ChatTranscriptGroupedEnvelope[] {
  const reasoningRows = phase.filter((row) => row.event.type === "reasoning");
  const workRows = phase.filter((row) => row.event.type === "work_log_group");
  const merged: ChatTranscriptGroupedEnvelope[] = [];

  const pushReasoning = () => {
    if (reasoningRows.length === 0) return;
    if (reasoningRows.length === 1) {
      merged.push(reasoningRows[0]!);
      return;
    }
    const first = reasoningRows[0]!;
    const last = reasoningRows[reasoningRows.length - 1]!;
    const mergedText = mergeReasoningTextFragments(
      reasoningRows.map((row) => (row.event as RenderReasoningEvent).text ?? ""),
    );
    merged.push({
      key: `activity-phase-reasoning:${first.key}`,
      timestamp: last.timestamp,
      event: {
        ...(first.event as RenderReasoningEvent),
        text: mergedText,
        startTimestamp: (first.event as RenderReasoningEvent).startTimestamp ?? first.timestamp,
        latestStartTimestamp: (last.event as RenderReasoningEvent).startTimestamp ?? last.timestamp,
      },
    });
  };

  const pushWork = () => {
    if (workRows.length === 0) return;
    if (workRows.length === 1) {
      merged.push(workRows[0]!);
      return;
    }
    const first = workRows[0]!;
    const last = workRows[workRows.length - 1]!;
    const entries = workRows.flatMap((row) => (row.event.type === "work_log_group" ? row.event.entries : []));
    const summary = [...workRows]
      .reverse()
      .map((row) => (row.event.type === "work_log_group" ? row.event.summary?.trim() : ""))
      .find((value) => value && value.length > 0);
    const toolUseIds = [...new Set(workRows.flatMap((row) => (
      row.event.type === "work_log_group" ? row.event.toolUseIds ?? [] : []
    )))];
    merged.push({
      key: `activity-phase-work:${first.key}`,
      timestamp: last.timestamp,
      event: {
        type: "work_log_group",
        entries,
        turnId: first.event.type === "work_log_group"
          ? first.event.turnId ?? first.event.entries[0]?.turnId ?? null
          : null,
        ...(summary ? { summary } : {}),
        ...(toolUseIds.length > 0 ? { toolUseIds } : {}),
      },
    });
  };

  if (meta.workFirst) {
    pushWork();
    pushReasoning();
  } else {
    pushReasoning();
    pushWork();
  }
  return merged;
}

export function collapseGroupedActivityPhaseRows(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  return collapseActivityPhaseRows(rows, classifyActivityPhaseRow, mergeActivityPhaseRows);
}

/**
 * Rejoin activity bundles that became adjacent after presentation-only rows
 * were removed. The common case is `scheduled work → tool call → scheduled
 * work`: tool-only work logs stay available to the turn-finished activity
 * disclosure, but are hidden as permanent transcript rows. Grouping before that
 * visibility filter used to leave two bundles separated by an invisible row.
 *
 * Identity stays anchored to the first bundle so the virtualizer does not
 * remount the card as later task updates arrive. Missing/different turn ids are
 * intentionally hard boundaries; grouping remains structural, never temporal.
 */
export function mergeAdjacentActivityBundleRows(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const merged: ChatTranscriptGroupedEnvelope[] = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    if (
      previous?.event.type === "activity_bundle"
      && row.event.type === "activity_bundle"
      && previous.event.turnId
      && row.event.turnId
      && previous.event.turnId === row.event.turnId
    ) {
      merged[merged.length - 1] = {
        key: previous.key,
        timestamp: row.timestamp,
        event: {
          ...previous.event,
          items: [...previous.event.items, ...row.event.items],
        },
      };
      continue;
    }
    merged.push(row);
  }
  return merged;
}

function groupChatTranscriptRowsCore(
  rows: ChatTranscriptRenderEnvelope[],
  previousRows: readonly ChatTranscriptGroupedEnvelope[] = [],
): ChatTranscriptGroupedEnvelope[] {
  // Background job lines are grouped later, on the drawn rows
  // (`groupBackgroundJobRuns`), so rows the timeline filters out cannot split a run.
  return groupStoppedSubagentResultCards(
    collapseGroupedActivityPhaseRows(groupConsecutiveWorkLogRows(rows)),
    previousRows,
  );
}

/**
 * Split `rows` into maximal consecutive runs that share one `voiceCallId` (rows
 * with no id form their own runs), group each run with `groupRun`, and fold each
 * voice run into a single `voice_call_group` row carrying its grouped rows.
 *
 * With no voice-stamped rows present there is exactly ONE run — the whole array —
 * so the output is identical to calling `groupRun(rows)` directly. That property
 * is what makes this safe to wrap the existing passes with.
 */
export function groupVoiceCallRows(
  rows: ChatTranscriptRenderEnvelope[],
  groupRun: (run: ChatTranscriptRenderEnvelope[]) => ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  if (!rows.some((row) => row.voiceCallId)) return groupRun(rows);

  const result: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;
  while (index < rows.length) {
    const callId = rows[index]!.voiceCallId ?? null;
    let end = index + 1;
    while (end < rows.length && (rows[end]!.voiceCallId ?? null) === callId) end += 1;
    const grouped = groupRun(rows.slice(index, end));
    if (callId) {
      const folded = foldVoiceCallRun(callId, grouped);
      if (folded) result.push(folded);
    } else {
      result.push(...grouped);
    }
    index = end;
  }
  return result;
}

/**
 * Derive the one card a call's rows collapse into. A call that produced no rows
 * cannot reach here — no rows means no run — which is how "a call that said
 * nothing posts no card" falls out for free.
 */
function foldVoiceCallRun(
  callId: string,
  grouped: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope | null {
  const first = grouped[0];
  const last = grouped[grouped.length - 1];
  if (!first || !last) return null;

  let exchanges = 0;
  let openingLine: string | null = null;
  let hadApproval = false;
  for (const row of grouped) {
    if (row.event.type === "user_message") {
      exchanges += 1;
      if (openingLine === null) {
        const text = row.event.displayText?.trim() || row.event.text.trim();
        openingLine = text ? summarizeInlineText(text, 120) : null;
      }
    } else if (row.event.type === "approval_request") {
      hadApproval = true;
    }
  }

  const startedAt = Date.parse(first.timestamp);
  const endedAt = Date.parse(last.timestamp);
  const span = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : null;

  return {
    key: `voice-call:${callId}`,
    timestamp: last.timestamp,
    voiceCallId: callId,
    event: {
      type: "voice_call_group",
      callId,
      durationMs: span !== null && span >= 0 ? span : null,
      exchanges,
      openingLine,
      hadApproval,
      rows: grouped,
    },
  };
}

export {
  applyChatTranscriptTurnFolds,
  deriveChatTranscriptTurnFolds,
  describeTurnFoldRow,
  sameTurnFolds,
} from "./chatTranscriptTurnFolds";

export {
  groupSubagentCardGrids,
  meaningfulStoppedSummary,
  subagentCardGridColumns,
  subagentCardGridKeyByMemberKey,
  subagentCardGridSpan,
  subagentCardRowKeyCandidates,
} from "./chatSubagentCardGrid";

export function groupChatTranscriptRows(
  rows: ChatTranscriptRenderEnvelope[],
  previousRows: readonly ChatTranscriptGroupedEnvelope[] = [],
): ChatTranscriptGroupedEnvelope[] {
  return groupVoiceCallRows(rows, (run) => groupChatTranscriptRowsCore(run, previousRows));
}

/**
 * Rows that never mount a visible transcript item are dropped before grouping.
 * Anchor lookup must use the same filter so stable row keys agree with the
 * rendered transcript.
 */
export function filterVisibleTranscriptRows(
  rows: readonly ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  return rows.filter(({ event }) => {
    if (event.type === "context_usage" && event.origin !== undefined && event.origin !== "command") return false;
    if (event.type === "model_handoff" && event.fromProvider === event.toProvider) return false;
    return true;
  });
}

type TerminusDoneEvent = Extract<AgentChatEvent, { type: "done" }>;


/**
 * Which `done` in a cancellation cluster is the parent turn's. The subagents'
 * `done` events can arrive before or after it and can carry more tokens, so
 * neither order nor usage decides. In order of evidence:
 *   1. the id on the turn's user message;
 *   2. the first id that the turn's own rows (after that user message) carry —
 *      the parent's reasoning/text/tool rows come before any subagent's;
 *   3. the id on a `status` row inside the cluster;
 *   4. a `done` with no turn id (subagent terminals always carry theirs), whose
 *      id is then inferred from the window;
 *   5. the `done` with the most tokens (the old rule), when nothing else says.
 */
function resolveTerminusParent(
  previousRows: readonly ChatTranscriptGroupedEnvelope[],
  cluster: readonly ChatTranscriptGroupedEnvelope[],
  doneEvents: readonly TerminusDoneEvent[],
): { done: TerminusDoneEvent; turnId: string | null } {
  const doneTurnId = (done: TerminusDoneEvent): string | null => done.turnId?.trim() || null;
  const byTurnId = (turnId: string | null) => (
    turnId ? doneEvents.find((done) => doneTurnId(done) === turnId) ?? null : null
  );

  // The turn's window: back to its user message or the previous turn end.
  let start = previousRows.length;
  let boundaryTurnId: string | null = null;
  while (start > 0) {
    const row = previousRows[start - 1]!;
    if (row.event.type === "done") break;
    if (classifyTurnFoldEvent(row.event) === "boundary") {
      boundaryTurnId = groupedEnvelopeTurnId(row);
      break;
    }
    start -= 1;
  }
  const windowRows = previousRows.slice(start).map((row) => ({
    role: classifyTurnFoldEvent(row.event),
    turnId: groupedEnvelopeTurnId(row),
  }));

  const fromBoundary = byTurnId(boundaryTurnId);
  if (fromBoundary) return { done: fromBoundary, turnId: boundaryTurnId };
  for (const row of windowRows) {
    const match = byTurnId(row.turnId);
    if (match) return { done: match, turnId: row.turnId };
  }
  for (let index = cluster.length - 1; index >= 0; index -= 1) {
    const event = cluster[index]!.event;
    if (event.type !== "status") continue;
    const match = byTurnId(event.turnId?.trim() || null);
    if (match) return { done: match, turnId: doneTurnId(match) };
  }
  const idless = doneEvents.find((done) => !doneTurnId(done));
  if (idless) return { done: idless, turnId: inferTurnEndTurnId(boundaryTurnId, windowRows) };
  const heaviest = doneEvents.reduce((best, candidate) => {
    const bestTokens = (best.usage?.inputTokens ?? 0) + (best.usage?.outputTokens ?? 0);
    const candidateTokens = (candidate.usage?.inputTokens ?? 0) + (candidate.usage?.outputTokens ?? 0);
    return candidateTokens > bestTokens ? candidate : best;
  }, doneEvents[0]!);
  return { done: heaviest, turnId: doneTurnId(heaviest) };
}

// Collapse consecutive interrupted/failed status + done rows (parent turn + N subagents)
// into a single done row. Cancellation in chats with subagents otherwise produces a stack of
// near-duplicate INTERRUPTED + USAGE rows; this folds them into one summary line.
function consolidateInterruptedTerminus(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const isTerminus = (env: ChatTranscriptGroupedEnvelope): boolean => {
    const e = env.event;
    if (e.type === "status" && (e.turnStatus === "interrupted" || e.turnStatus === "failed")) {
      return true;
    }
    if (e.type === "done" && (e.status === "interrupted" || e.status === "failed")) {
      return true;
    }
    return false;
  };

  const result: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!isTerminus(row)) {
      result.push(row);
      index += 1;
      continue;
    }

    let end = index;
    while (end < rows.length && isTerminus(rows[end]!)) end += 1;
    const cluster = rows.slice(index, end);
    index = end;

    const doneEvents = cluster
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEvent, { type: "done" }> => event.type === "done");

    // Only consolidate clusters that include at least one done event — that's the noisy
    // cancellation pattern. Pure-status clusters keep their existing behavior so legitimately
    // distinct signals (e.g. failed + interrupted) remain visible.
    if (doneEvents.length === 0 || cluster.length === 1) {
      for (const entry of cluster) result.push(entry);
      continue;
    }

    const sumOptional = (...values: Array<number | null | undefined>): number | undefined => {
      let total = 0;
      let any = false;
      for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
          total += value;
          any = true;
        }
      }
      return any ? total : undefined;
    };

    const parent = resolveTerminusParent(result, cluster, doneEvents);
    const base = parent.done;

    const inputTokens = sumOptional(...doneEvents.map((event) => event.usage?.inputTokens ?? null));
    const outputTokens = sumOptional(...doneEvents.map((event) => event.usage?.outputTokens ?? null));
    const cacheReadTokens = sumOptional(...doneEvents.map((event) => event.usage?.cacheReadTokens ?? null));
    const cacheCreationTokens = sumOptional(...doneEvents.map((event) => event.usage?.cacheCreationTokens ?? null));
    const costUsd = sumOptional(...doneEvents.map((event) => event.costUsd ?? null));
    const status = doneEvents.some((event) => event.status === "failed") ? "failed" : "interrupted";
    const subagentStoppedCount = doneEvents.length - 1;

    const lastInCluster = cluster[cluster.length - 1]!;
    result.push({
      key: `terminus:${lastInCluster.key}`,
      timestamp: lastInCluster.timestamp,
      event: {
        ...base,
        // The row is the PARENT turn's end: its id keys the turn fold, the
        // usage-limit footer, proof, and the checkpoint diff.
        turnId: parent.turnId ?? base.turnId,
        status,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        },
        costUsd,
        subagentStoppedCount: subagentStoppedCount > 0 ? subagentStoppedCount : undefined,
      },
    });
  }

  return result;
}

export type TurnDividerDataEntry = {
  turnId: string;
  startTimestamp: string;
  endTimestamp?: string;
  model?: string;
  modelId?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  status?: "completed" | "interrupted" | "failed";
};

export function deriveTurnDividerData(events: AgentChatEventEnvelope[]): Map<string, TurnDividerDataEntry> {
  const turns = new Map<string, TurnDividerDataEntry>();

  for (const envelope of events) {
    const event = envelope.event;
    const turnId = ("turnId" in event && typeof event.turnId === "string") ? event.turnId.trim() : "";
    if (!turnId) continue;

    if (!turns.has(turnId)) {
      turns.set(turnId, {
        turnId,
        startTimestamp: envelope.timestamp,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });
    }
    const entry = turns.get(turnId)!;

    if (event.type === "file_change" && event.status !== "running") {
      entry.filesChanged++;
      const stats = summarizeDiffStats(event.diff);
      entry.insertions += stats.additions;
      entry.deletions += stats.deletions;
    }

    if (event.type === "done") {
      entry.endTimestamp = envelope.timestamp;
      entry.status = event.status;
      entry.model = event.model;
      entry.modelId = event.modelId;
      if (event.usage) {
        entry.inputTokens = event.usage.inputTokens ?? undefined;
        entry.outputTokens = event.usage.outputTokens ?? undefined;
        entry.cacheReadTokens = event.usage.cacheReadTokens ?? undefined;
      }
      if (event.costUsd != null) entry.costUsd = event.costUsd;
    }

    if (event.type === "tokens") {
      if (event.inputTokens != null) entry.inputTokens = event.inputTokens;
      if (event.outputTokens != null) entry.outputTokens = event.outputTokens;
      if (event.cacheReadTokens != null) entry.cacheReadTokens = event.cacheReadTokens;
    }
  }

  return turns;
}

export type TurnTokenUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningTokens?: number | null;
};

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Colored turn-line counts: input, output, and cache read. */
export function formatTurnTokenParts(usage: TurnTokenUsage | null | undefined): {
  input: string | null;
  output: string | null;
  cached: string | null;
} | null {
  if (!usage) return null;
  const input = formatTokenCount(usage.inputTokens);
  const output = formatTokenCount(usage.outputTokens);
  const cached = formatTokenCount(usage.cacheReadTokens);
  if (!input && !output && !cached) return null;
  return { input, output, cached };
}

export function formatDoneTurnTokenLine(usage: TurnTokenUsage | null | undefined): string | null {
  if (!usage) return null;
  const segments: string[] = [];
  const inLabel = formatTokenCount(usage.inputTokens);
  const outLabel = formatTokenCount(usage.outputTokens);
  const cacheLabel = formatTokenCount(usage.cacheReadTokens);
  const cacheWriteLabel = formatTokenCount(usage.cacheCreationTokens);
  const reasoningLabel = formatTokenCount(usage.reasoningTokens);
  if (inLabel) segments.push(`in ${inLabel}`);
  if (outLabel) segments.push(`out ${outLabel}`);
  if (cacheLabel) segments.push(`cached ${cacheLabel} ✶`);
  if (cacheWriteLabel) segments.push(`cache write ${cacheWriteLabel}`);
  if (reasoningLabel) segments.push(`reasoning ${reasoningLabel}`);
  return segments.length > 0 ? segments.join(" · ") : null;
}

// ── Turn fold ───────────────────────────────────────────────────────────────
// The rules live in `shared/chatTurnFold.ts`; this is the desktop adapter that
// describes grouped rows in the fold's vocabulary and splices the fold rows in.
