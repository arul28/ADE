import { errorMessage } from "./errors.js";
import type { JsonRpcConnection } from "./jsonRpc.js";
import type {
  AgentChatEventEnvelope,
  BufferedEvent,
  PersonalChatStreamEventsResult,
  PersonalChatSubscribeEventsResult,
  RuntimeEventNotification,
  Unsubscribe,
} from "./types.js";

/**
 * Machine-scoped chat event stream.
 *
 * Two transports, auto-selected:
 *   - push: `personalChats.subscribeEvents` + `runtime/event` notifications.
 *     Used when the runtime advertises `capabilities.personalChats.pushEvents`.
 *   - drain: `personalChats.streamEvents` {cursor, limit} polling. Works
 *     against older runtimes and against a runtime built before unit 1 lands,
 *     which is why it is not merely a degraded mode but a supported one.
 *
 * Both share the same gap contract as `apps/ade-cli/src/eventBuffer.ts`: a
 * result with `gap: true` means the ring buffer evicted events the caller had
 * not read, and an `eventEpoch` change means the buffer was recreated (the
 * runtime restarted). Either way the in-memory tail is not recoverable from the
 * buffer, so subscribers are told to refetch history from the durable
 * transcript instead of silently receiving a hole.
 */

export type ChatEventListener = (envelope: AgentChatEventEnvelope) => void;

