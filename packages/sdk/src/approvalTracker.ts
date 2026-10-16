import { isApprovalShaped, observedApprovalFromEvent, type ObservedApproval } from "./approvals.js";
import { errorMessage } from "./errors.js";
import type { PersonalChatsApi } from "./personalChats.js";
import type { AgentChatEvent } from "./types.js";

/**
 * The approvals one thread watched arrive, minus the ones it saw settled, and
 * the SDK-side decline clock for a policy with `approvalTimeoutMs`.
 *
 * Two jobs for the set. It is the ONLY source of pending approvals against a
 * runtime with no `pendingInputs` action, and it enriches the RPC's answer
 * everywhere else: `PendingInputRequest` has no command/file/tool
 * discriminant, and the event does, so a request the client watched arrive
 * keeps the engine's own `kind` instead of an inference from the payload.
 */
export class ApprovalTracker {
  private readonly observed = new Map<string, ObservedApproval>();
  /** Decline timers by item id, for a policy with `approvalTimeoutMs`. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      /** Read at use: a recreate moves the thread to a new session. */
      sessionId: () => string;
      key: string;
      chats: PersonalChatsApi;
      logger: (line: string) => void;
      /** Read at use: a recreate may rebuild the thread's host config. */
      timeoutMs: () => number | undefined;
    },
  ) {}

  get(itemId: string): ObservedApproval | undefined {
    return this.observed.get(itemId);
  }

  values(): ObservedApproval[] {
    return [...this.observed.values()];
  }

  /** Forget every approval and stop every clock. Idempotent. */
  clear(): void {
    this.observed.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Feed one event of this thread's session. */
  handle(event: AgentChatEvent): void {
    const observed = observedApprovalFromEvent(event);
    if (observed) {
      this.observed.set(observed.itemId, observed);
      this.arm(observed);
      return;
    }
    if (event.type === "pending_input_resolved" && typeof event.itemId === "string") {
      this.settle(event.itemId);
      return;
    }
    // A turn ending settles every approval that turn was blocked on, and the
    // engine's Claude teardown resolves those waiters WITHOUT emitting a
    // `pending_input_resolved` receipt for each. Without this, the derived
    // set keeps listing cards the runtime has already answered: every one of
    // them passes the pre-check in `approve()`, which then forwards an id the
    // engine no longer knows and settles nothing. The map also grew for the
    // life of the client, one entry per approval that ever died in a teardown.
    //
    // `done` ONLY. An `error` is not turn-ending in the engine: an OpenCode
    // per-tool failure emits one and keeps streaming the same turn, and the
    // Codex planning-approval guard emits one to decline a single request.
    // Treating those as endings drops a LIVE approval out of the derived set,
    // and `approve()` then throws `approval_not_found` for a request the
    // runtime is still blocked on — leaving `interrupt()` as the only exit,
    // which is the failure the pre-check exists to prevent. Every teardown and
    // interrupt path emits `done`, so `done` alone still closes the leak.
    if (event.type === "done") {
      const turnId = typeof event.turnId === "string" && event.turnId ? event.turnId : null;
      for (const [itemId, approval] of this.observed) {
        // An ending that names no turn drops everything: there is nothing left
        // running that could still be waiting on one. An approval that carries
        // no turn of its own is dropped by any ending, for the same reason.
        if (turnId === null || approval.turnId === undefined || approval.turnId === turnId) {
          this.settle(itemId);
        }
      }
    }
  }

  private settle(itemId: string): void {
    this.observed.delete(itemId);
    const timer = this.timers.get(itemId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(itemId);
  }

  /**
   * Starts the SDK-side decline clock for one approval, when the policy has one.
   *
   * Approval-shaped requests only. A question wants an answer a decline cannot
   * give, so it is left to the host. The clock is per item, starts when THIS
   * client saw the request, and is cleared by any settlement it sees — an
   * answer, a `pending_input_resolved`, or the turn's `done`.
   */
  private arm(observed: ObservedApproval): void {
    const timeoutMs = this.deps.timeoutMs();
    if (!timeoutMs || timeoutMs <= 0) return;
    if (observed.requestKind !== undefined && !isApprovalShaped(observed.requestKind)) return;
    const existing = this.timers.get(observed.itemId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(observed.itemId);
      if (!this.observed.has(observed.itemId)) return;
      const { key, chats, logger } = this.deps;
      logger(
        `ade sdk: thread "${key}" approval "${observed.itemId}" was unanswered for ${timeoutMs}ms; declining it (approvalTimeoutMs)`,
      );
      void chats
        .approve({
          sessionId: this.deps.sessionId(),
          itemId: observed.itemId,
          decision: "decline",
          responseText: `Declined automatically after ${timeoutMs}ms with no answer.`,
        })
        .then(() => {
          this.observed.delete(observed.itemId);
        })
        .catch((error: unknown) => {
          logger(
            `ade sdk: thread "${key}" could not decline timed-out approval "${observed.itemId}": ${errorMessage(error)}`,
          );
        });
    }, timeoutMs);
    timer.unref?.();
    this.timers.set(observed.itemId, timer);
  }
}
