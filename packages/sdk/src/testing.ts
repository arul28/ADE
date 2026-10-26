import { AdeError } from "./errors.js";
import type { AdeChatClient } from "./client.js";
import type { ThreadOpenOptions } from "./clientOptions.js";
import type {
  AdeThread,
  EditLastOptions,
  SendOptions,
  SetModelResult,
  SteerOptions,
  ThreadEventChannel,
  ThreadModelSelection,
  ThreadRerunResult,
  ThreadUpdate,
  ThreadUpdateOptions,
  ThreadUpdateResult,
} from "./thread.js";
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  DoctorReport,
  ModelCatalogEntry,
  ProviderStatus,
  ThreadHistoryPage,
  ThreadSummary,
  Unsubscribe,
  AdeProvider,
} from "./types.js";
import { budgetExceeded, ThreadUsageAccumulator, validateThreadBudget, type ThreadBudget, type ThreadUsage } from "./usage.js";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.js";
import { runOnce, type RunOptions } from "./run.js";
import type { AccountInfo, ApiCredentialInfo } from "./accounts.js";
import type {
  AgentChatRecoverTurnResult,
  AgentChatResolveUnprocessedMessageResult,
  AgentChatSlashCommand,
  AgentChatSwitchAccountResult,
  AgentChatUsageLimitResult,
  ProviderCapabilities,
} from "./types.js";
import type { ThreadInterruptOptions, ThreadQueueItem, ThreadRespondOptions } from "./thread.js";

type MockResponse =
  | { kind: "reply"; text: string }
  | { kind: "tool_call"; tool: string; args: unknown; result: unknown }
  | { kind: "approval"; request: Partial<ApprovalRequest> }
  | { kind: "error"; message: string };

export type MockToolCall = { tool: string; args: unknown; result?: unknown };

export type MockAdeChat = AdeChatClient & {
  /** Accounts `accounts.list` returns and `switchAccount` accepts. */
  setAccounts(accounts: readonly AccountInfo[]): void;
  /** What `providers.capabilities(provider)` answers; it throws `unsupported` until set. */
  setCapabilities(provider: string, capabilities: ProviderCapabilities): void;
  /** What every mock thread's `slashCommands()` returns. */
  setSlashCommands(commands: readonly AgentChatSlashCommand[]): void;
  queueReply(text: string): void;
  queueToolCall(call: MockToolCall): void;
  queueApproval(request?: Partial<ApprovalRequest>): void;
  queueError(error: string | Error): void;
  queueUsage(event: AgentChatEvent): void;
  replay(envelopes: readonly AgentChatEventEnvelope[], key?: string): Promise<AdeThread>;
};

const USAGE = new Set(["tokens", "context_usage", "codex_token_usage"]);
const STATUS = new Set(["status", "done", "error", "turn_health", "session_meta_updated", "interrupt_receipt", "capabilities_changed", "budget_exceeded"]);
const now = () => new Date().toISOString();

