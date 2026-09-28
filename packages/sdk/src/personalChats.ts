import { AdeError } from "./errors.js";
import type { JsonRpcConnection } from "./jsonRpc.js";
import type { EngineApprovalDecision } from "./approvals.js";
import type {
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatFileRef,
  AgentChatModelCatalog,
  AgentChatSessionSummary,
  PendingInputRequest,
  PendingInputsResult,
} from "./types.js";
import type { PersonalChatCallResponse } from "./wireTypes.js";

/**
 * Whether a summary says a turn is running: the runtime's `active` status, or a
 * turn start it has not cleared. The one check every "refuse mid-turn" and
 * "interrupt before a lifecycle action" decision reads.
 */
export function summaryTurnActive(summary: AgentChatSessionSummary | null | undefined): boolean {
  return summary?.status === "active" || typeof summary?.currentTurnStartedAt === "string";
}

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
  private readonly connectionOf: () => JsonRpcConnection;

  /**
   * Takes the connection, or a function returning the current one.
   *
   * The function form is what lets a client respawn its runtime without
   * handing every thread a new API object: each call reads the connection
   * that is live NOW, so a thread opened before a restart keeps working after
   * it.
   */
  constructor(connection: JsonRpcConnection | (() => JsonRpcConnection)) {
    this.connectionOf = typeof connection === "function" ? connection : () => connection;
  }

  /**
   * One `personalChats.call`, unwrapped.
   *
   * The engine refuses a bad argument (a `requestedCwd` outside the home, a
   * malformed policy, a title of the wrong type) with a message that starts
   * `invalid_argument:`, which the RPC layer delivers as a generic `rpc_error`.
   * A caller cannot branch on prose, and the two cases are genuinely different
   * — `rpc_error` says the runtime failed, `invalid_option` says the arguments
   * were wrong — so that one refusal is translated here, for every action.
   * Everything else passes through untouched.
   */
  async call<T>(action: string, args?: unknown, timeoutMs?: number): Promise<T> {
    let response: PersonalChatCallResponse<T>;
    try {
      response = await this.connectionOf().request<PersonalChatCallResponse<T>>(
        "personalChats.call",
        { action, ...(args !== undefined ? { args } : {}) },
        timeoutMs ? { timeoutMs } : {},
      );
    } catch (error) {
      if (error instanceof AdeError && error.code === "rpc_error" && /invalid_argument:/.test(error.message)) {
        throw new AdeError("invalid_option", error.message, { cause: error });
      }
      throw error;
    }
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

  /**
   * One older page of the durable transcript, by sequence cursor.
   *
   * `beforeOffset` is sent as 0 because the runtime requires the field and
   * ignores it whenever `beforeSequence` is set; the SDK pages by sequence
   * only, since a byte offset means nothing to a caller.
   */
  getEventHistoryPage(args: {
    sessionId: string;
    beforeSequence: number;
    maxBytes?: number;
  }): Promise<AgentChatEventHistoryPage> {
    return this.call<AgentChatEventHistoryPage>(
      "getEventHistoryPage",
      { beforeOffset: 0, ...args },
      120_000,
    );
  }

  archive(sessionId: string): Promise<unknown> {
    return this.call("archive", { sessionId }, 60_000);
  }

  unarchive(sessionId: string): Promise<unknown> {
    return this.call("unarchive", { sessionId }, 60_000);
  }

  /** Idempotent on the runtime side: an unknown session is a delete with nothing to do. */
  delete(sessionId: string): Promise<unknown> {
    return this.call("delete", { sessionId }, 120_000);
  }

  modelCatalog(args: { mode?: "cached" | "refresh-stale" | "force" } = {}): Promise<AgentChatModelCatalog> {
    return this.call<AgentChatModelCatalog>("modelCatalog", args, 120_000);
  }

  /**
   * Change a live session: title, model, reasoning, fast mode, MCP servers.
   * The runtime answers with the session's summary after the change, or null
   * when it has no summary to give.
   */
  updateSession(args: Record<string, unknown>): Promise<AgentChatSessionSummary | null> {
    return this.call<AgentChatSessionSummary | null>("updateSession", args);
  }

  /**
   * Answers one blocked approval.
   *
   * The engine settles an unknown or already-settled item silently, so a caller
   * cannot tell a real answer from a no-op by the result. `AdeThread.approve`
   * checks the pending set first for that reason.
   */
  approve(args: {
    sessionId: string;
    itemId: string;
    decision: EngineApprovalDecision;
    responseText?: string;
  }): Promise<unknown> {
    return this.call("approve", args, 60_000);
  }

  /**
   * Every unresolved request for one session.
   *
   * Always an array: a runtime that answers `null`, or one whose result is not
   * the documented envelope, degrades to "nothing pending" rather than a null
   * dereference inside a render pass.
   */
  async pendingInputs(sessionId: string): Promise<PendingInputRequest[]> {
    const result = await this.call<Partial<PendingInputsResult> | null>("pendingInputs", {
      sessionId,
    });
    return Array.isArray(result?.requests) ? result.requests : [];
  }
}
