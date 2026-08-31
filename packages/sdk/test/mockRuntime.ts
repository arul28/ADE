import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentChatEventEnvelope, BufferedEvent } from "../src/types.js";

/**
 * An in-test ADE runtime: a real `net.Server` on a real temp socket speaking
 * the real newline-delimited JSON-RPC protocol. Tests exercise the SDK's actual
 * transport rather than a stubbed request function, which is the only way the
 * framing, handshake and subscription bookkeeping get covered.
 */

export type MockRuntimeOptions = {
  /** Advertised `capabilities.personalChats.pushEvents`. */
  pushEvents?: boolean;
  mcpServers?: boolean;
  runtimeVersion?: string;
  /** Fail `personalChats.subscribeEvents` to force the drain fallback. */
  rejectSubscribe?: boolean;
  eventEpoch?: string;
  /** Buffer capacity; exceeding it evicts and produces a gap. */
  capacity?: number;
};

type Session = {
  sessionId: string;
  provider: string;
  model: string;
  modelId?: string;
  title: string | null;
  status: "active" | "idle" | "ended";
  startedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
  createArgs: Record<string, unknown>;
  mcpCapability: Record<string, unknown> | null;
};

export class MockRuntime {
  readonly socketPath: string;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly sessions = new Map<string, Session>();

  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly options: Required<Omit<MockRuntimeOptions, "runtimeVersion">> & {
    runtimeVersion: string;
  };
  private readonly buffer: BufferedEvent[] = [];
  private readonly subscriptions = new Map<string, net.Socket>();
  private nextEventId = 1;
  private nextSubscriptionId = 1;
  private oldestRetainedId = 1;
  private transcripts = new Map<string, AgentChatEventEnvelope[]>();

  /** Set to make `modelCatalog` answer with a specific catalog. */
  catalog: unknown;
  /** Set to make `modelCatalog` fail, so error recording can be observed. */
  failCatalog = false;
  /** Reproduces a runtime that accepts MCP but omits the capability report. */
  suppressMcpCapability = false;
  /** Reproduces the pre-fix runtime: strict-only requests marked undelivered. */
  strictOnlyReportsUndelivered = false;
  /** Forces `level: "unsupported"` so the genuine drop warning can be tested. */
  forceUnsupportedCapability = false;
  /** Reproduces a runtime that predates `strictRequested` and omits the field. */
  omitStrictRequested = false;
  /** Next `getSummary` throws this message, then clears. Empty means behave normally. */
  failNextGetSummary = "";

  constructor(options: MockRuntimeOptions = {}) {
    this.options = {
      pushEvents: options.pushEvents ?? true,
      mcpServers: options.mcpServers ?? true,
      rejectSubscribe: options.rejectSubscribe ?? false,
      eventEpoch: options.eventEpoch ?? randomUUID(),
      capacity: options.capacity ?? 1000,
      runtimeVersion: options.runtimeVersion ?? "1.2.69",
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-mock-"));
    this.socketPath = path.join(dir, "ade.sock");
    this.catalog = defaultCatalog();
  }

  async start(): Promise<void> {
    await fs.promises.rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
        for (const [id, owner] of [...this.subscriptions]) {
          if (owner === socket) this.subscriptions.delete(id);
        }
      });
      socket.on("error", () => {});
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let index = pending.indexOf("\n");
        while (index >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (line) void this.handleLine(socket, line);
          index = pending.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    await fs.promises.rm(path.dirname(this.socketPath), { recursive: true, force: true });
  }

  /** Publishes a chat event through the buffer and any live push subscription. */
  emitChatEvent(sessionId: string, event: Record<string, unknown>): BufferedEvent {
    const envelope: AgentChatEventEnvelope = {
      sessionId,
      timestamp: new Date().toISOString(),
      event: event as AgentChatEventEnvelope["event"],
    };
    const transcript = this.transcripts.get(sessionId) ?? [];
    transcript.push(envelope);
    this.transcripts.set(sessionId, transcript);

    const buffered: BufferedEvent = {
      id: this.nextEventId++,
      timestamp: envelope.timestamp,
      category: "runtime",
      payload: envelope as unknown as Record<string, unknown>,
    };
    this.buffer.push(buffered);
    while (this.buffer.length > this.options.capacity) {
      const evicted = this.buffer.shift();
      if (evicted) this.oldestRetainedId = evicted.id + 1;
    }
    for (const [subscriptionId, socket] of this.subscriptions) {
      this.write(socket, {
        jsonrpc: "2.0",
        method: "runtime/event",
        params: {
          subscriptionId,
          projectId: null,
          scope: "personal",
          event: buffered,
          eventEpoch: this.options.eventEpoch,
        },
      });
    }
    return buffered;
  }