/** Script assistant behavior without launching a runtime or spending provider tokens. */
export function createMockAdeChat(): MockAdeChat {
  const responses: MockResponse[] = [];
  const usageQueue: AgentChatEvent[] = [];
  const threads = new Map<string, MockThread>();
  const providerListeners = new Set<(value: Record<string, ProviderStatus>) => void>();
  const modelListeners = new Set<(value: ModelCatalogEntry[]) => void>();
  const clientListeners = new Map<string, Set<(value: unknown) => void>>();
  let nextSession = 1;
  let accounts: AccountInfo[] = [];
  let slashCommands: AgentChatSlashCommand[] = [];
  const capabilities = new Map<string, ProviderCapabilities>();
  let disposed = false;

  const assertUsable = () => {
    if (disposed) throw new AdeError("disposed", "This mock ADE chat client was disposed.");
  };
  const emitClient = (event: string, payload: unknown) => {
    for (const listener of [...(clientListeners.get(event) ?? [])]) listener(payload);
  };

  class MockThread implements AdeThread {
    readonly id = "mock-session-" + nextSession++;
    private currentTitle: string | null;
    private currentModel: ThreadModelSelection | null;
    readonly mcpCapability = null;
    readonly instructionsCapability = null;
    readonly settingSourcesCapability = null;
    readonly permissionCapability = null;
    private readonly listeners = new Map<ThreadEventChannel, Set<(envelope: AgentChatEventEnvelope) => void>>();
    private readonly envelopes: AgentChatEventEnvelope[] = [];
    private readonly pending = new Map<string, ApprovalRequest>();
    private readonly queued: ThreadQueueItem[] = [];
    private nextQueued = 1;
    private readonly usageTotals = new ThreadUsageAccumulator();
    private sequence = 0;
    private turn = 0;
    private active = false;
    private budgetStopped = false;
    private archived = false;
    private readonly budget?: ThreadBudget;
    private readonly provider: AdeProvider;

    get title(): string | null { return this.currentTitle; }
    get model(): ThreadModelSelection | null { return this.currentModel; }

    constructor(readonly key: string, options: Partial<ThreadOpenOptions> = {}) {
      this.provider = options.provider ?? "claude";
      this.currentTitle = typeof options.title === "string" ? options.title : null;
      this.currentModel = typeof options.model === "string"
        ? { modelId: options.model, displayName: options.model, provider: this.provider, model: options.model }
        : null;
      this.budget = validateThreadBudget(options.budget);
    }

    private makeEnvelope(event: AgentChatEvent): AgentChatEventEnvelope {
      return { sessionId: this.id, timestamp: now(), sequence: ++this.sequence, event };
    }

    private emit(event: AgentChatEvent, recorded?: AgentChatEventEnvelope): void {
      const envelope = recorded ?? this.makeEnvelope(event);
      this.envelopes.push(envelope);
      this.usageTotals.observe(envelope);
      for (const [channel, listeners] of this.listeners) {
        const type = envelope.event.type;
        if (channel === "usage" && !USAGE.has(type)) continue;
        if (channel === "status" && !STATUS.has(type)) continue;
        for (const listener of [...listeners]) listener(envelope);
      }
      if (!this.budgetStopped && budgetExceeded(this.budget, this.usageTotals.snapshot())) {
        this.budgetStopped = true;
        this.emit({
          type: "budget_exceeded",
          budget: this.budget,
          usage: { ...this.usageTotals.snapshot(), complete: true },
          turnId: "mock-turn-" + this.turn,
        });
        this.finish("interrupted");
      }
    }

    private finish(status: "completed" | "interrupted" | "failed"): void {
      if (!this.active) return;
      this.active = false;
      this.emit({ type: "status", turnStatus: status, turnId: "mock-turn-" + this.turn });
      this.emit({ type: "done", status, turnId: "mock-turn-" + this.turn });
    }

    private async dispatch(text: string, _options: SendOptions | SteerOptions = {}): Promise<void> {
      assertUsable();
      if (this.budgetStopped) throw new AdeError("invalid_option", "The mock thread exceeded its usage budget.");
      this.turn += 1;
      this.active = true;
      this.emit({ type: "user_message", text, turnId: "mock-turn-" + this.turn });
      this.emit({ type: "status", turnStatus: "started", turnId: "mock-turn-" + this.turn });
      for (const event of usageQueue.splice(0)) {
        this.emit({ ...event, turnId: (event as { turnId?: string }).turnId ?? "mock-turn-" + this.turn });
        if (this.budgetStopped) return;
      }
      const response = responses.shift() ?? { kind: "reply" as const, text: "Mock reply" };
      switch (response.kind) {
        case "reply":
          this.emit({ type: "text", text: response.text, turnId: "mock-turn-" + this.turn });
          this.finish("completed");
          return;
        case "tool_call": {
          const itemId = "mock-tool-" + this.turn;
          this.emit({ type: "tool_call", tool: response.tool, args: response.args, itemId, turnId: "mock-turn-" + this.turn });
          this.emit({ type: "tool_result", tool: response.tool, result: response.result, itemId, status: "completed", turnId: "mock-turn-" + this.turn });
          this.finish("completed");
          return;
        }
        case "approval": {
          const itemId = response.request.itemId ?? "mock-approval-" + this.turn;
          const request: ApprovalRequest = {
            ...response.request,
            itemId,
            kind: response.request.kind ?? "command",
            description: response.request.description ?? "Mock approval request",
            provider: response.request.provider ?? this.provider,
          };
          this.pending.set(itemId, request);
          this.emit({ type: "approval_request", itemId, kind: request.kind, description: request.description, requestKind: request.requestKind, turnId: "mock-turn-" + this.turn });
          return;
        }
        case "error":
          this.emit({ type: "error", message: response.message, turnId: "mock-turn-" + this.turn });
          this.finish("failed");
      }
    }

    async send(text: string, options?: SendOptions): Promise<void> { await this.dispatch(text, options); }
    async steer(text: string, options?: SteerOptions): Promise<void> {
      // A turn parked on an approval is still running: like the runtime, a
      // steer then waits in the queue instead of starting a second turn.
      if (this.active) {
        this.queued.push({ id: "mock-steer-" + this.nextQueued++, text, ...(options?.attachments ? { attachments: options.attachments } : {}) });
        return;
      }
      await this.dispatch(text, options);
    }
    async interrupt(options?: ThreadInterruptOptions): Promise<void> {
      if (options?.queue === "drop") this.queued.length = 0;
      this.finish("interrupted");
    }
    async respond(requestId: string, response: ThreadRespondOptions): Promise<void> {
      if (!this.pending.has(requestId)) throw new AdeError("approval_not_found", "No pending mock request " + requestId + ".");
      this.pending.delete(requestId);
      const declined = response.decision === "decline" || response.decision === "cancel";
      this.emit({ type: "pending_input_resolved", itemId: requestId, resolution: declined ? "declined" : "accepted", turnId: "mock-turn-" + this.turn });
      this.finish("completed");
    }
    private queuedIndex(id: string): number {
      const index = this.queued.findIndex((item) => item.id === id);
      if (index < 0) throw new AdeError("invalid_option", "No queued mock message " + id + ".");
      return index;
    }
    readonly queue = {
      list: async (): Promise<ThreadQueueItem[]> => this.queued.map((item) => ({ ...item })),
      cancel: async (id: string): Promise<void> => { this.queued.splice(this.queuedIndex(id), 1); },
      edit: async (id: string, text: string): Promise<void> => { this.queued[this.queuedIndex(id)]!.text = text; },
      move: async (id: string, index: number): Promise<void> => {
        const [item] = this.queued.splice(this.queuedIndex(id), 1);
        this.queued.splice(Math.max(0, Math.min(index, this.queued.length)), 0, item!);
      },
      dispatch: async (id: string): Promise<void> => {
        const [item] = this.queued.splice(this.queuedIndex(id), 1);
        this.finish("interrupted");
        await this.dispatch(item!.text);
      },
      cancelDispatched: async (_id: string): Promise<void> => {},
      restore: async (): Promise<void> => {},
    };
    async stopTask(_taskId: string): Promise<void> {}
    async slashCommands(): Promise<AgentChatSlashCommand[]> { return slashCommands.map((command) => ({ ...command })); }
    async recover(options: { turnId?: string; action?: AgentChatRecoverTurnResult["action"] } = {}): Promise<AgentChatRecoverTurnResult> {
      return { action: options.action ?? "wait", turnId: options.turnId ?? "mock-turn-" + this.turn, status: "waiting" };
    }
    async resolveUnprocessed(args: { steerId: string; action: "run_next" | "dismiss" }): Promise<AgentChatResolveUnprocessedMessageResult> {
      return { steerId: args.steerId, action: args.action, status: "completed" };
    }
    readonly usageLimit = {
      resumeNow: async (): Promise<AgentChatUsageLimitResult> => ({ ok: true, turnId: null }),
      continueOnAlternate: async (): Promise<AgentChatUsageLimitResult> => ({ ok: false, reason: "no_alternate", message: "The mock client has no alternate account." }),
    };
    async switchAccount(instanceId: string): Promise<AgentChatSwitchAccountResult> {
      if (!accounts.some((account) => account.id === instanceId)) {
        return { ok: false, reason: "signed_out", message: "No mock account " + instanceId + "." };
      }
      return { ok: true, instanceId };
    }
    async update(patch: ThreadUpdate, _options?: ThreadUpdateOptions): Promise<ThreadUpdateResult> {
      if (Object.hasOwn(patch, "title")) this.currentTitle = patch.title ?? null;
      return { title: this.currentTitle, model: this.currentModel };
    }
    async updateMcpServers(_servers: Record<string, unknown>): Promise<null> { return null; }
    async refreshMcpHeaders(): Promise<null> { return null; }
    async setModel(modelId: string): Promise<SetModelResult> {
      this.currentModel = { modelId, provider: this.provider, model: modelId, displayName: modelId };
      return {
        ...this.currentModel,
        capabilities: {
          mcpCapability: null,
          permissionCapability: null,
          instructionsCapability: null,
          settingSourcesCapability: null,
        },
      };
    }
    async retry(): Promise<ThreadRerunResult> {
      await this.dispatch("Mock retry");
      return { retractedFromSequence: this.sequence, historyGeneration: 1, conversationRollback: "not_delivered" };
    }
    async editLast(text: string, _options?: EditLastOptions): Promise<ThreadRerunResult> {
      await this.dispatch(text);
      return { retractedFromSequence: this.sequence, historyGeneration: 1, conversationRollback: "not_delivered" };
    }
    async history(options: { limit?: number } = {}): Promise<AgentChatEventEnvelope[]> {
      return options.limit ? this.envelopes.slice(-options.limit) : [...this.envelopes];
    }
    async historyPage(options: { beforeSequence?: number; limit?: number } = {}): Promise<ThreadHistoryPage> {
      const before = options.beforeSequence ?? Number.POSITIVE_INFINITY;
      const older = this.envelopes.filter((envelope) => (envelope.sequence ?? 0) < before);
      const limit = options.limit ?? 100;
      const events = older.slice(-limit);
      return { events, hasMore: older.length > events.length, nextBeforeSequence: events[0]?.sequence ?? null };
    }
    async approve(itemId: string, _decision: ApprovalDecision): Promise<void> {
      if (!this.pending.has(itemId)) throw new AdeError("approval_not_found", "No pending mock approval " + itemId + ".");
      this.pending.delete(itemId);
      this.emit({ type: "pending_input_resolved", itemId, resolution: "accepted", turnId: "mock-turn-" + this.turn });
      this.finish("completed");
    }
    async pendingApprovals(): Promise<ApprovalRequest[]> { return [...this.pending.values()]; }
    on(channel: ThreadEventChannel, listener: (envelope: AgentChatEventEnvelope) => void): Unsubscribe {
      let listeners = this.listeners.get(channel);
      if (!listeners) this.listeners.set(channel, listeners = new Set());
      listeners.add(listener);
      return () => listeners?.delete(listener);
    }
    usage(): ThreadUsage { return { ...this.usageTotals.snapshot(), complete: true }; }
    seed(envelopes: readonly AgentChatEventEnvelope[]): void {
      for (const envelope of envelopes) {
        this.envelopes.push(envelope);
        this.usageTotals.observe(envelope);
        for (const listeners of this.listeners.values()) for (const listener of [...listeners]) listener(envelope);
      }
      if (budgetExceeded(this.budget, this.usageTotals.snapshot())) this.budgetStopped = true;
    }
    setArchived(archived: boolean): void { this.archived = archived; }
    get summary(): ThreadSummary {
      const timestamp = this.envelopes.at(-1)?.timestamp ?? now();
      return {
        key: this.key,
        sessionId: this.id,
        provider: this.currentModel?.provider ?? this.provider,
        model: this.currentModel?.modelId ?? "mock-model",
        title: this.title,
        status: this.active ? "active" : "idle",
        startedAt: this.envelopes[0]?.timestamp ?? timestamp,
        lastActivityAt: timestamp,
        updatedAt: timestamp,
        archived: this.archived,
        modelSelection: this.currentModel,
      };
    }
  }

  const unsupported = (what: string) => async (): Promise<never> => {
    throw new AdeError("unsupported", "The mock client does not " + what + ".");
  };
  const client: MockAdeChat = {
    providers: {
      status: async () => ({}),
      refresh: async () => ({}),
      onChange: (listener) => { providerListeners.add(listener); return () => providerListeners.delete(listener); },
      capabilities: async (provider: string): Promise<ProviderCapabilities> => {
        const value = capabilities.get(provider);
        if (!value) throw new AdeError("unsupported", "No mock capability record for provider " + provider + "; set one with setCapabilities().");
        return value;
      },
    },
    accounts: {
      list: async (provider?: string) => accounts.filter((account) => !provider || account.provider === provider).map((account) => ({ ...account })),
      add: unsupported("add accounts; seed them with setAccounts()"),
      remove: unsupported("remove accounts"),
      rename: unsupported("rename accounts"),
      setDefault: unsupported("change the default account"),
      signOut: unsupported("sign accounts out"),
      refresh: async () => accounts.map((account) => ({ ...account })),
      signIn: unsupported("run provider sign-ins"),
    },
    credentials: {
      list: async (): Promise<ApiCredentialInfo[]> => [],
      add: unsupported("store credentials"),
      remove: unsupported("remove credentials"),
      verify: unsupported("verify credentials"),
    },
    presets: {
      list: async () => [],
      add: unsupported("add presets"),
      update: unsupported("update presets"),
      remove: unsupported("remove presets"),
    },
    models: {
      list: async () => [],
      onChange: (listener) => { modelListeners.add(listener); return () => modelListeners.delete(listener); },
      defaultModel: async () => null,
    },
    threads: {
      open: async (key: string, options: Partial<ThreadOpenOptions> = {}) => {
        assertUsable();
        const existing = threads.get(key);
        if (existing) return existing;
        const thread = new MockThread(key, options);
        threads.set(key, thread);
        return thread;
      },
      list: async () => [...threads.values()].map((thread) => thread.summary),
      get: async (key) => threads.get(key)?.summary ?? null,
      delete: async (key) => {
        if (!threads.delete(key)) throw new AdeError("thread_not_found", "No mock thread is registered under " + key + ".");
        emitClient("threadLifecycle", { key, change: "deleted" });
      },
      archive: async (key) => {
        const thread = threads.get(key);
        if (!thread) throw new AdeError("thread_not_found", "No mock thread is registered under " + key + ".");
        thread.setArchived(true);
        emitClient("threadLifecycle", { key, change: "archived" });
      },
      unarchive: async (key) => {
        const thread = threads.get(key);
        if (!thread) throw new AdeError("thread_not_found", "No mock thread is registered under " + key + ".");
        thread.setArchived(false);
        emitClient("threadLifecycle", { key, change: "unarchived" });
      },
    },
    on: (event, listener) => {
      const key = String(event);
      let listeners = clientListeners.get(key);
      if (!listeners) clientListeners.set(key, listeners = new Set());
      const callback = listener as (value: unknown) => void;
      listeners.add(callback);
      return () => listeners?.delete(callback);
    },
    doctor: async () => ({ ok: true } as DoctorReport),
    exportThread: async (key) => (await threads.get(key)?.history() ?? []).map((event) => JSON.stringify(event)).join("\n"),
    dispose: async () => { disposed = true; threads.clear(); providerListeners.clear(); modelListeners.clear(); },
    run: <T = unknown>(prompt: string, options: RunOptions) => runOnce<T>({
      threads: {
        open: (key, openOptions) => client.threads.open(key, openOptions),
        delete: (key) => client.threads.delete(key),
      },
    }, prompt, options),
    setAccounts: (next) => { accounts = next.map((account) => ({ ...account })); },
    setCapabilities: (provider, value) => { capabilities.set(provider, value); },
    setSlashCommands: (next) => { slashCommands = next.map((command) => ({ ...command })); },
    queueReply: (text) => { responses.push({ kind: "reply", text }); },
    queueToolCall: (call) => { responses.push({ kind: "tool_call", tool: call.tool, args: call.args, result: call.result ?? null }); },
    queueApproval: (request = {}) => { responses.push({ kind: "approval", request }); },
    queueError: (error) => { responses.push({ kind: "error", message: error instanceof Error ? error.message : error }); },
    queueUsage: (event) => { usageQueue.push(event); },
    replay: async (envelopes, key = "replay") => {
      const thread = await client.threads.open(key, { provider: "claude", model: "mock-model" });
      threads.get(key)!.seed(envelopes);
      return thread;
    },
  };
  return client;
}
