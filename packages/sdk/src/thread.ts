import { AdeError } from "./errors.js";
import type { ChatEventStream } from "./eventStream.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import type { PersonalChatsApi } from "./personalChats.js";
import {
  STATUS_EVENT_TYPES,
  USAGE_EVENT_TYPES,
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
   * Switch this thread's model, mid-conversation.
   *
   * Takes a catalog model id (`models.list()[].id`), not a provider-native
   * name. Crossing providers is supported and is the interesting case: the
   * engine tears down the old provider thread and replays the transcript into
   * the new one, so the conversation continues rather than restarting. Staying
   * within a provider is cheaper — Claude and Codex retarget the live session
   * in place.
   *
   * Resolves to what the thread actually became. The engine resolves the id
   * through its own catalog, so the provider you get back is authoritative;
   * do not assume it from the id you passed.
   *
   * Changing the model during an active turn is accepted but disruptive: every
   * provider except Cursor tears the runtime down immediately, which ends the
   * in-flight turn. Call `interrupt()` first, or gate the UI on thread status,
   * if that matters to you.
   */
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
  on(event: ThreadEventChannel, cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
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
  ) {
    this.mcpCapability = mcpCapability;
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
    await this.onModelChanged(selection);
    return selection;
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