  /** Drops retained events without notifying, so the next drain reports a gap. */
  evictAll(): void {
    const last = this.buffer[this.buffer.length - 1];
    this.buffer.length = 0;
    this.oldestRetainedId = (last?.id ?? 0) + 1;
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let message: { id?: number | string | null; method?: string; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.method !== "string") return;
    this.calls.push({ method: message.method, params: message.params });
    if (message.id == null) return;
    try {
      const result = await this.dispatch(socket, message.method, message.params);
      this.write(socket, { jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write(socket, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: (error as Error).message },
      });
    }
  }

  private async dispatch(
    socket: net.Socket,
    method: string,
    rawParams: unknown,
  ): Promise<unknown> {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case "ade/initialize":
        return {
          runtimeInfo: { version: this.options.runtimeVersion, pid: 4242 },
          capabilities: {
            personalChats: {
              version: 1,
              actions: ["list", "create", "getSummary", "send", "steer", "interrupt", "getEventHistory", "modelCatalog"],
              pushEvents: this.options.pushEvents,
              mcpServers: this.options.mcpServers,
            },
          },
        };
      case "ade/initialized":
        return null;
      case "personalChats.subscribeEvents": {
        if (this.options.rejectSubscribe) throw new Error("Method not found");
        const subscriptionId = `runtime-events-${this.nextSubscriptionId++}`;
        this.subscriptions.set(subscriptionId, socket);
        return {
          subscriptionId,
          events: [],
          nextCursor: this.nextEventId - 1,
          hasMore: false,
          eventEpoch: this.options.eventEpoch,
          gap: false,
          oldestCursor: null,
        };
      }
      case "personalChats.unsubscribeEvents": {
        const id = String(params.subscriptionId ?? "");
        return { removed: this.subscriptions.delete(id) };
      }
      case "personalChats.streamEvents":
        return this.drain(Number(params.cursor ?? 0), Number(params.limit ?? 100));
      case "personalChats.call":
        return {
          action: params.action,
          result: this.chatAction(
            String(params.action ?? ""),
            (params.args ?? {}) as Record<string, unknown>,
          ),
        };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private drain(cursor: number, limit: number): unknown {
    const oldest = this.buffer[0]?.id ?? null;
    const gap = oldest == null ? cursor < this.nextEventId - 1 : cursor < oldest - 1;
    const start = this.buffer.findIndex((entry) => entry.id > cursor);
    const slice = start === -1 ? [] : this.buffer.slice(start, start + limit);
    return {
      events: slice,
      nextCursor: slice.length > 0 ? slice[slice.length - 1]!.id : gap ? this.nextEventId - 1 : cursor,
      hasMore: start !== -1 && start + limit < this.buffer.length,
      eventEpoch: this.options.eventEpoch,
      gap,
      oldestCursor: gap ? (oldest ?? this.oldestRetainedId) : null,
    };
  }

  private chatAction(action: string, args: Record<string, unknown>): unknown {
    switch (action) {
      case "create": {
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const session: Session = {
          sessionId,
          provider: String(args.provider ?? ""),
          model: String(args.model ?? ""),
          title: (args.title as string) ?? null,
          status: "idle",
          startedAt: now,
          lastActivityAt: now,
          archivedAt: null,
          createArgs: args,
          mcpCapability: this.suppressMcpCapability ? null : this.capabilityReport(args),
        };
        this.sessions.set(sessionId, session);
        return toSummary(session);
      }
      case "getSummary": {
        if (this.failNextGetSummary) {
          const message = this.failNextGetSummary;
          this.failNextGetSummary = "";
          throw new Error(message);
        }
        const session = this.sessions.get(String(args.sessionId ?? ""));
        if (!session) throw new Error("Personal chat session not found.");
        return toSummary(session);
      }
      case "list":
        return [...this.sessions.values()].map(toSummary);
      case "send":
      case "steer": {
        const sessionId = String(args.sessionId ?? "");
        if (!this.sessions.has(sessionId)) throw new Error("Personal chat session not found.");
        this.emitChatEvent(sessionId, { type: "user_message", text: String(args.text ?? "") });
        return { ok: true };
      }
      case "interrupt":
        return { mode: "stop_and_clear", cancelledQueuedCount: 0 };
      case "getEventHistory": {
        const sessionId = String(args.sessionId ?? "");
        const events = this.transcripts.get(sessionId) ?? [];
        const maxEvents = typeof args.maxEvents === "number" ? args.maxEvents : events.length;
        return { events: events.slice(-maxEvents), truncated: events.length > maxEvents };
      }
      case "updateSession": {
        const session = this.sessions.get(String(args.sessionId ?? ""));
        if (!session) throw new Error("Personal chat session not found.");
        if (args.modelId !== undefined) {
          const requested = String(args.modelId ?? "").trim();
          if (!requested) throw new Error("A modelId is required when updating a chat session model.");
          const resolved = resolveCatalogModel(this.catalog, requested);
          if (!resolved) throw new Error(`Unknown model '${requested}'.`);
          // Mirrors the engine: the catalog resolves the id to its provider
          // GROUP and the provider-native token, so a cross-provider switch
          // rewrites all three fields rather than just the id.
          session.provider = resolved.provider;
          session.model = resolved.model;
          session.modelId = resolved.modelId;
          session.mcpCapability = this.suppressMcpCapability
            ? null
            : this.capabilityReport({ ...session.createArgs, provider: session.provider });
        }
        if (typeof args.title === "string") session.title = args.title;
        return toSummary(session);
      }
      case "modelCatalog":
        if (this.failCatalog) throw new Error("model catalog unavailable");
        return this.catalog;
      default:
        throw new Error(`Unsupported personal chat action: ${action}.`);
    }
  }

  /**
   * Applies the mock's failure-mode switches on top of the real verdicts.
   *
   * Sequential, not a chain of early returns: the switches are independent
   * runtime defects and a test is entitled to turn on more than one. The
   * `strictRequested` omission is applied LAST because it emulates a runtime
   * that predates the field entirely — it must survive whatever the switches
   * above decided, and an earlier `return` used to hide it behind them.
   */
  private capabilityReport(args: Record<string, unknown>): Record<string, unknown> | null {
    const report = capabilityFor(args);
    if (!report) return null;
    let mutated: Record<string, unknown> = report;
    if (this.forceUnsupportedCapability) {
      mutated = { ...mutated, level: "unsupported", mechanism: "none", delivered: false };
    }
    // The pre-fix engine computed `delivered` as "servers were supplied AND the
    // provider supports MCP", so a strict-only request came back undelivered
    // even when strict mode was enforced perfectly.
    if (this.strictOnlyReportsUndelivered && !args.mcpServers) {
      mutated = { ...mutated, delivered: false };
    }
    if (this.omitStrictRequested) {
      const { strictRequested: _omitted, ...rest } = mutated;
      mutated = rest;
    }
    return mutated;
  }

  private write(socket: net.Socket, payload: unknown): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  }
}