export type EventStreamOptions = {
  connection: JsonRpcConnection;
  pushSupported: boolean;
  logger: (line: string) => void;
  /** Poll interval for the drain transport. */
  pollIntervalMs?: number;
  onError?: (scope: string, error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_DRAIN_LIMIT = 200;

export class ChatEventStream {
  private readonly listeners = new Set<ChatEventListener>();
  private readonly connection: JsonRpcConnection;
  private readonly logger: (line: string) => void;
  private readonly pollIntervalMs: number;
  private readonly drainLimit: number;
  private readonly onError: (scope: string, error: unknown) => void;

  private mode: "push" | "drain" | "unavailable";
  private started = false;
  private disposed = false;
  private cursor = 0;
  private epoch: string | null = null;
  private gapsRecovered = 0;
  private subscriptionId: string | null = null;
  private stopNotification: Unsubscribe | null = null;
  private stopCloseWatch: Unsubscribe | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(options: EventStreamOptions) {
    this.connection = options.connection;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.drainLimit = DEFAULT_DRAIN_LIMIT;
    this.onError = options.onError ?? (() => {});
    this.mode = options.pushSupported ? "push" : "drain";
  }

  get transport(): "push" | "drain" | "unavailable" {
    return this.mode;
  }

  get currentEpoch(): string | null {
    return this.epoch;
  }

  get recoveredGapCount(): number {
    return this.gapsRecovered;
  }

  onEvent(listener: ChatEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Idempotent. Falls back to the drain transport if subscribe is missing. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.mode === "push") {
      try {
        await this.startPush();
        return;
      } catch (error) {
        this.logger(
          `ade sdk: push events unavailable (${errorMessage(error)}); falling back to polling`,
        );
        this.mode = "drain";
      }
    }
    this.startDrain();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.stopNotification?.();
    this.stopNotification = null;
    this.stopCloseWatch?.();
    this.stopCloseWatch = null;
    const subscriptionId = this.subscriptionId;
    this.subscriptionId = null;
    this.listeners.clear();
    if (subscriptionId && !this.connection.isClosed) {
      await this.connection
        .request("personalChats.unsubscribeEvents", { subscriptionId })
        .catch(() => {});
    }
  }

  private async startPush(): Promise<void> {
    // Buffer notifications that land between the subscribe returning on the
    // wire and the subscriptionId reaching this closure — the runtime can emit
    // replay events before the response is parsed.
    const pending: RuntimeEventNotification[] = [];
    this.stopNotification = this.connection.onNotification("runtime/event", (params) => {
      const payload = params as RuntimeEventNotification;
      if (!this.subscriptionId) {
        pending.push(payload);
        return;
      }
      this.consumeNotification(payload);
    });

    // `category: "runtime"` is the chat-envelope channel. It deliberately
    // excludes the `pty` category, so personal-chat TERMINAL output does not
    // arrive here — the SDK exposes no terminal surface, and filtering at the
    // runtime is cheaper than shipping bytes we would drop. Anything that adds
    // terminals needs a second subscription or an unfiltered one.
    //
    // `replay: false` still returns the buffer's latest `nextCursor`, so the
    // reconnect anchor below is valid even though no history is replayed.
    const result = await this.connection.request<PersonalChatSubscribeEventsResult>(
      "personalChats.subscribeEvents",
      { category: "runtime", cursor: 0, limit: this.drainLimit, replay: false },
      { timeoutMs: 30_000 },
    );
    if (this.disposed) {
      this.stopNotification?.();
      this.stopNotification = null;
      await this.connection
        .request("personalChats.unsubscribeEvents", {
          subscriptionId: result.subscriptionId,
        })
        .catch(() => {});
      return;
    }
    this.subscriptionId = result.subscriptionId;
    // Push mode has no poll loop to notice a dead socket, so without this the
    // stream stayed "push" forever and doctor() kept reporting ok on a
    // connection that had already dropped.
    this.stopCloseWatch = this.connection.onClose(() => {
      if (this.disposed) return;
      this.mode = "unavailable";
      this.subscriptionId = null;
      this.logger("ade sdk: chat event stream lost its connection");
    });
    this.applyBufferMetadata(result);
    for (const payload of pending.splice(0)) this.consumeNotification(payload);
    this.logger(`ade sdk: chat events streaming (push, subscription ${result.subscriptionId})`);
  }

  private consumeNotification(payload: RuntimeEventNotification): void {
    // The project-scoped subscribe shares the runtime's subscription-id counter
    // and the same notification method, so the id is the authoritative filter.
    // `scope` is only a readability aid.
    if (payload.subscriptionId !== this.subscriptionId) return;
    if (payload.scope != null && payload.scope !== "personal") return;
    const event = payload.event;
    if (!isBufferedEvent(event)) return;
    this.noteEpoch(payload.eventEpoch ?? null);
    if (event.id > this.cursor) this.cursor = event.id;
    this.emit(event);
  }

  private startDrain(): void {
    this.logger("ade sdk: chat events streaming (drain fallback)");
    this.scheduleDrain(0);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.drainOnce();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private async drainOnce(): Promise<void> {
    if (this.disposed || this.polling) return;
    if (this.connection.isClosed) {
      this.mode = "unavailable";
      return;
    }
    this.polling = true;
    try {
      const result = await this.connection.request<PersonalChatStreamEventsResult>(
        "personalChats.streamEvents",
        { cursor: this.cursor, limit: this.drainLimit },
        { timeoutMs: 30_000 },
      );
      this.applyBufferMetadata(result);
      for (const event of result.events ?? []) {
        if (event.id > this.cursor) this.cursor = event.id;
        this.emit(event);
      }
      // `hasMore` means the buffer still holds events past this page; keep
      // draining immediately rather than waiting out a poll interval, or a
      // burst of output arrives at one page per tick.
      this.scheduleDrain(result.hasMore ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.onError("events.drain", error);
      this.scheduleDrain(this.pollIntervalMs * 4);
    } finally {
      this.polling = false;
    }
  }

  private applyBufferMetadata(result: PersonalChatStreamEventsResult): void {
    this.noteEpoch(result.eventEpoch ?? null);
    if (typeof result.nextCursor === "number" && result.nextCursor > this.cursor) {
      this.cursor = result.nextCursor;
    }
    if (result.gap === true) {
      // The buffer dropped events this client never saw. Skip past the hole so
      // the cursor cannot chase evicted ids forever, and tell subscribers to
      // refetch history — the durable transcript still has what was lost.
      if (typeof result.oldestCursor === "number" && result.oldestCursor - 1 > this.cursor) {
        this.cursor = result.oldestCursor - 1;
      }
      this.gapsRecovered += 1;
    }
  }

  private noteEpoch(epoch: string | null): void {
    if (!epoch) return;
    if (this.epoch === null) {
      this.epoch = epoch;
      return;
    }
    if (this.epoch === epoch) return;
    // A new epoch is a new buffer: the old cursor is meaningless against it.
    this.epoch = epoch;
    this.cursor = 0;
    this.gapsRecovered += 1;
  }

  private emit(event: BufferedEvent): void {
    const envelope = chatEnvelopeFromBufferedEvent(event);
    if (!envelope) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch {
        // Same rule as above: delivery is best-effort per subscriber.
      }
    }
  }
}

/**
 * Chat envelopes ride the buffer as `category: "runtime"` with the envelope
 * spread directly into `payload` (not nested under an `event` key) — same shape
 * the project-scoped path uses in `apps/ade-cli/src/tuiClient/connection.ts`.
 */
export function chatEnvelopeFromBufferedEvent(
  event: BufferedEvent,
): AgentChatEventEnvelope | null {
  if (event.category !== "runtime") return null;
  return isChatEnvelope(event.payload) ? event.payload : null;
}

export function isBufferedEvent(value: unknown): value is BufferedEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.timestamp === "string" &&
    typeof value.category === "string" &&
    isRecord(value.payload)
  );
}

function isChatEnvelope(value: unknown): value is AgentChatEventEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== "string" || typeof value.timestamp !== "string") return false;
  return isRecord(value.event) && typeof value.event.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
