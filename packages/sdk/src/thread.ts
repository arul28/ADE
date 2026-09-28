import {
  approvalFromObserved,
  approvalFromPendingInput,
  engineApprovalDecision,
  isApprovalShaped,
  observedApprovalFromEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ObservedApproval,
} from "./approvals.js";
import { completeAttachments } from "./attachments.js";
import { AdeError, errorMessage } from "./errors.js";
import type { ChatEventSource } from "./eventStream.js";
import {
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSourcesCapability,
  type InstructionsCapability,
  type PermissionCapability,
  type SettingSourcesCapability,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import { missingHeadersWarning, withResolvedHeaders, type McpHeadersResolver } from "./mcpHeaders.js";
import { isSupportedProvider } from "./permissions.js";
import type { PersonalChatsApi } from "./personalChats.js";
import {
  STATUS_EVENT_TYPES,
  USAGE_EVENT_TYPES,
  type AdeProvider,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type AgentChatSessionSummary,
  type McpCapabilityReport,
  type McpServerConfig,
  type ThreadCapabilities,
  type ThreadHistoryPage,
  type ThreadModelSelection,
  type Unsubscribe,
} from "./types.js";

export type { ThreadModelSelection } from "./types.js";

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
  /** New title. `null` clears it. Persisted in the thread store as well. */
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

/** Options for `historyPage`. */
export type HistoryPageOptions = {
  /**
   * Return events strictly older than this `sequence`. Omit for the newest
   * page. Pass the previous page's `nextBeforeSequence` to walk backwards.
   */
  beforeSequence?: number;
  /**
   * At most this many events. The runtime pages by bytes, so a page can hold
   * fewer; when it holds more, the SDK keeps the newest `limit` and moves the
   * cursor so nothing is skipped. Defaults to 200.
   */
  limit?: number;
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
   * `fastMode` are refused while a turn is in flight unless `{ force: true }`:
   * on Codex a settings change the provider rejects tears the provider down,
   * which ends the turn without `error` or `done` — the silent truncation the
   * client's destructive-while-streaming rule forbids. Await the turn or
   * `interrupt()` first.
   *
   * Resolves with the title and model as the runtime reports them afterwards.
   */
  update(patch: ThreadUpdate, opts?: ThreadUpdateOptions): Promise<ThreadUpdateResult>;
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
   * Refused by the runtime while a turn is in flight (`invalid_option`), and by
   * the SDK on a runtime that does not advertise
   * `capabilities.personalChats.updateMcpServers` (`invalid_option`) — an older
   * runtime would ignore the field and leave the old credentials in place,
   * which is worse than failing.
   *
   * Resolves with the thread's new `mcpCapability`.
   */
  updateMcpServers(servers: Record<string, McpServerConfig>): Promise<McpCapabilityReport | null>;
  /**
   * Switch this thread's model, including across providers — the runtime tears
   * the old one down and replays the transcript into the new one.
   *
   * Refused while a turn is in flight unless `{ force: true }`: the switch would
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
   * Throws `invalid_option` for a request whose `requestKind` is one of the
   * four that want prose or a choice rather than a verdict. Those are listed
   * by `pendingApprovals()` and are meant to be rendered read-only. The kind
   * is the runtime's own answer: an MCP elicitation that only asks "may this
   * tool run?" arrives as `"approval"` and is answerable here.
   *
   * `accept_always` settles this request and every later one the provider
   * considers the same, for the life of the session.
   */
  approve(itemId: string, decision: ApprovalDecision, responseText?: string): Promise<void>;
  /**
   * Every request this thread is currently blocked on.
   *
   * Call it after a reload to restore approval cards: the requests outlive the
   * client that saw the events. Requests whose `requestKind` is not
   * `"approval"` or `"permissions"` are included and cannot be answered with
   * `approve()` — render those read-only.
   */
  pendingApprovals(): Promise<ApprovalRequest[]>;
  on(event: ThreadEventChannel, cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
}

/**
 * Per-thread state the client resolved at open time and the thread reports.
 *
 * Grouped into one object rather than four more positional parameters: the
 * constructor already takes seven, and a run of same-typed optionals is how a
 * capability ends up on the wrong field.
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
  /**
   * Whether the runtime advertises the `pendingInputs` action. False makes
   * `pendingApprovals()` fall back to the events this client observed, which
   * cannot see requests raised before it connected.
   */
  pendingInputsSupported?: boolean;
  logger?: (line: string) => void;
  /** Title at open, from the runtime's summary or the stored record. */
  title?: string | null;
  /** Model at open, already carrying its display name when the catalog knew it. */
  model?: ThreadModelSelection | null;
  /** Catalog display name for a model id, or null. Used after `setModel` / `update`. */
  displayNameFor?: (modelId: string) => Promise<string | null>;
  /**
   * Persists what a thread changed about itself: a title, a refreshed MCP
   * server map. The client strips header values before anything reaches disk.
   */
  onRecordChanged?: (patch: {
    title?: string | null;
    mcpServers?: Record<string, McpServerConfig>;
  }) => Promise<void>;
  /** Injects an SDK-synthesized envelope into the stream every subscriber reads. */
  emitSynthetic?: (envelope: AgentChatEventEnvelope) => void;
  /**
   * The policy's `approvalTimeoutMs`: an approval-shaped request this thread
   * watched arrive and nobody answered within it is declined by the SDK.
   */
  approvalTimeoutMs?: number;
  /** Whether the runtime advertises `capabilities.personalChats.updateMcpServers`. */
  updateMcpServersSupported?: boolean;
  /** Whether the runtime lists the `getEventHistoryPage` action. */
  historyPageSupported?: boolean;
  /** The client's `mcpHeaders` callback, for servers passed without headers. */
  resolveMcpHeaders?: McpHeadersResolver;
};

/** The runtime refused an argument; say so as `invalid_option`, not `rpc_error`. */
function translateInvalidArgument(error: unknown): unknown {
  if (error instanceof AdeError && error.code === "rpc_error" && /invalid_argument:/.test(error.message)) {
    return new AdeError("invalid_option", error.message, { cause: error });
  }
  return error;
}

const DEFAULT_HISTORY_PAGE_LIMIT = 200;

/** The lowest `sequence` in a page, or null when none of its envelopes carry one. */
function lowestSequence(events: readonly AgentChatEventEnvelope[]): number | null {
  let lowest: number | null = null;
  for (const envelope of events) {
    if (typeof envelope.sequence !== "number") continue;
    if (lowest === null || envelope.sequence < lowest) lowest = envelope.sequence;
  }
  return lowest;
}

/** Keep the newest `limit` events of a page and report the cursor before them. */
function trimPage(
  events: AgentChatEventEnvelope[],
  limit: number,
  runtimeHasMore: boolean,
): ThreadHistoryPage {
  const trimmed = events.length > limit;
  const kept = trimmed ? events.slice(-limit) : events;
  const cursor = lowestSequence(kept);
  // An un-numbered page cannot be continued by sequence, so it must not claim
  // more: a "load older" affordance gated on `hasMore` would spin forever.
  const hasMore = (trimmed || runtimeHasMore) && cursor !== null && cursor > 1;
  return { events: kept, hasMore, nextBeforeSequence: hasMore ? cursor : null };
}

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
   * provider reported. See `ThreadHostConfig.requestedInstructions`.
   */
  private readonly requestedInstructions: boolean;
  private readonly requestedSettingSources: boolean;
  private readonly requestedPermissionPolicy: boolean;

  /** The session this thread is bound to. Replaced only by a recreate. */
  private sessionId: string;
  private currentTitle: string | null;
  private currentModel: ThreadModelSelection | null;
  private readonly hostConfig: ThreadHostConfig;
  /** Approval timers by item id, for a policy with `approvalTimeoutMs`. */
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private warnedAboutHistoryPage = false;

  /** The provider this thread runs, kept in step with `setModel`. */
  private provider: AdeProvider;
  private readonly pendingInputsSupported: boolean;
  private readonly logger: (line: string) => void;
  /**
   * Approvals seen on the wire, minus the ones seen resolved.
   *
   * Two jobs. It is the ONLY source of pending approvals against a runtime with
   * no `pendingInputs` action, and it enriches the RPC's answer everywhere
   * else: `PendingInputRequest` has no command/file/tool discriminant, and the
   * event does, so a request the client watched arrive keeps the engine's own
   * `kind` instead of an inference from the payload.
   */
  private readonly observedApprovals = new Map<string, ObservedApproval>();
  private warnedAboutDerivedApprovals = false;
  /** The constructor's subscription to the shared stream, released by `dispose()`. */
  private unsubscribeEvents: Unsubscribe | null = null;

  constructor(
    id: string,
    readonly key: string,
    mcpCapability: McpCapabilityReport | null,
    private readonly chats: PersonalChatsApi,
    private readonly events: ChatEventSource,
    private readonly assertUsable: () => void,
    /**
     * Persists the thread's new provider/model after a switch. Without this a
     * resume would restore the model the thread was CREATED with, silently
     * undoing the switch on the next app start.
     */
    private readonly onModelChanged: (selection: ThreadModelSelection) => Promise<void> = async () => {},
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
    this.pendingInputsSupported = hostConfig.pendingInputsSupported ?? false;
    this.logger = hostConfig.logger ?? (() => {});
    // Subscribed from construction, not lazily on the first `pendingApprovals`
    // call: an approval raised before anyone asked is exactly the one a host
    // needs back after a reload, and a lazy subscription would have missed it.
    this.unsubscribeEvents = this.events.onEvent((envelope) => {
      if (envelope.sessionId !== this.id) return;
      const event = envelope.event;
      if (!event || typeof event.type !== "string") return;
      const observed = observedApprovalFromEvent(event);
      if (observed) {
        this.observedApprovals.set(observed.itemId, observed);
        this.armApprovalTimeout(observed);
        return;
      }
      if (event.type === "pending_input_resolved" && typeof event.itemId === "string") {
        this.observedApprovals.delete(event.itemId);
        this.clearApprovalTimer(event.itemId);
        return;
      }
      // A turn ending settles every approval that turn was blocked on, and the
      // engine's Claude teardown resolves those waiters WITHOUT emitting a
      // `pending_input_resolved` receipt for each. Without this, the derived
      // set keeps listing cards the runtime has already answered: every one of
      // them passes the pre-check in `approve()`, which then forwards an id the
      // engine no longer knows and settles nothing. The map also grew for the
      // life of the client, one entry per approval that ever died in a
      // teardown.
      //
      // `done` ONLY. An `error` is not turn-ending in the engine: an OpenCode
      // per-tool failure emits one and keeps streaming the same turn, and the
      // Codex planning-approval guard emits one to decline a single request.
      // Treating those as endings drops a LIVE approval out of the derived
      // set, and `approve()` then throws `approval_not_found` for a request the
      // runtime is still blocked on — leaving `interrupt()` as the only exit,
      // which is the failure the pre-check exists to prevent. Every teardown
      // and interrupt path emits `done`, so `done` alone still closes the leak.
      if (event.type === "done") {
        const turnId = typeof event.turnId === "string" && event.turnId ? event.turnId : null;
        for (const [itemId, approval] of this.observedApprovals) {
          // An ending that names no turn drops everything: there is nothing
          // left running that could still be waiting on one. An approval that
          // carries no turn of its own is dropped by any ending, for the same
          // reason.
          if (turnId === null || approval.turnId === undefined || approval.turnId === turnId) {
            this.observedApprovals.delete(itemId);
            this.clearApprovalTimer(itemId);
          }
        }
      }
    });
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
    this.observedApprovals.clear();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
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
   * Emits the synthetic `status` / `turnStatus: "error"` envelope, because a
   * runtime that died mid-turn sends nothing and a subscriber would otherwise
   * show "running" forever. Every pending approval died with the provider
   * process, so the observed set and its timers are dropped too.
   */
  notifyRuntimeLost(message: string): void {
    this.observedApprovals.clear();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.hostConfig.emitSynthetic?.({
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      event: { type: "status", turnStatus: "error", message, synthetic: true },
    });
  }

  /**
   * Take over another thread's session binding. Internal.
   *
   * Used when a restart finds the runtime lost this key's session and the
   * client had to recreate it: the object a host (or a bridge) already holds
   * must keep working, so the fresh thread's state moves into this one and the
   * fresh object is thrown away.
   */
  adoptSession(fresh: Thread): void {
    this.sessionId = fresh.sessionId;
    this.mcpCapability = fresh.mcpCapability;
    this.instructionsCapability = fresh.instructionsCapability;
    this.settingSourcesCapability = fresh.settingSourcesCapability;
    this.permissionCapability = fresh.permissionCapability;
    this.provider = fresh.provider;
    this.currentTitle = fresh.currentTitle;
    this.currentModel = fresh.currentModel;
    this.observedApprovals.clear();
    fresh.dispose();
  }

  /** Replaces the MCP report after a refresh the client applied. Internal. */
  setMcpCapability(report: McpCapabilityReport | null): void {
    this.mcpCapability = report;
  }

  private clearApprovalTimer(itemId: string): void {
    const timer = this.approvalTimers.get(itemId);
    if (!timer) return;
    clearTimeout(timer);
    this.approvalTimers.delete(itemId);
  }

  /**
   * Starts the SDK-side decline clock for one approval, when the policy has one.
   *
   * Approval-shaped requests only. A question wants an answer a decline cannot
   * give, so it is left to the host. The clock is per item, starts when THIS
   * client saw the request, and is cleared by any settlement it sees — an
   * answer, a `pending_input_resolved`, or the turn's `done`.
   */
  private armApprovalTimeout(observed: ObservedApproval): void {
    const timeoutMs = this.hostConfig.approvalTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;
    if (observed.requestKind !== undefined && !isApprovalShaped(observed.requestKind)) return;
    this.clearApprovalTimer(observed.itemId);
    const timer = setTimeout(() => {
      this.approvalTimers.delete(observed.itemId);
      if (!this.observedApprovals.has(observed.itemId)) return;
      this.logger(
        `ade sdk: thread "${this.key}" approval "${observed.itemId}" was unanswered for ${timeoutMs}ms; declining it (approvalTimeoutMs)`,
      );
      void this.chats
        .approve({
          sessionId: this.id,
          itemId: observed.itemId,
          decision: "decline",
          responseText: `Declined automatically after ${timeoutMs}ms with no answer.`,
        })
        .then(() => {
          this.observedApprovals.delete(observed.itemId);
        })
        .catch((error: unknown) => {
          this.logger(
            `ade sdk: thread "${this.key}" could not decline timed-out approval "${observed.itemId}": ${errorMessage(error)}`,
          );
        });
    }, timeoutMs);
    timer.unref?.();
    this.approvalTimers.set(observed.itemId, timer);
  }

  /**
   * Whether a turn is running, read from the runtime rather than inferred.
   * Throws `rpc_error` naming `action` when the runtime cannot say.
   */
  private async turnInFlight(action: string): Promise<boolean> {
    let summary: AgentChatSessionSummary | null;
    try {
      summary = await this.chats.getSummary(this.id);
    } catch (error) {
      throw new AdeError(
        "rpc_error",
        `Cannot ${action} for "${this.key}": failed to read whether a turn is in flight. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
        { cause: error },
      );
    }
    return summary?.status === "active" || typeof summary?.currentTurnStartedAt === "string";
  }

  /** The runtime's model fields, completed with the catalog's display name. */
  private async selectionFrom(
    summary: { provider?: unknown; model?: unknown; modelId?: unknown } | null,
    fallbackModelId: string,
  ): Promise<ThreadModelSelection> {
    const record = summary ?? {};
    const modelId =
      typeof record.modelId === "string" && record.modelId ? record.modelId : fallbackModelId;
    let displayName: string | null = null;
    try {
      displayName = (await this.hostConfig.displayNameFor?.(modelId)) ?? null;
    } catch {
      displayName = null;
    }
    return {
      modelId,
      provider: typeof record.provider === "string" ? record.provider : "",
      model: typeof record.model === "string" ? record.model : fallbackModelId,
      displayName,
    };
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
    if (!text.trim() && !(opts.attachments?.length)) {
      throw new AdeError("invalid_option", "send() needs text or at least one attachment.");
    }
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
        "invalid_option",
        `Thread "${this.key}" has a turn in flight, and changing reasoningEffort or fastMode can end it without a completion event. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
      );
    }
    let updated: AgentChatSessionSummary | null;
    try {
      updated = (await this.chats.updateSession(args)) as AgentChatSessionSummary | null;
    } catch (error) {
      throw translateInvalidArgument(error);
    }
    if (patch.title !== undefined) {
      this.currentTitle =
        typeof updated?.title === "string" ? updated.title : (args.title as string | null);
      await this.hostConfig.onRecordChanged?.({ title: this.currentTitle });
    } else if (typeof updated?.title === "string") {
      this.currentTitle = updated.title;
    }
    if (updated && (typeof updated.model === "string" || typeof updated.modelId === "string")) {
      this.currentModel = await this.selectionFrom(updated, this.currentModel?.modelId ?? String(updated.model ?? ""));
    }
    return { title: this.currentTitle, model: this.currentModel };
  }

  async updateMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<McpCapabilityReport | null> {
    this.assertUsable();
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new AdeError("invalid_option", "updateMcpServers() takes a map of server name to config.");
    }
    if (!this.hostConfig.updateMcpServersSupported) {
      throw new AdeError(
        "invalid_option",
        "This ADE runtime cannot replace a thread's MCP servers (capabilities.personalChats.updateMcpServers is not set). " +
          "Upgrade the runtime, or open a new thread key with the new servers.",
      );
    }
    const resolved = withResolvedHeaders(this.key, servers, this.hostConfig.resolveMcpHeaders);
    const warning = missingHeadersWarning(this.key, resolved.missing);
    if (warning) this.logger(warning);
    let updated: AgentChatSessionSummary | null;
    try {
      updated = (await this.chats.updateSession({
        sessionId: this.id,
        mcpServers: resolved.servers,
      })) as AgentChatSessionSummary | null;
    } catch (error) {
      throw translateInvalidArgument(error);
    }
    this.mcpCapability = normalizeMcpCapability(updated?.mcpCapability) ?? this.mcpCapability;
    await this.hostConfig.onRecordChanged?.({ mcpServers: resolved.servers });
    return this.mcpCapability;
  }

  async interrupt(): Promise<void> {
    this.assertUsable();
    await this.chats.interrupt(this.id);
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
        "invalid_option",
        `Thread "${this.key}" has a turn in flight, and switching models would end it without a completion event. ` +
          `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
      );
    }

    const updated = (await this.chats.updateSession({
      sessionId: this.id,
      modelId: trimmed,
    })) as AgentChatSessionSummary | null;
    // The runtime's answer wins over the requested id: it resolves aliases
    // and CLI-wrapped models, so what came back can legitimately differ.
    const selection = await this.selectionFrom(updated, trimmed);
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
    await this.onModelChanged(selection);
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
    if (!this.pendingInputsSupported) {
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
      return [...this.observedApprovals.values()].map((observed) =>
        approvalFromObserved(observed, this.provider),
      );
    }
    const requests = await this.chats.pendingInputs(this.id);
    return requests.map((request) =>
      approvalFromPendingInput(
        request,
        this.provider,
        this.observedApprovals.get(request.itemId ?? request.requestId),
      ),
    );
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

  async historyPage(opts: HistoryPageOptions = {}): Promise<ThreadHistoryPage> {
    this.assertUsable();
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.floor(opts.limit)
        : DEFAULT_HISTORY_PAGE_LIMIT;
    const before = opts.beforeSequence;
    if (before === undefined || before === null) {
      // The newest page comes from the tail read every runtime has. Asking for
      // one more than the limit is how "is there anything older?" is answered
      // on a runtime that does not report `hasOlderHistory`.
      const snapshot = await this.chats.getEventHistory({ sessionId: this.id, maxEvents: limit + 1 });
      const events = snapshot?.events ?? [];
      const runtimeHasMore = snapshot?.hasOlderHistory === true || snapshot?.truncated === true;
      return trimPage(events, limit, runtimeHasMore);
    }
    if (typeof before !== "number" || !Number.isInteger(before) || before < 0) {
      throw new AdeError("invalid_option", "historyPage({ beforeSequence }) takes a non-negative integer.");
    }
    if (!this.hostConfig.historyPageSupported) {
      if (!this.warnedAboutHistoryPage) {
        this.warnedAboutHistoryPage = true;
        this.logger(
          `ade sdk: this runtime has no getEventHistoryPage action, so historyPage() for "${this.key}" ` +
            `can only return the newest page; older pages come back empty`,
        );
      }
      return { events: [], hasMore: false, nextBeforeSequence: null };
    }
    const page = await this.chats.getEventHistoryPage({ sessionId: this.id, beforeSequence: before });
    // The byte-bounded read can overlap the cursor by an envelope; drop
    // anything at or past it so a caller walking back never sees a repeat.
    const events = (page?.events ?? []).filter(
      (envelope) => typeof envelope.sequence !== "number" || envelope.sequence < before,
    );
    return trimPage(events, limit, page?.hasMore === true);
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