/**
 * Mirrors the runtime's real per-provider verdicts: Claude enforces strict
 * mode, the others are best-effort with a named residual, and Pi has no MCP
 * surface (injected servers are refused outright before a session row exists).
 *
 * Source of truth: `CALLER_MCP_SUPPORT` in
 * `apps/desktop/src/shared/callerMcpServers.ts`. This is a fixture, not a
 * second table — it pins only the two rows the SDK tests assert on (claude,
 * pi) and treats every other provider as the best-effort default. If a
 * provider's `level` changes there, change it here too.
 *
 * `level` is the PROVIDER'S capability and does not depend on what this call
 * asked for — a delivery-only Codex thread is still "best-effort", because that
 * is all Codex could do if strict mode were requested. Only `strictRequested`,
 * `mechanism` and `residual` vary with the request. Getting that wrong here
 * (reporting delivery-only Codex as "enforced") would make the mock agree with
 * a client bug instead of catching it.
 */
const PROVIDER_MCP_VERDICTS: Record<
  string,
  { level: string; strictMechanism: string; residual: string | null }
> = {
  claude: { level: "enforced", strictMechanism: "strictMcpConfig", residual: null },
  pi: { level: "unsupported", strictMechanism: "none", residual: null },
};

const DEFAULT_MCP_VERDICT = {
  level: "best-effort",
  strictMechanism: "overlay",
  residual: "a plugin-contributed server cannot be enumerated and survives",
};

