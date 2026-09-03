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
import { AdeError } from "./errors.js";
import type { ChatEventStream } from "./eventStream.js";
import {
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSourcesCapability,
  type InstructionsCapability,
  type PermissionCapability,
  type SettingSourcesCapability,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
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
  type Unsubscribe,
} from "./types.js";

export type ThreadEventChannel = "event" | "usage" | "status";

export type SetModelOptions = {
  /**
   * Switch even with a turn in flight, accepting that the turn ends with no
   * completion event. Only meaningful mid-turn; ignored on an idle thread.
   */
  force?: boolean;
};

/** What a thread's model actually resolved to, as reported by the runtime. */
export type ThreadModelSelection = {
  /** Catalog model id now bound to the thread. */
  modelId: string;
  /** Provider group that id resolved into — authoritative, not inferred. */
  provider: string;
  /** Provider-native model token. */
  model: string;
};

export type SendOptions = {
  attachments?: AgentChatFileRef[];
  /** Text shown to the user when it differs from what the agent receives. */
  displayText?: string;
  reasoningEffort?: string | null;
};

export interface AdeThread {
  readonly id: string;
  readonly key: string;
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
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
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
   * and CLI-wrapped ids, so it can differ from what you passed.
   */
  setModel(modelId: string, opts?: SetModelOptions): Promise<ThreadModelSelection>;
  history(opts?: { limit?: number }): Promise<AgentChatEventEnvelope[]>;
  /**
   * Answer an approval this thread emitted.
   *
   * AN UNANSWERED APPROVAL BLOCKS THE TURN, with no timeout anywhere in the
   * runtime. This call and `interrupt()` are the only two ways out, and they
   * are not the same: this one answers the request and lets the turn continue,
   * while `interrupt()` aborts the turn without answering anything.
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
   * by `pendingApprovals()` and are meant to be rendered read-only.
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
   * provider reported. See `ThreadHostConfig.requestedInstructions`.
   */
  private readonly requestedInstructions: boolean;
  private readonly requestedSettingSources: boolean;
  private readonly requestedPermissionPolicy: boolean;

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
    readonly id: string,
    readonly key: string,
    mcpCapability: McpCapabilityReport | null,
    private readonly chats: PersonalChatsApi,
    private readonly events: ChatEventStream,
    private readonly assertUsable: () => void,
    /**
     * Persists the thread's new provider/model after a switch. Without this a
     * resume would restore the model the thread was CREATED with, silently
     * undoing the switch on the next app start.
     */
    private readonly onModelChanged: (selection: ThreadModelSelection) => Promise<void> = async () => {},
    hostConfig: ThreadHostConfig = {},
  ) {
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
        return;
      }
      if (event.type === "pending_input_resolved" && typeof event.itemId === "string") {
        this.observedApprovals.delete(event.itemId);
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
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    });
  }

  async steer(text: string): Promise<void> {
    this.assertUsable();
    if (!text.trim()) {
      throw new AdeError("invalid_option", "steer() needs text.");
    }
    await this.chats.steer({ sessionId: this.id, text });
  }

  async interrupt(): Promise<void> {
    this.assertUsable();
    await this.chats.interrupt(this.id);
  }

  async setModel(
    modelId: string,
    opts: SetModelOptions = {},
  ): Promise<ThreadModelSelection> {
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
    if (!opts.force) {
      let summary: AgentChatSessionSummary | null;
      try {
        summary = await this.chats.getSummary(this.id);
      } catch (error) {
        throw new AdeError(
          "rpc_error",
          `Cannot switch models for "${this.key}": failed to read whether a turn is in flight. ` +
            `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
          { cause: error },
        );
      }
      const turnActive =
        summary?.status === "active" || typeof summary?.currentTurnStartedAt === "string";
      if (turnActive) {
        throw new AdeError(
          "invalid_option",
          `Thread "${this.key}" has a turn in flight, and switching models would end it without a completion event. ` +
            `Await the turn, call interrupt() first, or pass { force: true } to accept losing it.`,
        );
      }
    }

    const updated = (await this.chats.updateSession({
      sessionId: this.id,
      modelId: trimmed,
    })) as AgentChatSessionSummary | null;
    const record = (updated ?? {}) as { provider?: unknown; model?: unknown; modelId?: unknown };
    const selection: ThreadModelSelection = {
      // The runtime's answer wins over the requested id: it resolves aliases
      // and CLI-wrapped models, so what came back can legitimately differ.
      modelId: typeof record.modelId === "string" && record.modelId ? record.modelId : trimmed,
      provider: typeof record.provider === "string" ? record.provider : "",
      model: typeof record.model === "string" ? record.model : trimmed,
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
    await this.onModelChanged(selection);
    return selection;
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
