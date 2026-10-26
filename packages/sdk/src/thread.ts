import {
  approvalFromObserved,
  approvalFromPendingInput,
  engineApprovalDecision,
  isApprovalShaped,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./approvals.js";
import { ApprovalTracker } from "./approvalTracker.js";
import { completeAttachments } from "./attachments.js";
import { AdeError } from "./errors.js";
import type { ChatEventSource } from "./eventStream.js";
import { readHistoryPage, type HistoryPageOptions } from "./historyPage.js";
import {
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSourcesCapability,
  type InstructionsCapability,
  type PermissionCapability,
  type SettingSourcesCapability,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import {
  hasMcpToolFilters,
  mcpServersFingerprint,
  missingHeadersWarning,
  storedMcpServersNeedHeaders,
  withResolvedHeaders,
  type McpHeadersResolver,
  type StoredMcpServerConfig,
} from "./mcpHeaders.js";
import { modelSelectionOf, type ModelSummaryFields } from "./modelSelection.js";
import { isSupportedProvider } from "./permissions.js";
import { summaryTurnActive, type PersonalChatsApi } from "./personalChats.js";
import { budgetExceeded, ThreadUsageAccumulator, type ThreadBudget, type ThreadUsage } from "./usage.js";
import {
  STATUS_EVENT_TYPES,
  USAGE_EVENT_TYPES,
  type AdeProvider,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type McpCapabilityReport,
  type McpServerConfig,
  type AgentChatStopMode,
  type AgentChatUsageLimitResult,
  type AgentChatSlashCommand,
  type AgentChatRecoverTurnResult,
  type AgentChatResolveUnprocessedMessageResult,
  type AgentChatSwitchAccountResult,
  type AgentChatRespondToInputArgs,
  type ThreadCapabilities,
  type ThreadHistoryPage,
  type ThreadModelSelection,
  type Unsubscribe,
} from "./types.js";

export type { ThreadModelSelection } from "./types.js";
export type { HistoryPageOptions } from "./historyPage.js";

export type ThreadEventChannel = "event" | "usage" | "status";

export type SetModelOptions = {
  /**
   * Switch even with a turn in flight, accepting that the turn ends with no
   * completion event. Only meaningful mid-turn; ignored on an idle thread.
   */
  force?: boolean;
};

/**
 * What `setModel` returns: the resolved model, plus the four capability
 * reports as they stand on the new provider.
 *
 * A switch across providers can quietly lower a guarantee — a policy Claude
 * enforced is best-effort on Codex — so the reports come back with the answer
 * rather than leaving the caller to re-read four fields and notice. The same
 * object is emitted as `capabilities_changed` on the thread's `status`
 * channel, for subscribers that did not make the call.
 */
export type SetModelResult = ThreadModelSelection & { capabilities: ThreadCapabilities };

export type SendOptions = {
  /** Files to attach. `type` is inferred when absent; see `AgentChatFileRef`. */
  attachments?: AgentChatFileRef[];
  /** Text shown to the user when it differs from what the agent receives. */
  displayText?: string;
  reasoningEffort?: string | null;
};

export type ThreadQueueItem = {
  id: string;
  text: string;
  attachments?: AgentChatFileRef[];
};

export type ThreadInterruptOptions = {
  /** Keep queued messages, or remove them along with the active turn. */
  queue?: "keep" | "drop";
  /** Full ADE stop semantics. When set, this takes precedence over `queue`. */
  mode?: AgentChatStopMode;
};

/** The response fields accepted by the runtime's `respondToInput` action. */
export type ThreadRespondOptions = Pick<
  AgentChatRespondToInputArgs,
  "answers" | "decision" | "responseText"
>;

const RESPOND_FIELDS: ReadonlySet<string> = new Set(["answers", "decision", "responseText"]);
const RESPOND_DECISIONS: ReadonlySet<string> = new Set([
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
]);

/** Options for `steer`. */
export type SteerOptions = {
  /**
   * Files to hand the running turn. Same shape and inference as
   * `SendOptions.attachments`. A steer with attachments may have empty text.
   */
  attachments?: AgentChatFileRef[];
};

/**
 * What `update` may change on a live thread.
 *
 * `title` is a rename and is safe at any time. `reasoningEffort` and
 * `fastMode` reconfigure the provider, which on some providers restarts it —
 * so they follow the same mid-turn rule `setModel` does.
 */
export type ThreadUpdate = {
  /**
   * New title. Persisted in the thread store as well. A host title marks the
   * chat as named: the runtime's automatic title never replaces it.
   *
   * `null` clears the host title. The chat then shows the provider's
   * placeholder title ("Claude Chat", "Codex Chat"), so `thread.title` reads
   * that string, not null, and the automatic title may name the chat again
   * after its next message (runtime >= 1.2.82; before, `null` set the
   * placeholder and still counted as named).
   */
  title?: string | null;
  /** Reasoning effort for later turns. `null` returns to the model default. */
  reasoningEffort?: string | null;
  /** Provider fast mode, where the provider has one. */
  fastMode?: boolean;
};

/** Options for `update`. */
export type ThreadUpdateOptions = {
  /**
   * Apply `reasoningEffort` / `fastMode` even with a turn in flight, accepting
   * that some providers end that turn without a completion event. Ignored for
   * a title-only update, which never needs it.
   */
  force?: boolean;
};

/** What `update` returns: the thread's title and model after the change. */
export type ThreadUpdateResult = {
  title: string | null;
  model: ThreadModelSelection | null;
};

/** Options for `editLast`. */
export type EditLastOptions = {
  /** Text shown to the user when it differs from what the agent receives. */
  displayText?: string;
  /**
   * Files for the edited message, replacing the original's. Omit to keep the
   * original message's attachments; pass `[]` to drop them.
   */
  attachments?: AgentChatFileRef[];
};

/**
 * What `retry` and `editLast` return, once the runtime has cut the old turn
 * out and dispatched the new one. The new turn's events follow on the stream.
 *
 * The rollback is the CONVERSATION only. Files the old turn wrote stay on
 * disk, and this result does not report them (see `retry`).
 */
export type ThreadRerunResult = {
  /**
   * The first history `sequence` removed. Every event at or after it is gone
   * from the runtime's history; drop the same events from any copy you keep —
   * and inspect them there if you want to warn about files the old turn wrote.
   */
  retractedFromSequence: number;
  /**
   * The thread's history generation after the cut. The runtime also emits a
   * `session_meta_updated` event with `historyInvalidated: true` and this
   * generation, before the new turn's first event.
   */
  historyGeneration: number;
  /**
   * How the provider conversation went back: `claude_fork` (the Claude session
   * was copied up to the entry before the turn), `claude_new_session` (the
   * turn was the first, so a new Claude session starts), `codex_thread` (the
   * Codex thread was reverted or forked before the turn), or `not_delivered`
   * (the turn never reached the provider, so only the history changed).
   */
  conversationRollback: "claude_fork" | "claude_new_session" | "codex_thread" | "not_delivered";
};

export interface AdeThread {
  /**
   * The runtime session id. Stable for the life of the thread, EXCEPT across a
   * recreate: if an `autoRestart` finds the runtime lost the session, the key
   * is rebuilt on a new session and this id changes. Key your own state on
   * `key`, not on this.
   */
  readonly id: string;
  readonly key: string;
  /**
   * The thread's title, or null. Updated by `update({ title })`; the runtime
   * may also retitle a thread after its first turn, which this reflects at the
   * next open or `update`.
   */
  readonly title: string | null;
  /**
   * What the thread's model resolved to, with the catalog display name.
   *
   * Kept current by `setModel`. Null only when the runtime reported no model.
   * Show `displayName` rather than the id when it is non-null: after a CLI
   * update retires a model the runtime resolves the id forward, and the raw id
   * a host stored is then the wrong label.
   */
  readonly model: ThreadModelSelection | null;
  /**
   * What the provider did with this thread's `mcpServers` / strict-mode request.
   *
   * Only Claude enforces strict mode outright. Every other provider is
   * best-effort with a named `residual`, so an embedder that promised its users
   * an isolated tool surface must read this rather than assume the request
   * landed whole. Populated on create AND on resume — a reopened thread rebuilds
   * the same tool surface it started with, and reports the same caveat.
   *
   * Null means one of two things, and they are NOT equivalent:
   *   - the thread asked for neither `mcpServers` nor strict mode; or
   *   - the runtime did not report one. Older runtimes omit the field
   *     entirely. The SDK logs a warning in that case rather than letting a
   *     missing report read as "nothing was requested" — if you asked for
   *     servers and got null here, treat the guarantee as unverified.
   */
  readonly mcpCapability: McpCapabilityReport | null;
  /**
   * What the provider did with this thread's `instructions`.
   *
   * Null when the thread asked for none, or when an older runtime reported
   * nothing — the same two-case ambiguity `mcpCapability` has, and for the same
   * reason: the SDK does not invent a verdict it did not receive.
   *
   * `level` is `"applied"` on Claude, Codex, OpenCode and Pi, which all take
   * instructions through a channel of their own; `"best-effort"` on Cursor and
   * Droid, where ADE merges the text into a prompt it already prefixes.
   */
  readonly instructionsCapability: InstructionsCapability | null;
  /**
   * What the provider did with this thread's `settingSources`.
   *
   * Only Claude has a real switch. Codex reports `"best-effort"` for `project`
   * and `all` because it always reads its own user-level file too, and every
   * other provider reports `"ignored"` — the value did not reach it.
   */
  readonly settingSourcesCapability: SettingSourcesCapability | null;
  /**
   * What the provider could enforce of this thread's permission policy.
   *
   * Null when the thread opened with a preset rather than a policy. Read
   * `level` before telling a user their rules are in force: only Claude gates
   * every tool call against the policy, Codex approximates it with containment
   * and approval settings, and the rest cannot express it at all.
   */
  readonly permissionCapability: PermissionCapability | null;
  /**
   * Queue a message for the agent.
   *
   * DISPATCH-RESOLUTION ASYMMETRY: this resolves when the turn has been
   * DISPATCHED, not when the reply is complete. Nothing in the returned promise
   * tells you a turn is still streaming, so code that runs after an `await
   * send(...)` must not assume the thread is idle. Before any destructive
   * operation — `setModel`, `dispose` — either await the completion event on
   * `on("status")` or check the thread's status; `setModel` enforces this for
   * you and throws rather than silently ending the turn.
   *
   * With an `mcpHeaders` callback and remote MCP servers, the headers are
   * resolved again first (see `refreshMcpHeaders`), so a token that expired
   * since the last turn is replaced before this one. A refresh that fails is
   * logged and the message is still sent, on the headers the session has.
   */
  send(text: string, opts?: SendOptions): Promise<void>;
  /**
   * Add input to the turn in flight, without waiting for it to end.
   *
   * Needs text, attachments, or both. Attachments follow the same rules as
   * `send`. Resolves once the runtime accepted the steer, not once the agent
   * read it.
   */
  steer(text: string, opts?: SteerOptions): Promise<void>;
  interrupt(): Promise<void>;
  /**
   * Rename the thread, or change its reasoning effort or fast mode.
   *
   * A title-only update is allowed at any time. `reasoningEffort` and
   * `fastMode` are refused while a turn is in flight (`AdeError` code
   * `turn_in_flight`, SDK >= 0.4) unless `{ force: true }`:
   * on Codex a settings change the provider rejects tears the provider down,
   * which ends the turn without `error` or `done` — the silent truncation the
   * client's destructive-while-streaming rule forbids. Await the turn or
   * `interrupt()` first.
   *
   * Resolves with the title and model as the runtime reports them afterwards.
   */
  update(patch: ThreadUpdate, opts?: ThreadUpdateOptions): Promise<ThreadUpdateResult>;
  /**
   * Run the last user turn again, as if the first attempt never happened.
   *
   * The runtime rolls the provider conversation back to just before the last
   * user message, removes that message and everything after it from the
   * thread's history, and sends the same message (text and attachments) again.
   * The history then holds the message once. Files the old turn changed are
   * NOT restored: the rollback covers the conversation, not the disk.
   *
   * The result does not say whether the old turn wrote files, because the
   * runtime cannot tell which of YOUR tools write. A host that lets the agent
   * write can find them itself: the removed events are the ones at or after
   * `retractedFromSequence` in your own copy of the history, so inspect their
   * tool calls and warn the user if any of them was a write.
   *
   * What a subscriber sees, in order: `session_meta_updated` with
   * `historyInvalidated: true` and the new `historyGeneration` (drop your copy
   * of the events at or after `retractedFromSequence`, or re-read `history()`),
   * then the new turn's `user_message`, `status: started`, and the rest of the
   * turn. A `history()` or `historyPage()` read after the call returns only the
   * new attempt.
   *
   * Claude and Codex only. Throws `turn_in_flight` while a turn runs or waits
   * on an approval (nothing changed; await it or `interrupt()` first),
   * `unsupported` for another provider or a runtime without the action, and
   * `rpc_error` when the thread has no user message yet.
   *
   * Resolves once the new turn is dispatched, not once it ends.
   */
  retry(): Promise<ThreadRerunResult>;
  /**
   * Replace the last user message with `text` and run it again.
   *
   * Everything `retry` says applies: same rollback, same event sequence, same
   * errors, and the history shows only the edited message. `text` may be empty
   * only when `opts.attachments` is non-empty. Attachments default to the
   * original message's.
   */
  editLast(text: string, opts?: EditLastOptions): Promise<ThreadRerunResult>;
  /**
   * Replace this thread's caller MCP servers wholesale.
   *
   * For a credential or URL that changed: a rotated bearer token, a port that
   * moved. The provider picks the new servers up on the next turn. Header
   * values are sent to the runtime and never persisted by the SDK — the thread
   * store keeps header names only.
   *
   * A remote server passed without `headers` gets them from the client's
   * `mcpHeaders` callback, when there is one.
   *
   * Mid-turn, the runtime validates the servers at once (a bad map still
   * rejects) and queues them for the end of the running turn — completed,
   * interrupted or failed — and the call resolves. A later call replaces a
   * queued map. Until the swap the summary reports `mcpServersPending: true`,
   * and `mcpCapability` keeps describing the servers the running turn has. A
   * runtime without `capabilities.personalChats.deferredMcpUpdates` refuses
   * mid-turn instead (`turn_in_flight`).
   *
   * Refused by the SDK on a runtime that does not advertise
   * `capabilities.personalChats.updateMcpServers` (`invalid_option`) — an older
   * runtime would ignore the field and leave the old credentials in place,
   * which is worse than failing. The same goes for `allowedTools` /
   * `disallowedTools` on a runtime without `mcpToolFilters`, and for a filter
   * the thread's provider cannot enforce (see `McpToolFilter`).
   *
   * A map identical to the one this client last sent for the thread — header
   * values included — is not sent again: the call resolves with the current
   * `mcpCapability` and the provider is left alone. So a renderer that reloads
   * and repeats the same `refresh` does not restart anything.
   *
   * Resolves with the thread's new `mcpCapability`.
   */
  updateMcpServers(servers: Record<string, McpServerConfig>): Promise<McpCapabilityReport | null>;
  /**
   * Resolve this thread's MCP header values again through the client's
   * `mcpHeaders` callback and push them when they changed.
   *
   * `send`, `retry` and `editLast` already do this before every turn; call it
   * yourself right after rotating a token, so the swap does not wait for the
   * next message. The servers are the thread's own (the last map it was
   * opened or updated with); only the header values of its remote servers
   * that carry headers are re-resolved, and a thread with none is a no-op. Values
   * identical to the last ones sent push nothing. Mid-turn the push is queued
   * for the end of the turn, as `updateMcpServers` is.
   *
   * Throws `invalid_option` without an `mcpHeaders` callback, on a runtime
   * without `updateMcpServers`, and when the callback supplies nothing for a
   * server that needs headers: pushing would replace that server's live
   * credentials with none. A callback that throws rejects this call with its
   * error. Resolves with the thread's `mcpCapability`.
   */
  refreshMcpHeaders(): Promise<McpCapabilityReport | null>;
  /**
   * Switch this thread's model, including across providers — the runtime tears
   * the old one down and replays the transcript into the new one.
   *
   * Refused while a turn is in flight (code `turn_in_flight`, SDK >= 0.4)
   * unless `{ force: true }`: the switch would
   * end that turn without emitting `error` or `done`, so a caller who did not
   * know a turn was running would see the response simply stop. Await the turn
   * or `interrupt()` first.
   *
   * Returns what the model actually resolved to — the runtime resolves aliases
   * and CLI-wrapped ids, so it can differ from what you passed — together with
   * the four capability reports on the new provider. The same reports are
   * emitted as a `capabilities_changed` envelope on the `status` channel.
   */
  setModel(modelId: string, opts?: SetModelOptions): Promise<SetModelResult>;
  /**
   * The durable transcript, newest `limit` events (all of them when omitted,
   * up to the runtime's own cap of about 20,000 events / 2 MB). For a long
   * thread prefer `historyPage`, which reads one bounded page at a time.
   */
  history(opts?: { limit?: number }): Promise<AgentChatEventEnvelope[]>;
  /** Token totals observed on this thread; cost is present only when reported by the provider. */
  usage(): ThreadUsage;
  /**
   * One page of the durable transcript, for "load older" on scroll.
   *
   * Without `beforeSequence` this is the newest page. Each page reports the
   * cursor for the one before it. Events are oldest-first within a page.
   *
   * On a runtime without the `getEventHistoryPage` action, only the newest page
   * is available: an older-page request returns an empty page with
   * `hasMore: false` and logs once.
   */
  historyPage(opts?: HistoryPageOptions): Promise<ThreadHistoryPage>;
  /**
   * Answer an approval this thread emitted.
   *
   * AN UNANSWERED APPROVAL BLOCKS THE TURN, with no timeout anywhere in the
   * runtime. This call and `interrupt()` are the only two ways out, and they
   * are not the same: this one answers the request and lets the turn continue,
   * while `interrupt()` aborts the turn without answering anything. A policy
   * with `approvalTimeoutMs` adds a third: the SDK declines the request itself
   * when the time runs out.
   *
   * Resolves once the runtime accepts the decision, NOT once the tool has run —
   * the same dispatch-resolution asymmetry `send()` has.
   *
   * Throws `approval_not_found` when the item is not pending: a stop, a
   * teardown, or an earlier call already settled it. The engine settles unknown
   * items silently, so without this check an answer to a dead card would look
   * like it worked.
   *
   * Use `respond()` for questions and plan approvals. This method accepts only
   * `"approval"` and `"permissions"` requests; an MCP elicitation that only
   * asks "may this tool run?" arrives as `"approval"` and is answerable here.
   *
   * `accept_always` settles this request and every later one the provider
   * considers the same, for the life of the session.
   */
  approve(itemId: string, decision: ApprovalDecision, responseText?: string): Promise<void>;
  /**
   * Every request this thread is currently blocked on.
   *
   * Call it after a reload to restore approval cards: the requests outlive the
   * client that saw the events. The `answerable` field identifies whether the
   * runtime supports a response for each request. Questions and plan approvals
   * use `respond()` when that action is available; tool approvals use
   * `approve()`.
   */
  pendingApprovals(): Promise<ApprovalRequest[]>;
  /**
   * Answer a question, structured question, or plan approval through the
   * runtime's `respondToInput` action. Question answers are keyed by question
   * id. Plan approval uses an explicit `decision` (`accept` or `decline`); the
   * SDK never infers it from option labels.
   */
  respond(requestId: string, response: ThreadRespondOptions): Promise<void>;
  /** Mutable queued sends belonging to this thread. */
  readonly queue: {
    list(): Promise<ThreadQueueItem[]>;
    cancel(id: string): Promise<void>;
    edit(id: string, text: string): Promise<void>;
    move(id: string, index: number): Promise<void>;
    dispatch(id: string): Promise<void>;
    cancelDispatched(id: string): Promise<void>;
    restore(): Promise<void>;
  };
  interrupt(options?: ThreadInterruptOptions): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  slashCommands(): Promise<AgentChatSlashCommand[]>;
  recover(options?: { turnId?: string; action?: "wait" | "nudge" | "retry_same_runtime" | "restart_resume" }): Promise<AgentChatRecoverTurnResult>;
  resolveUnprocessed(args: { steerId: string; action: "run_next" | "dismiss" }): Promise<AgentChatResolveUnprocessedMessageResult>;
  readonly usageLimit: {
    resumeNow(): Promise<AgentChatUsageLimitResult>;
    continueOnAlternate(): Promise<AgentChatUsageLimitResult>;
  };
  switchAccount(instanceId: string): Promise<AgentChatSwitchAccountResult>;
  on(event: ThreadEventChannel, cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
}

/**
 * Per-thread state the client resolved at open time and the thread reports.
 *
 * Grouped into one object rather than more positional parameters: a run of
 * same-typed optionals is how a capability ends up on the wrong field.
 *
 * The three `*Supported` flags are functions, read at every use: an
 * `autoRestart` may land on a runtime that advertises a different set, and a
 * flag captured at open would keep answering for the runtime that died.
 */
export type ThreadHostConfig = {
  /** The provider this thread runs, for attributing approval requests. */
  provider?: AdeProvider;
  instructionsCapability?: InstructionsCapability | null;
  settingSourcesCapability?: SettingSourcesCapability | null;
  permissionCapability?: PermissionCapability | null;
  /**
   * Whether the caller asked for `instructions` on this thread.
   *
   * Its own field rather than `instructionsCapability !== null`, because those
   * are two different questions and they diverge at exactly the case that
   * matters: a thread that asked and whose first provider reported nothing has
   * a null report AND a live request. Deriving "requested" from the report
   * would make that request unrecoverable — every later `setModel` would pass
   * `requested: false` and discard a report a capable provider did send.
   *
   * The client knows the answer at construction (`instructions !== undefined`),
   * so it is recorded once and never re-derived.
   */
  requestedInstructions?: boolean;
  /** Whether the caller asked for `settingSources`. See `requestedInstructions`. */
  requestedSettingSources?: boolean;
  /** Whether the caller asked for a permission policy. See `requestedInstructions`. */
  requestedPermissionPolicy?: boolean;
  /** Host-side cumulative cap; it never reaches the provider runtime. */
  budget?: ThreadBudget;
  /**
   * Whether the CURRENT runtime advertises the `pendingInputs` action. False
   * makes `pendingApprovals()` fall back to the events this client observed,
   * which cannot see requests raised before it connected.
   */
  pendingInputsSupported?: () => boolean;
  /** True only when the current runtime explicitly lists this new action. */
  actionListed?: (action: string) => boolean;
  logger?: (line: string) => void;
  /** Title at open, from the runtime's summary or the stored record. */
  title?: string | null;
  /** Model at open, already carrying its display name when the catalog knew it. */
  model?: ThreadModelSelection | null;
  /** Catalog display names by model id. Used after `setModel` / `update`. */
  displayNames?: () => Promise<ReadonlyMap<string, string>>;
  /**
   * Persists what a thread changed about itself: a title, a refreshed MCP
   * server map, the model a `setModel` moved it to. Without the model a resume
   * would restore the model the thread was CREATED with, silently undoing the
   * switch on the next app start. The client strips header values before
   * anything reaches disk.
   */
  onRecordChanged?: (patch: ThreadRecordPatch) => Promise<void>;
  /** Injects an SDK-synthesized envelope into the stream every subscriber reads. */
  emitSynthetic?: (envelope: AgentChatEventEnvelope) => void;
  /**
   * The policy's `approvalTimeoutMs`: an approval-shaped request this thread
   * watched arrive and nobody answered within it is declined by the SDK.
   */
  approvalTimeoutMs?: number;
  /** Whether the CURRENT runtime advertises `capabilities.personalChats.updateMcpServers`. */
  updateMcpServersSupported?: () => boolean;
  /** Whether the CURRENT runtime advertises `capabilities.personalChats.mcpToolFilters`. */
  mcpToolFiltersSupported?: () => boolean;
  /**
   * The thread's MCP servers as last recorded (header names, no values), for
   * re-resolving header values before a turn. From the thread store.
   */
  storedMcpServers?: () => Promise<Record<string, StoredMcpServerConfig> | undefined>;
  /** Whether the CURRENT runtime lists the `getEventHistoryPage` action. */
  historyPageSupported?: () => boolean;
  /** Whether the CURRENT runtime lists the `rerunLastTurn` action. */
  rerunLastTurnSupported?: () => boolean;
  /** The client's `mcpHeaders` callback, for servers passed without headers. */
  resolveMcpHeaders?: McpHeadersResolver;
  /**
   * The fingerprint of the MCP servers this client last sent for the thread
   * (see `mcpServersFingerprint`), shared with the client so an open-time
   * refresh and `updateMcpServers` skip the same no-op. In memory only.
   */
  mcpPushed?: { get(): string | undefined; set(fingerprint: string): void };
};

/** What a thread asks the client to write to its durable record. */
export type ThreadRecordPatch = {
  title?: string | null;
  mcpServers?: Record<string, McpServerConfig>;
  attachmentRoots?: string[];
  budget?: ThreadBudget;
  provider?: string;
  model?: string;
  modelId?: string;
};

const USAGE = new Set<string>(USAGE_EVENT_TYPES);
const STATUS = new Set<string>(STATUS_EVENT_TYPES);

/**
 * One durable conversation, bound to a runtime session id.
 *
 * Subscription is per-thread but the underlying stream is machine-wide, so each
 * listener filters on `sessionId`. That is deliberate: a single subscription
 * covers every open thread, and a client with twenty threads still holds one
 * runtime subscription rather than twenty.
 */
export class Thread implements AdeThread {
  /**
   * Written after `setModel` from the runtime's new report. A Claude thread
   * that later lands on Codex must not keep advertising `level: "enforced"`.
   */
  mcpCapability: McpCapabilityReport | null;

  /**
   * Replaced after `setModel`, exactly as `mcpCapability` is. A Claude thread
   * reports `settingSources` as `applied`; the same thread moved to OpenCode
   * must not keep saying so, because a stale non-silent answer is worse than
   * silence on a surface whose whole contract is honesty.
   */
  instructionsCapability: InstructionsCapability | null;
  settingSourcesCapability: SettingSourcesCapability | null;
  /**
   * Replaced after `setModel` for the same reason `mcpCapability` is: a policy
   * Claude enforced does not stay enforced when the thread lands on a provider
   * that cannot express it.
   */
  permissionCapability: PermissionCapability | null;

  /**
   * What the caller asked for at construction, kept apart from what the
   * provider reported. See `ThreadHostConfig.requestedInstructions`. Replaced
   * only by `adoptSession`, with the recreated thread's.
   */
  private requestedInstructions: boolean;
  private requestedSettingSources: boolean;
  private requestedPermissionPolicy: boolean;

  /** The session this thread is bound to. Replaced only by a recreate. */
  private sessionId: string;
  private currentTitle: string | null;
  private currentModel: ThreadModelSelection | null;
  /** Replaced by `adoptSession`: a recreate resolves its services afresh. */
  private hostConfig: ThreadHostConfig;
  private warnedAboutHistoryPage = false;
  private readonly usageTotals = new ThreadUsageAccumulator();
  private usageInitialization: Promise<void> | null = null;
  private usageInitializationError: Error | null = null;
  private currentTurnId: string | null = null;
  private budgetTripped = false;

  /** The provider this thread runs, kept in step with `setModel`. */
  private provider: AdeProvider;
  private readonly logger: (line: string) => void;
  /** Approvals seen on the wire, minus the ones seen settled. */
  private readonly approvals: ApprovalTracker;
  private warnedAboutDerivedApprovals = false;
  /** A header refresh in flight, shared by concurrent sends. */
  private mcpRefreshInFlight: Promise<McpCapabilityReport | null> | null = null;
  /** The last before-turn refresh problem logged, so one gap is said once, not per turn. */
  private lastMcpRefreshProblem: string | null = null;
  /** The constructor's subscription to the shared stream, released by `dispose()`. */
  private unsubscribeEvents: Unsubscribe | null = null;
  readonly queue: AdeThread["queue"];
  readonly usageLimit: AdeThread["usageLimit"];

  constructor(
    id: string,
    readonly key: string,
    mcpCapability: McpCapabilityReport | null,
    private readonly chats: PersonalChatsApi,
    private readonly events: ChatEventSource,
    private readonly assertUsable: () => void,
    hostConfig: ThreadHostConfig = {},
  ) {
    this.sessionId = id;
    this.hostConfig = hostConfig;
    this.currentTitle = hostConfig.title ?? null;
    this.currentModel = hostConfig.model ?? null;
    this.mcpCapability = mcpCapability;
    this.instructionsCapability = hostConfig.instructionsCapability ?? null;
    this.settingSourcesCapability = hostConfig.settingSourcesCapability ?? null;
    this.permissionCapability = hostConfig.permissionCapability ?? null;
    // Falls back to "a report exists" only for a caller that supplied no flag,
    // which is the older constructor shape. A client on this version always
    // passes all three.
    this.requestedInstructions =
      hostConfig.requestedInstructions ?? this.instructionsCapability !== null;
    this.requestedSettingSources =
      hostConfig.requestedSettingSources ?? this.settingSourcesCapability !== null;
    this.requestedPermissionPolicy =
      hostConfig.requestedPermissionPolicy ?? this.permissionCapability !== null;
    this.provider = hostConfig.provider ?? "claude";
    this.logger = hostConfig.logger ?? (() => {});
    this.approvals = new ApprovalTracker({
      sessionId: () => this.sessionId,
      key,
      chats,
      logger: this.logger,
      timeoutMs: () => this.hostConfig.approvalTimeoutMs,
    });
    this.queue = {
      list: async () => await this.listQueue(),
      cancel: async (id) => {
        this.assertAction("cancelSteer");
        await this.chats.cancelSteer({ sessionId: this.id, steerId: this.requireId(id, "queue id") });
      },
      edit: async (id, text) => {
        this.assertAction("editSteer");
        if (typeof text !== "string" || !text.trim()) {
          throw new AdeError("invalid_option", "queue.edit() needs non-empty text.");
        }
        await this.chats.editSteer({ sessionId: this.id, steerId: this.requireId(id, "queue id"), text });
      },
      move: async (id, index) => {
        this.assertAction("moveSteer");
        if (!Number.isInteger(index) || index < 0) {
          throw new AdeError("invalid_option", "queue.move() needs a zero-based index.");
        }
        await this.chats.moveSteer({ sessionId: this.id, steerId: this.requireId(id, "queue id"), toIndex: index });
      },
      dispatch: async (id) => {
        this.assertAction("dispatchSteer");
        await this.chats.dispatchSteer({ sessionId: this.id, steerId: this.requireId(id, "queue id"), mode: "inline" });
      },
      cancelDispatched: async (id) => {
        this.assertAction("cancelDispatchedSteer");
        await this.chats.cancelDispatchedSteer({ sessionId: this.id, steerId: this.requireId(id, "queue id") });
      },
      restore: async () => await this.restoreQueue(),
    };
    this.usageLimit = {
      resumeNow: async () => {
        this.assertAction("resumeUsageLimitNow");
        return await this.chats.resumeUsageLimitNow({ sessionId: this.id }) as AgentChatUsageLimitResult;
      },
      continueOnAlternate: async () => {
        this.assertAction("continueUsageLimitOnAlternate");
        return await this.chats.continueUsageLimitOnAlternate({ sessionId: this.id }) as AgentChatUsageLimitResult;
      },
    };
    // Subscribed from construction, not lazily on the first `pendingApprovals`
    // call: an approval raised before anyone asked is exactly the one a host
    // needs back after a reload, and a lazy subscription would have missed it.
    this.unsubscribeEvents = this.events.onEvent((envelope) => {
      if (envelope.sessionId !== this.id) return;
      const event = envelope.event;
      if (!event || typeof event.type !== "string") return;
      this.approvals.handle(event);
      this.observeUsage(envelope);
    });
  }

  /** Seed durable totals before the thread handle is returned to its caller. */
  async initializeUsage(): Promise<void> {
    if (this.usageInitializationError) {
      this.usageInitialization = null;
      this.usageInitializationError = null;
    }
    this.usageInitialization ??= this.history().then((events) => {
      this.usageTotals.seed(events);
      if (budgetExceeded(this.hostConfig.budget, this.usageSnapshot())) {
        this.budgetTripped = true;
        if (this.hostConfig.budget) {
          this.hostConfig.emitSynthetic?.({
            sessionId: this.id,
            timestamp: new Date().toISOString(),
            event: {
              type: "budget_exceeded",
              budget: this.hostConfig.budget,
              usage: this.usageSnapshot(),
              resumed: true,
            },
          });
          void this.chats.interrupt(this.id).catch((error: unknown) => {
            this.logger(`ade sdk: could not interrupt thread "${this.key}" after its budget was exceeded: ${String(error)}`);
          });
        }
      }
    }).catch((error: unknown) => {
      this.usageInitializationError = error instanceof Error ? error : new Error(String(error));
      this.logger(`ade sdk: could not load usage history for thread "${this.key}": ${this.usageInitializationError.message}`);
    });
    await this.usageInitialization;
  }

  private assertBudgetCanStartTurn(action: string): void {
    if (this.hostConfig.budget && this.usageInitializationError) {
      throw new AdeError(
        "rpc_error",
        `Cannot ${action} on thread "${this.key}" because its usage history could not be loaded; the budget cannot be enforced.`,
        { cause: this.usageInitializationError },
      );
    }
    if (this.budgetTripped) {
      throw new AdeError("invalid_option", `Thread "${this.key}" has exceeded its usage budget and cannot ${action}.`);
    }
  }

  private usageSnapshot(): ThreadUsage {
    return { ...this.usageTotals.snapshot(), complete: !this.usageInitializationError };
  }

  private observeUsage(envelope: AgentChatEventEnvelope): void {
    const event = envelope.event as Record<string, unknown>;
    const type = event.type;
    if (type === "status" && event.turnStatus === "started") {
      this.currentTurnId = typeof event.turnId === "string" ? event.turnId : null;
    }
    this.usageTotals.observe(envelope);
    const usage = this.usageSnapshot();
    if (!this.budgetTripped && budgetExceeded(this.hostConfig.budget, usage)) {
      this.budgetTripped = true;
      const turnId = typeof event.turnId === "string" ? event.turnId : this.currentTurnId;
      this.hostConfig.emitSynthetic?.({
        sessionId: this.id,
        timestamp: new Date().toISOString(),
        event: {
          type: "budget_exceeded",
          budget: this.hostConfig.budget,
          usage,
          ...(turnId ? { turnId } : {}),
        },
      });
      if (type !== "done" && type !== "status" && this.currentTurnId) {
        void this.chats.interrupt(this.id).catch((error: unknown) => {
          this.logger(`ade sdk: could not interrupt thread "${this.key}" after its budget was exceeded: ${String(error)}`);
        });
      }
    }
    if (type === "done" || (type === "status" && event.turnStatus !== "started")) this.currentTurnId = null;
  }

  /**
   * Drop this thread's subscription to the shared event stream.
   *
   * Internal: a host keeps a `Thread` for as long as it wants and never calls
   * this. `createAdeClient().dispose()` calls it for every thread it handed
   * out, because the constructor's listener and the `observedApprovals` map
   * would otherwise live as long as the client — one permanent listener per
   * distinct thread key opened, with every envelope fanned out to all of them.
   *
   * Idempotent, and safe on a thread whose stream is already gone.
   */
  dispose(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.approvals.clear();
  }

  get id(): string {
    return this.sessionId;
  }

  get title(): string | null {
    return this.currentTitle;
  }

  get model(): ThreadModelSelection | null {
    return this.currentModel;
  }

  /**
   * The runtime went away. Internal; called by the client for every live thread.
   *
   * Emits the synthetic `{ type: "status", turnStatus: "failed", message,
   * synthetic: true }` envelope, because a runtime that died mid-turn sends
   * nothing and a subscriber would otherwise show "running" forever. Every
   * pending approval died with the provider process, so the observed set and
   * its timers are dropped too.
   */
  notifyRuntimeLost(message: string): void {
    this.approvals.clear();
    this.hostConfig.emitSynthetic?.({
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      event: { type: "status", turnStatus: "failed", message, synthetic: true },
    });
  }

  /**
   * Take over another thread's session binding. Internal.
   *
   * Used when a restart finds the runtime lost this key's session and the
   * client had to recreate it: the object a host (or a bridge) already holds
   * must keep working, so the fresh thread's state moves into this one and the
   * fresh object is thrown away.
   *
   * Everything the recreate resolved moves across: the reports, the requests
   * they were derived from, and the host config (the approval timeout, the
   * runtime-capability reads, the services), so this object answers exactly as
   * the fresh one would have.
   */
  adoptSession(fresh: Thread): void {
    this.sessionId = fresh.sessionId;
    this.hostConfig = fresh.hostConfig;
    this.mcpCapability = fresh.mcpCapability;
    this.instructionsCapability = fresh.instructionsCapability;
    this.settingSourcesCapability = fresh.settingSourcesCapability;
    this.permissionCapability = fresh.permissionCapability;
    this.requestedInstructions = fresh.requestedInstructions;
    this.requestedSettingSources = fresh.requestedSettingSources;
    this.requestedPermissionPolicy = fresh.requestedPermissionPolicy;
    this.provider = fresh.provider;
    this.currentTitle = fresh.currentTitle;
    this.currentModel = fresh.currentModel;
    this.approvals.clear();
    fresh.dispose();
  }

  /** Replaces the MCP report after a refresh the client applied. Internal. */
  setMcpCapability(report: McpCapabilityReport | null): void {
    this.mcpCapability = report;
  }

  /**
   * Whether a turn is running, read from the runtime rather than inferred.
   * Throws `rpc_error` naming `action` when the runtime cannot say.
   */
  private async turnInFlight(action: string): Promise<boolean> {
    try {
      return summaryTurnActive(await this.chats.getSummary(this.id));
    } catch (error) {
      throw new AdeError(
        "rpc_error",
        `Cannot ${action} for "${this.key}": failed to read whether a turn is in flight. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
        { cause: error },
      );
    }
  }

  /**
   * The runtime's model fields, completed with the catalog's display name, by
   * the one rule the client uses too (`modelSelectionOf`). Null only when
   * neither the summary nor the fallback names a model.
   */
  private async selectionFrom(
    summary: ModelSummaryFields | null,
    fallback: { provider?: string; model: string; modelId: string },
  ): Promise<ThreadModelSelection | null> {
    let names: ReadonlyMap<string, string> = new Map();
    try {
      names = (await this.hostConfig.displayNames?.()) ?? names;
    } catch {
      // A catalog that cannot be read leaves the display name null, not the call failed.
    }
    return modelSelectionOf(summary, names, fallback);
  }

  private capabilities(): ThreadCapabilities {
    return {
      mcpCapability: this.mcpCapability,
      permissionCapability: this.permissionCapability,
      instructionsCapability: this.instructionsCapability,
      settingSourcesCapability: this.settingSourcesCapability,
    };
  }

  async send(text: string, opts: SendOptions = {}): Promise<void> {
    this.assertUsable();
    await this.initializeUsage();
    this.assertBudgetCanStartTurn("start another turn");
    if (!text.trim() && !(opts.attachments?.length)) {
      throw new AdeError("invalid_option", "send() needs text or at least one attachment.");
    }
    await this.refreshMcpHeadersBeforeTurn();
    await this.chats.send({
      sessionId: this.id,
      text,
      ...(opts.displayText !== undefined ? { displayText: opts.displayText } : {}),
      ...(opts.attachments ? { attachments: completeAttachments(opts.attachments) } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    });
  }

  async steer(text: string, opts: SteerOptions = {}): Promise<void> {
    this.assertUsable();
    await this.initializeUsage();
    this.assertBudgetCanStartTurn("accept another steer");
    const body = typeof text === "string" ? text : "";
    if (!body.trim() && !(opts.attachments?.length)) {
      throw new AdeError("invalid_option", "steer() needs text or at least one attachment.");
    }
    await this.chats.steer({
      sessionId: this.id,
      text: body,
      ...(opts.attachments?.length ? { attachments: completeAttachments(opts.attachments) } : {}),
    });
  }

  async update(patch: ThreadUpdate, opts: ThreadUpdateOptions = {}): Promise<ThreadUpdateResult> {
    this.assertUsable();
    const args: Record<string, unknown> = { sessionId: this.id };
    if (patch.title !== undefined) {
      if (patch.title !== null && typeof patch.title !== "string") {
        throw new AdeError("invalid_option", "update({ title }) takes a string or null.");
      }
      args.title = patch.title === null ? null : patch.title.trim() || null;
    }
    const reconfigures = patch.reasoningEffort !== undefined || patch.fastMode !== undefined;
    if (patch.reasoningEffort !== undefined) args.reasoningEffort = patch.reasoningEffort;
    if (patch.fastMode !== undefined) {
      if (typeof patch.fastMode !== "boolean") {
        throw new AdeError("invalid_option", "update({ fastMode }) takes a boolean.");
      }
      args.fastMode = patch.fastMode;
    }
    if (Object.keys(args).length === 1) {
      throw new AdeError("invalid_option", "update() needs at least one of title, reasoningEffort, fastMode.");
    }
    // Same rule as `setModel`, for the same reason: a provider reconfigure can
    // end a running turn with no completion event. A rename cannot, so it is
    // never refused.
    if (reconfigures && !opts.force && (await this.turnInFlight("change reasoning settings"))) {
      throw new AdeError(
        "turn_in_flight",
        `Thread "${this.key}" has a turn in flight, and changing reasoningEffort or fastMode can end it without a completion event. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
      );
    }
    const updated = await this.chats.updateSession(args);
    if (patch.title !== undefined) {
      this.currentTitle =
        typeof updated?.title === "string" ? updated.title : (args.title as string | null);
      await this.hostConfig.onRecordChanged?.({ title: this.currentTitle });
    } else if (typeof updated?.title === "string") {
      this.currentTitle = updated.title;
    }
    if (updated && (typeof updated.model === "string" || typeof updated.modelId === "string")) {
      const current = this.currentModel;
      this.currentModel =
        (await this.selectionFrom(updated, {
          ...(current?.provider ? { provider: current.provider } : {}),
          model: current?.model ?? "",
          modelId: current?.modelId ?? "",
        })) ?? current;
    }
    return { title: this.currentTitle, model: this.currentModel };
  }

  async retry(): Promise<ThreadRerunResult> {
    return await this.rerunLastTurn(undefined, {});
  }

  async editLast(text: string, opts: EditLastOptions = {}): Promise<ThreadRerunResult> {
    if (typeof text !== "string") {
      throw new AdeError("invalid_option", "editLast() takes the new message text as a string.");
    }
    if (!text.trim() && !(opts.attachments?.length)) {
      throw new AdeError("invalid_option", "editLast() needs text or at least one attachment.");
    }
    return await this.rerunLastTurn(text, opts);
  }

  private async rerunLastTurn(text: string | undefined, opts: EditLastOptions): Promise<ThreadRerunResult> {
    this.assertUsable();
    await this.initializeUsage();
    this.assertBudgetCanStartTurn("run another turn");
    const action = text === undefined ? "retry()" : "editLast()";
    if (this.provider !== "claude" && this.provider !== "codex") {
      throw new AdeError(
        "unsupported",
        `${action} is available for Claude and Codex threads; "${this.key}" runs on ${this.provider}.`,
      );
    }
    if (!this.hostConfig.rerunLastTurnSupported?.()) {
      throw new AdeError(
        "unsupported",
        `${action} needs an ADE runtime with the rerunLastTurn action (1.2.82 or later).`,
      );
    }
    // A running turn is refused by the runtime itself (code `turn_in_flight`),
    // under its own per-session lock; a pre-check here would add a round trip
    // and still race.
    await this.refreshMcpHeadersBeforeTurn();
    const result = await this.chats.rerunLastTurn({
      sessionId: this.id,
      ...(text !== undefined ? { text } : {}),
      ...(text !== undefined && opts.displayText !== undefined ? { displayText: opts.displayText } : {}),
      ...(opts.attachments ? { attachments: completeAttachments(opts.attachments) } : {}),
    });
    if (!result || typeof result.retractedFromSequence !== "number") {
      throw new AdeError("protocol_error", `The runtime answered ${action} without a result.`);
    }
    return result;
  }

  async updateMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<McpCapabilityReport | null> {
    this.assertUsable();
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new AdeError("invalid_option", "updateMcpServers() takes a map of server name to config.");
    }
    if (!this.hostConfig.updateMcpServersSupported?.()) {
      throw new AdeError(
        "invalid_option",
        "This ADE runtime cannot replace a thread's MCP servers (capabilities.personalChats.updateMcpServers is not set). " +
          "Upgrade the runtime, or open a new thread key with the new servers.",
      );
    }
    const resolved = await withResolvedHeaders(this.key, servers, this.hostConfig.resolveMcpHeaders);
    const warning = missingHeadersWarning(this.key, resolved.missing);
    if (warning) this.logger(warning);
    return await this.pushMcpServers(resolved.servers);
  }

  async refreshMcpHeaders(): Promise<McpCapabilityReport | null> {
    this.assertUsable();
    if (!this.hostConfig.resolveMcpHeaders) {
      throw new AdeError(
        "invalid_option",
        "refreshMcpHeaders() needs an mcpHeaders callback on createAdeChat. Without one, send the new headers with updateMcpServers().",
      );
    }
    if (!this.hostConfig.updateMcpServersSupported?.()) {
      throw new AdeError(
        "invalid_option",
        "This ADE runtime cannot replace a thread's MCP servers (capabilities.personalChats.updateMcpServers is not set).",
      );
    }
    return await this.refreshResolvedMcpHeaders();
  }

  /**
   * The servers this client resolved, sent unless they are the ones it last
   * sent. The one push both `updateMcpServers` and a header refresh use, so
   * the fingerprint bookkeeping cannot drift between them.
   *
   * A deferred push (mid-turn, `mcpServersPending` on the reply) still counts
   * as sent: the runtime holds those servers and installs them at the turn's
   * end, so repeating them must not queue them again. The capability report
   * is kept as it was until then, because the reply describes the servers the
   * running turn has, not the queued ones.
   */
  private async pushMcpServers(servers: Record<string, McpServerConfig>): Promise<McpCapabilityReport | null> {
    if (hasMcpToolFilters(servers) && !this.hostConfig.mcpToolFiltersSupported?.()) {
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support MCP tool filters (capabilities.personalChats.mcpToolFilters is not set), " +
          "and would drop allowedTools / disallowedTools without a word. Upgrade the runtime or drop the filters.",
      );
    }
    const fingerprint = mcpServersFingerprint(servers);
    if (this.hostConfig.mcpPushed?.get() === fingerprint) return this.mcpCapability;
    const updated = await this.chats.updateSession({ sessionId: this.id, mcpServers: servers });
    this.hostConfig.mcpPushed?.set(fingerprint);
    if (updated?.mcpServersPending !== true) {
      this.mcpCapability = normalizeMcpCapability(updated?.mcpCapability) ?? this.mcpCapability;
    }
    await this.hostConfig.onRecordChanged?.({ mcpServers: servers });
    return this.mcpCapability;
  }

  /**
   * Resolve the recorded servers' header values again and push them when they
   * changed. One at a time per thread: concurrent sends share the refresh
   * rather than asking the host for the same token twice.
   */
  private refreshResolvedMcpHeaders(): Promise<McpCapabilityReport | null> {
    if (this.mcpRefreshInFlight) return this.mcpRefreshInFlight;
    const run = (async (): Promise<McpCapabilityReport | null> => {
      const stored = await this.hostConfig.storedMcpServers?.();
      if (!stored || !storedMcpServersNeedHeaders(stored)) return this.mcpCapability;
      const resolved = await withResolvedHeaders(this.key, stored, this.hostConfig.resolveMcpHeaders);
      if (resolved.missing.length > 0) {
        throw new AdeError(
          "invalid_option",
          `The mcpHeaders callback supplied no header values for ${resolved.missing
            .map((entry) => `${entry.server} (${entry.headerNames.join(", ")})`)
            .join("; ")} on thread "${this.key}"; the session keeps the headers it has rather than lose them.`,
        );
      }
      return await this.pushMcpServers(resolved.servers);
    })();
    const shared = run.finally(() => {
      if (this.mcpRefreshInFlight === shared) this.mcpRefreshInFlight = null;
    });
    this.mcpRefreshInFlight = shared;
    return shared;
  }

  /**
   * The before-turn refresh: a no-op without a callback or remote servers,
   * and never a reason to drop the user's message. A failure is logged (once
   * per distinct problem) and the turn runs on the headers the session has.
   */
  private async refreshMcpHeadersBeforeTurn(): Promise<void> {
    if (!this.hostConfig.resolveMcpHeaders || !this.hostConfig.updateMcpServersSupported?.()) return;
    try {
      await this.refreshResolvedMcpHeaders();
      this.lastMcpRefreshProblem = null;
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      if (problem === this.lastMcpRefreshProblem) return;
      this.lastMcpRefreshProblem = problem;
      this.logger(
        `ade sdk: thread "${this.key}" could not refresh its MCP headers before the turn: ${problem}. ` +
          `The turn runs with the headers the session already has.`,
      );
    }
  }

  async interrupt(options?: ThreadInterruptOptions): Promise<void> {
    this.assertUsable();
    if (!options) {
      await this.chats.interrupt(this.id);
      return;
    }
    this.assertAction("interruptWithQueueMode");
    const mode = options.mode ?? (options.queue === "keep" ? "stop_only" : "stop_and_clear");
    await this.chats.interruptWithQueueMode({ sessionId: this.id, mode });
  }

  async setModel(
    modelId: string,
    opts: SetModelOptions = {},
  ): Promise<SetModelResult> {
    this.assertUsable();
    const trimmed = typeof modelId === "string" ? modelId.trim() : "";
    if (!trimmed) {
      throw new AdeError("invalid_option", "setModel() needs a catalog model id.");
    }

    // Mid-turn switching is refused by default. The engine permits it and the
    // desktop composer offers it, but the desktop user is watching the turn
    // stream and clicks the picker deliberately — the destruction is visible
    // and intended. An SDK caller has no such context: `send()` resolves as
    // soon as the turn is dispatched, so a `setModel` wired to a settings
    // dropdown can land mid-turn with nothing on screen to suggest it. On every
    // provider except Cursor the runtime is torn down, which kills the
    // in-flight turn WITHOUT emitting `error` or `done` — the consumer just
    // sees events stop. A silently truncated answer is the worst outcome
    // available here, so it takes an explicit `force` to choose it.
    if (!opts.force && (await this.turnInFlight("switch models"))) {
      throw new AdeError(
        "turn_in_flight",
        `Thread "${this.key}" has a turn in flight, and switching models would end it without a completion event. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
      );
    }

    const updated = await this.chats.updateSession({ sessionId: this.id, modelId: trimmed });
    // The runtime's answer wins over the requested id: it resolves aliases
    // and CLI-wrapped models, so what came back can legitimately differ. No
    // provider fallback: a switch can cross providers, and the old provider
    // would be a guess.
    const selection = (await this.selectionFrom(updated, { model: trimmed, modelId: trimmed })) ?? {
      modelId: trimmed,
      provider: "",
      model: trimmed,
      displayName: null,
    };
    // Always replace. Keeping the open-time snapshot after a cross-provider
    // switch would let a Claude `enforced` report outlive a Codex residual.
    this.mcpCapability = normalizeMcpCapability(updated?.mcpCapability);
    // Same rule for the other three reports, and for the provider an approval
    // is attributed to: a thread that landed on Codex must not keep reporting
    // Claude's verdict or Claude's name. Every one of these passes the
    // construction-time `requested*` flag rather than "do we currently hold a
    // report" — see `ThreadHostConfig.requestedInstructions` for why the two
    // are not the same question.
    this.instructionsCapability = normalizeInstructionsCapability(
      updated?.instructionsCapability,
      this.requestedInstructions,
    );
    this.settingSourcesCapability = normalizeSettingSourcesCapability(
      updated?.settingSourcesCapability,
      this.requestedSettingSources,
    );
    this.permissionCapability = normalizePermissionCapability(
      updated?.permissionCapability,
      this.requestedPermissionPolicy,
    );
    if (isSupportedProvider(selection.provider)) this.provider = selection.provider;
    this.currentModel = selection;
    await this.hostConfig.onRecordChanged?.({
      ...(selection.provider ? { provider: selection.provider } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
    });
    const capabilities = this.capabilities();
    // Announced on the stream as well as returned: a bridge, a second
    // component, or a status bar that did not make this call still has to
    // learn that the guarantee it is showing may have moved.
    this.hostConfig.emitSynthetic?.({
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      event: { type: "capabilities_changed", synthetic: true, ...capabilities },
    });
    return { ...selection, capabilities };
  }

  async pendingApprovals(): Promise<ApprovalRequest[]> {
    this.assertUsable();
    if (!this.hostConfig.pendingInputsSupported?.()) {
      // A client-side reconstruction, and it has a real hole: it can only know
      // about approvals THIS client watched arrive. One raised before the
      // process started, or before this thread was opened, is invisible here.
      // Said once rather than per call — a warning on every render pass stops
      // being read.
      if (!this.warnedAboutDerivedApprovals) {
        this.warnedAboutDerivedApprovals = true;
        this.logger(
          `ade sdk: this runtime has no pendingInputs action, so pendingApprovals() for "${this.key}" ` +
            `is derived from the events this client observed; approvals raised before it connected are not listed`,
        );
      }
      return this.approvals.values().map((observed) =>
        approvalFromObserved(observed, this.provider),
      );
    }
    const requests = await this.chats.pendingInputs(this.id);
    return requests.map((request) => {
      const mapped = approvalFromPendingInput(
        request,
        this.provider,
        this.approvals.get(request.itemId ?? request.requestId),
      );
      const answerable = isApprovalShaped(mapped.requestKind) ||
        (mapped.requestKind !== undefined && this.hostConfig.actionListed?.("respondToInput") === true);
      return { ...mapped, answerable };
    });
  }

  async respond(requestId: string, response: ThreadRespondOptions): Promise<void> {
    this.assertUsable();
    this.assertAction("respondToInput");
    const id = this.requireId(requestId, "request id");
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new AdeError("invalid_option", "respond() needs a response object.");
    }
    const responseRecord = response as Record<string, unknown>;
    const unexpectedField = Object.keys(responseRecord).find((field) => !RESPOND_FIELDS.has(field));
    if (unexpectedField) {
      throw new AdeError("invalid_option", `respond() does not accept the "${unexpectedField}" field.`);
    }
    const { answers, decision, responseText } = responseRecord;
    if (decision !== undefined && (typeof decision !== "string" || !RESPOND_DECISIONS.has(decision))) {
      throw new AdeError(
        "invalid_option",
        'respond() decision must be "accept", "accept_for_session", "decline" or "cancel".',
      );
    }
    if (answers !== undefined) {
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new AdeError("invalid_option", "respond() answers must be an object keyed by question id.");
      }
      for (const [questionId, answer] of Object.entries(answers)) {
        if (!questionId || !(typeof answer === "string" ||
          (Array.isArray(answer) && answer.every((value) => typeof value === "string")))) {
          throw new AdeError("invalid_option", "respond() answers must map question ids to strings or string arrays.");
        }
      }
    }
    if (responseText !== undefined && responseText !== null && typeof responseText !== "string") {
      throw new AdeError("invalid_option", "respond() responseText must be a string or null.");
    }
    await this.chats.respondToInput({ sessionId: this.id, itemId: id, ...response });
  }

  async stopTask(taskId: string): Promise<void> {
    this.assertUsable();
    this.assertAction("stopTask");
    await this.chats.stopTask({ sessionId: this.id, taskId: this.requireId(taskId, "task id") });
  }

  async slashCommands(): Promise<AgentChatSlashCommand[]> {
    this.assertUsable();
    this.assertAction("slashCommands");
    const commands = await this.chats.slashCommands({ sessionId: this.id, provider: this.provider });
    return Array.isArray(commands) ? commands : [];
  }

  async recover(options: { turnId?: string; action?: "wait" | "nudge" | "retry_same_runtime" | "restart_resume" } = {}): Promise<AgentChatRecoverTurnResult> {
    this.assertUsable();
    this.assertAction("recoverTurn");
    let turnId = options.turnId?.trim();
    if (!turnId) {
      const history = await this.chats.getEventHistory({ sessionId: this.id });
      for (const envelope of [...(history?.events ?? [])].reverse()) {
        const event = envelope.event;
        if (typeof event.turnId === "string" && event.turnId) {
          turnId = event.turnId;
          break;
        }
      }
    }
    if (!turnId) throw new AdeError("invalid_option", `Thread "${this.key}" has no turn id to recover.`);
    return await this.chats.recoverTurn({ sessionId: this.id, turnId, action: options.action ?? "wait" }) as AgentChatRecoverTurnResult;
  }

  async resolveUnprocessed(args: { steerId: string; action: "run_next" | "dismiss" }): Promise<AgentChatResolveUnprocessedMessageResult> {
    this.assertUsable();
    this.assertAction("resolveUnprocessedMessage");
    const steerId = this.requireId(args?.steerId, "steer id");
    if (args.action !== "run_next" && args.action !== "dismiss") {
      throw new AdeError("invalid_option", "resolveUnprocessed() action must be run_next or dismiss.");
    }
    return await this.chats.resolveUnprocessedMessage({ sessionId: this.id, steerId, action: args.action }) as AgentChatResolveUnprocessedMessageResult;
  }

  async switchAccount(instanceId: string): Promise<AgentChatSwitchAccountResult> {
    this.assertUsable();
    this.assertAction("switchAccount");
    return await this.chats.switchAccount({ sessionId: this.id, instanceId: this.requireId(instanceId, "account id") }) as AgentChatSwitchAccountResult;
  }

  private requireId(value: unknown, label: string): string {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id) throw new AdeError("invalid_option", `${label} must be a non-empty string.`);
    return id;
  }

  private assertAction(action: string): void {
    this.assertUsable();
    if (this.hostConfig.actionListed?.(action) !== true) {
      throw new AdeError("unsupported", `This ADE runtime does not advertise the ${action} action.`);
    }
  }

  private async listQueue(): Promise<ThreadQueueItem[]> {
    this.assertUsable();
    const history = await this.chats.getEventHistory({ sessionId: this.id });
    const queued = new Map<string, ThreadQueueItem>();
    const settled = new Set<string>();
    const events = history?.events ?? [];
    for (const envelope of events) {
      const event = envelope.event;
      if (event.type === "user_message" && typeof event.steerId === "string" && event.steerId) {
        if (event.deliveryState === "queued") {
          if (!settled.has(event.steerId)) queued.set(event.steerId, {
            id: event.steerId,
            text: typeof event.displayText === "string" ? event.displayText : String(event.text ?? ""),
            ...(Array.isArray(event.attachments) ? { attachments: event.attachments as AgentChatFileRef[] } : {}),
          });
        } else {
          queued.delete(event.steerId);
          // The same rule as ADE's own queue (`isSettledSteerDeliveryState`):
          // `accepted` is not final, because a Cursor or OpenCode turn can
          // refuse an inline steer and the same steerId comes back `queued`.
          if (event.deliveryState !== "accepted") settled.add(event.steerId);
        }
      } else if (event.type === "queue_reordered" && Array.isArray(event.steerIds)) {
        const reordered = new Map<string, ThreadQueueItem>();
        for (const id of event.steerIds) if (typeof id === "string" && queued.has(id)) reordered.set(id, queued.get(id)!);
        for (const [id, entry] of queued) if (!reordered.has(id)) reordered.set(id, entry);
        queued.clear();
        for (const [id, entry] of reordered) queued.set(id, entry);
      } else if (event.type === "user_message_resolution" && typeof event.steerId === "string") {
        queued.delete(event.steerId);
        settled.add(event.steerId);
      } else if (event.type === "system_notice" && typeof event.steerId === "string" && typeof event.message === "string" && /cancelled|delivering/i.test(event.message)) {
        // ADE's own queue resolves a steer on exactly these two notices.
        queued.delete(event.steerId);
        settled.add(event.steerId);
      } else if (event.type === "command_lifecycle" && typeof event.steerId === "string" && event.status !== "queued") {
        queued.delete(event.steerId);
        settled.add(event.steerId);
      } else if (event.type === "queue_recovery" && event.state === "restored" && Array.isArray(event.restoredSteers)) {
        // A restored queue comes back with its messages, after their earlier
        // cancellation settled them.
        for (const steer of event.restoredSteers as Array<{ steerId?: unknown; text?: unknown; attachments?: unknown }>) {
          if (typeof steer.steerId !== "string" || !steer.steerId) continue;
          settled.delete(steer.steerId);
          queued.set(steer.steerId, {
            id: steer.steerId,
            text: typeof steer.text === "string" ? steer.text : "",
            ...(Array.isArray(steer.attachments) ? { attachments: steer.attachments as AgentChatFileRef[] } : {}),
          });
        }
      }
    }
    return [...queued.values()];
  }

  private async restoreQueue(): Promise<void> {
    this.assertAction("restoreCancelledQueue");
    const history = await this.chats.getEventHistory({ sessionId: this.id });
    const recovery = [...(history?.events ?? [])].reverse().find(({ event }) =>
      event.type === "queue_recovery" && event.state === "available" && typeof event.recoveryId === "string",
    );
    if (!recovery || typeof recovery.event.recoveryId !== "string") {
      throw new AdeError("invalid_option", `Thread "${this.key}" has no cancelled queue to restore.`);
    }
    await this.chats.restoreCancelledQueue({ sessionId: this.id, recoveryId: recovery.event.recoveryId });
  }

  async approve(
    itemId: string,
    decision: ApprovalDecision,
    responseText?: string,
  ): Promise<void> {
    this.assertUsable();
    const trimmed = typeof itemId === "string" ? itemId.trim() : "";
    if (!trimmed) {
      throw new AdeError("invalid_option", "approve() needs the itemId from an approval_request.");
    }
    const engineDecision = engineApprovalDecision(decision);
    if (!engineDecision) {
      throw new AdeError(
        "invalid_option",
        `approve() takes "accept", "accept_always" or "reject"; got ${JSON.stringify(decision)}.`,
      );
    }
    // Checked BEFORE the call, because the engine settles an unknown item
    // silently: without this, answering a card the user already stopped, or
    // double-clicking Allow, would resolve as though it worked and the host
    // would wait forever for a turn that is not coming back.
    const pending = await this.pendingApprovals();
    const match = pending.find(
      (request) => request.itemId === trimmed || request.logicalItemId === trimmed,
    );
    if (!match) {
      throw new AdeError(
        "approval_not_found",
        `Thread "${this.key}" has no pending approval "${trimmed}". A stop, a teardown, or an ` +
          `earlier approve() already settled it.`,
      );
    }
    // The four read-only kinds want prose or a choice, not a verdict. The
    // docs on `pendingApprovals()` already say `approve()` cannot answer them;
    // this is that rule enforced rather than restated, because the engine
    // would accept the decision and the request would stay unanswered.
    if (match.requestKind !== undefined && !isApprovalShaped(match.requestKind)) {
      throw new AdeError(
        "invalid_option",
        `Thread "${this.key}" request "${match.itemId}" is a ${match.requestKind}, which approve() ` +
          `cannot answer: it wants prose or a choice, not accept/reject. Render it read-only.`,
      );
    }
    // The MATCHED request's `itemId`, never the string the caller passed. The
    // engine matches on `itemId` alone, so forwarding a `logicalItemId` —
    // which is published as the stable id a host may key its cards on — would
    // send an id the engine has never seen. It settles unknown items silently,
    // so the call would resolve while the turn stayed parked forever.
    await this.chats.approve({
      sessionId: this.id,
      itemId: match.itemId,
      decision: engineDecision,
      ...(responseText !== undefined ? { responseText } : {}),
    });
  }

  async history(opts: { limit?: number } = {}): Promise<AgentChatEventEnvelope[]> {
    this.assertUsable();
    const snapshot = await this.chats.getEventHistory({
      sessionId: this.id,
      ...(opts.limit != null ? { maxEvents: opts.limit } : {}),
    });
    return snapshot?.events ?? [];
  }

  usage(): ThreadUsage {
    return this.usageSnapshot();
  }

  async historyPage(opts: HistoryPageOptions = {}): Promise<ThreadHistoryPage> {
    this.assertUsable();
    return readHistoryPage({
      chats: this.chats,
      sessionId: this.id,
      opts,
      pageSupported: this.hostConfig.historyPageSupported?.() === true,
      onUnsupported: () => {
        if (this.warnedAboutHistoryPage) return;
        this.warnedAboutHistoryPage = true;
        this.logger(
          `ade sdk: this runtime has no getEventHistoryPage action, so historyPage() for "${this.key}" ` +
            `can only return the newest page; older pages come back empty`,
        );
      },
    });
  }

  on(
    channel: ThreadEventChannel,
    cb: (envelope: AgentChatEventEnvelope) => void,
  ): Unsubscribe {
    return this.events.onEvent((envelope) => {
      if (envelope.sessionId !== this.id) return;
      const type = envelope.event?.type;
      if (channel === "usage" && !USAGE.has(type)) return;
      if (channel === "status" && !STATUS.has(type)) return;
      cb(envelope);
    });
  }
}