function capabilityFor(args: Record<string, unknown>): Record<string, unknown> | null {
  // The runtime's own gate: servers were injected, OR strictness was explicitly
  // requested. `strictMcpConfig: false` alone asks for neither, so no report is
  // produced — a mock that answered `strictMcpConfig !== undefined` here would
  // hide a client that warns on every correct delivery-only thread.
  const strictRequested = args.strictMcpConfig === true;
  const asked = Boolean(args.mcpServers) || strictRequested;
  if (!asked) return null;
  const provider = String(args.provider ?? "");
  if (provider === "pi" && args.mcpServers) {
    throw new Error(
      "Provider 'pi' cannot accept injected MCP servers: none — the Pi SDK exposes no MCP configuration.",
    );
  }
  // `hasOwnProperty`, not a bare index: a provider named "constructor" or
  // "toString" would otherwise resolve to an `Object.prototype` function and be
  // destructured as a verdict. Same guard the real table uses in
  // `apps/desktop/src/shared/callerMcpServers.ts`.
  const verdict = Object.prototype.hasOwnProperty.call(PROVIDER_MCP_VERDICTS, provider)
    ? PROVIDER_MCP_VERDICTS[provider]!
    : { ...DEFAULT_MCP_VERDICT, strictMechanism: `${provider} overlay` };
  return {
    level: verdict.level,
    mechanism: strictRequested ? verdict.strictMechanism : `${provider} delivery`,
    // A residual names what strict mode could not exclude. Nothing was asked to
    // be excluded on a delivery-only thread, so there is nothing to name.
    residual: strictRequested ? verdict.residual : null,
    delivered: provider !== "pi",
    strictRequested,
  };
}

function toSummary(session: Session): Record<string, unknown> {
  return {
    ...(session.mcpCapability ? { mcpCapability: session.mcpCapability } : {}),
    sessionId: session.sessionId,
    laneId: "personal",
    provider: session.provider,
    model: session.model,
    ...(session.modelId ? { modelId: session.modelId } : {}),
    title: session.title,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: null,
    archivedAt: session.archivedAt,
    lastActivityAt: session.lastActivityAt,
    lastOutputPreview: null,
    summary: null,
  };
}

/**
 * Resolves a catalog model id the way the engine does: an id maps to a provider
 * GROUP (`groupKey`) plus the provider-native token, which is why a cross-
 * provider switch cannot be inferred from the id string alone.
 */
function resolveCatalogModel(
  catalog: unknown,
  modelId: string,
): { provider: string; model: string; modelId: string } | null {
  const groups = (catalog as { groups?: unknown[] } | null)?.groups;
  if (!Array.isArray(groups)) return null;
  for (const group of groups as Array<Record<string, unknown>>) {
    for (const provider of (group.providers as Array<Record<string, unknown>>) ?? []) {
      for (const subsection of (provider.subsections as Array<Record<string, unknown>>) ?? []) {
        for (const model of (subsection.models as Array<Record<string, unknown>>) ?? []) {
          if (model.id !== modelId) continue;
          return {
            provider: String(group.key ?? model.provider ?? ""),
            model: String(model.runtimeModelId ?? model.id),
            modelId: String(model.id),
          };
        }
      }
    }
  }
  return null;
}

export function defaultCatalog(): unknown {
  return {
    fetchedAt: new Date().toISOString(),
    stale: false,
    groups: [
      {
        key: "claude",
        displayName: "Claude",
        providers: [
          {
            key: "anthropic",
            displayName: "Anthropic",
            badgeColor: "#d97757",
            modelCount: 2,
            subsections: [
              {
                key: "default",
                label: "Models",
                models: [
                  {
                    id: "claude-sonnet-4-5",
                    displayName: "Claude Sonnet 4.5",
                    runtimeModelId: "claude-sonnet-4-5-20250929",
                    provider: "claude",
                    providerKey: "anthropic",
                    groupKey: "claude",
                    isDefault: true,
                    isAvailable: true,
                    connected: true,
                    reasoningEfforts: [{ effort: "high", description: "" }],
                    defaultReasoningEffort: "high",
                  },
                  {
                    id: "claude-opus-4-1",
                    displayName: "Claude Opus 4.1",
                    runtimeModelId: "claude-opus-4-1",
                    provider: "claude",
                    providerKey: "anthropic",
                    groupKey: "claude",
                    isDefault: false,
                    isAvailable: true,
                    connected: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        key: "codex",
        displayName: "Codex",
        providers: [
          {
            key: "openai",
            displayName: "OpenAI",
            badgeColor: "#10a37f",
            modelCount: 1,
            subsections: [
              {
                key: "default",
                label: "Models",
                models: [
                  {
                    id: "gpt-5-codex",
                    displayName: "GPT-5 Codex",
                    runtimeModelId: "gpt-5-codex",
                    provider: "codex",
                    providerKey: "openai",
                    groupKey: "codex",
                    isDefault: true,
                    isAvailable: true,
                    connected: false,
                    requiresConfiguration: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
