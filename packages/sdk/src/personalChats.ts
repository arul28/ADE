import type { JsonRpcConnection } from "./jsonRpc.js";
import type {
  AgentChatEventHistorySnapshot,
  AgentChatFileRef,
  AgentChatModelCatalog,
  AgentChatSessionSummary,
  PersonalChatCallResponse,
} from "./types.js";

/**
 * Thin typed wrapper over the machine-scoped chat RPC.
 *
 * Every chat operation is one method — `personalChats.call` with
 * `{ action, args }` — and the result always comes back wrapped as
 * `{ action, result }` (see `apps/ade-cli/src/services/personalChats/
 * personalChatScope.ts`). Unwrapping in one place keeps that envelope from
 * leaking into the public API.
 */
export class PersonalChatsApi {
  constructor(private readonly connection: JsonRpcConnection) {}

  async call<T>(action: string, args?: unknown, timeoutMs?: number): Promise<T> {
    const response = await this.connection.request<PersonalChatCallResponse<T>>(
      "personalChats.call",
      { action, ...(args !== undefined ? { args } : {}) },
      timeoutMs ? { timeoutMs } : {},
    );
    // Older/simpler handlers may answer with the bare result. Accept both
    // rather than crashing on a runtime that has not adopted the envelope.
    if (response && typeof response === "object" && "action" in response && "result" in response) {
      return (response as PersonalChatCallResponse<T>).result;
    }
    return response as unknown as T;
  }

  /**
   * Always an array. A runtime that answers `null` — an older build, or one
   * whose personal scope is not wired — must degrade to "no chats", not crash
   * the caller with a null dereference three frames away from the RPC.
   */
  async list(includeArchived = false): Promise<AgentChatSessionSummary[]> {
    const result = await this.call<AgentChatSessionSummary[] | null>("list", {
      includeArchived,
    });
    return Array.isArray(result) ? result : [];
  }

  create(args: Record<string, unknown>): Promise<AgentChatSessionSummary> {
    return this.call<AgentChatSessionSummary>("create", args, 180_000);
  }

  getSummary(sessionId: string): Promise<AgentChatSessionSummary | null> {
    return this.call<AgentChatSessionSummary | null>("getSummary", { sessionId });
  }

  send(args: {
    sessionId: string;
    text: string;
    displayText?: string;
    attachments?: AgentChatFileRef[];
    reasoningEffort?: string | null;
  }): Promise<unknown> {
    return this.call("send", args, 300_000);
  }

  steer(args: {
    sessionId: string;
    text: string;
    attachments?: AgentChatFileRef[];
  }): Promise<unknown> {
    return this.call("steer", args, 120_000);
  }

  interrupt(sessionId: string): Promise<unknown> {
    return this.call("interrupt", { sessionId }, 60_000);
  }

  getEventHistory(args: {
    sessionId: string;
    maxEvents?: number;
    maxBytes?: number;
  }): Promise<AgentChatEventHistorySnapshot> {
    return this.call<AgentChatEventHistorySnapshot>("getEventHistory", args, 120_000);
  }

  modelCatalog(args: { mode?: "cached" | "refresh-stale" | "force" } = {}): Promise<AgentChatModelCatalog> {
    return this.call<AgentChatModelCatalog>("modelCatalog", args, 120_000);
  }

  updateSession(args: Record<string, unknown>): Promise<unknown> {
    return this.call("updateSession", args);
  }
}
