import { randomUUID } from "node:crypto";
import type { PendingInputRequest } from "../../../shared/types";

/**
 * One approved Codex plan handed to a chat of its own.
 *
 * The id is reserved and written to disk BEFORE the destination chat exists, so
 * a timeout, a disk-full failure or a brain restart mid-way can never turn one
 * approval into two chats: the retry finds the reservation and reopens it.
 */
export type CodexPlanHandoffRecord = {
  itemId: string;
  implementationSessionId: string;
  turnId: string | null;
  /** The destination owns the plan: a retry opens it instead of sending again. */
  submitted: boolean;
};

/**
 * Whether the destination chat holds the plan.
 *
 * `unknown` is its own answer on purpose: a transcript read that fails must not
 * be mistaken for "the plan was never sent", which would delete a chat that
 * already owns it and send the plan a second time.
 */
export type PlanPresence = "present" | "absent" | "unknown";

/** How many approvals a chat remembers; the oldest finished one is dropped first. */
const MAX_PLAN_HANDOFFS = 32;

export function readCodexPlanHandoffs(value: unknown): CodexPlanHandoffRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CodexPlanHandoffRecord =>
    entry != null && typeof entry === "object"
    && typeof entry.itemId === "string" && entry.itemId.length > 0
    && typeof entry.implementationSessionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.implementationSessionId)
    && (entry.turnId === null || typeof entry.turnId === "string")
    && typeof entry.submitted === "boolean",
  ).slice(-MAX_PLAN_HANDOFFS);
}

function reservePlanHandoff(
  records: CodexPlanHandoffRecord[],
  record: CodexPlanHandoffRecord,
): void {
  if (records.length >= MAX_PLAN_HANDOFFS) {
    const oldestDone = records.findIndex((entry) => entry.submitted);
    if (oldestDone >= 0) records.splice(oldestDone, 1);
    else throw new Error("Finish or cancel a pending plan handoff before starting another.");
  }
  records.push(record);
}

type HandoffEntry = {
  itemId: string;
  kind: "handoff";
  promise: Promise<{ implementationSessionId: string }> | null;
};

/**
 * One plan decision per chat at a time.
 *
 * A plan card can be answered from the desktop, the phone, the web client and
 * the CLI at once, and "Implement here" and "Implement in a new chat" are two
 * different answers to the same card. Letting both run would implement the plan
 * twice — once in the planning chat and once in the new one — and settle the
 * card twice. So every answer for a plan card passes through here, and the
 * second caller is told to wait rather than silently doing the wrong thing.
 *
 * The claim is taken synchronously, before the first await, so two callers
 * arriving in the same tick cannot both pass the check.
 */
export function createCodexPlanDecisions() {
  const inFlight = new Map<string, HandoffEntry | { itemId: string; kind: "answer" }>();
  /**
   * Answers running for a chat, plan or not, counted.
   *
   * A plan approval restored after a restart has no live runtime waiter, so
   * `beginAnswer` cannot recognise it and takes no claim. Without this
   * counter a handoff arriving while that answer was starting would see an
   * idle chat and implement the plan a second time. The counter is what the
   * handoff checks instead: any answer in flight blocks it.
   */
  const answering = new Map<string, number>();

  return {
    /** Room is taken before the first await; release it in a `finally`. */
    beginAnswer(sessionId: string, itemId: string): () => void {
      const current = inFlight.get(sessionId);
      if (current?.kind === "handoff") {
        throw new Error("An implementation chat is starting for this plan. Wait for it to finish.");
      }
      if (current) throw new Error("Another answer for this plan is already being sent.");
      const entry = { itemId, kind: "answer" as const };
      inFlight.set(sessionId, entry);
      return () => {
        if (inFlight.get(sessionId) === entry) inFlight.delete(sessionId);
      };
    },

    isHandoffStarting(sessionId: string): boolean {
      return inFlight.get(sessionId)?.kind === "handoff";
    },

    /** Room is taken before the first await; release it in a `finally`. */
    beginChatAnswer(sessionId: string): () => void {
      answering.set(sessionId, (answering.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (answering.get(sessionId) ?? 1) - 1;
        if (left > 0) answering.set(sessionId, left);
        else answering.delete(sessionId);
      };
    },

    isAnsweringChat(sessionId: string): boolean {
      return (answering.get(sessionId) ?? 0) > 0;
    },

    handoff(args: {
      sessionId: string;
      itemId: string;
      records: CodexPlanHandoffRecord[];
      /** The plan, while it is still the card this approval is about. */
      pending: () => Promise<PendingInputRequest | null>;
      save: () => void;
      /** Reserve, create if needed, and return the destination's id. */
      create: (record: CodexPlanHandoffRecord) => Promise<void>;
      /** The destination's chat row still exists. */
      exists: (sessionId: string) => boolean;
      /** The destination already holds this plan (its durable `user_message`). */
      hasPlan: (sessionId: string, itemId: string) => Promise<PlanPresence>;
      send: (sessionId: string, plan: string) => Promise<void>;
      /** The send threw, but the destination kept the plan; it owns the retry. */
      onAcceptedSendError: (error: unknown) => void;
      /** Throw away a destination that never received the plan. */
      discard: (sessionId: string) => Promise<void>;
      complete: (record: CodexPlanHandoffRecord) => Promise<void>;
    }): Promise<{ implementationSessionId: string }> {
      if ((answering.get(args.sessionId) ?? 0) > 0) {
        throw new Error("This plan is being answered. Wait before starting an implementation chat.");
      }
      const current = inFlight.get(args.sessionId);
      if (current) {
        if (current.kind === "answer") {
          throw new Error("This plan is being answered. Wait before starting an implementation chat.");
        }
        if (current.itemId !== args.itemId) {
          throw new Error("Another plan handoff is starting. Wait for it to finish.");
        }
        return current.promise!;
      }

      const entry: HandoffEntry = { itemId: args.itemId, kind: "handoff", promise: null };
      inFlight.set(args.sessionId, entry);

      /**
       * A reservation survives only while the destination holds the plan: that
       * is the one state a retry can resume. An empty destination is thrown
       * away rather than left as a stray chat, so the next attempt starts from
       * nothing instead of reopening a blank conversation.
       */
      const dropReservation = async (record: CodexPlanHandoffRecord): Promise<void> => {
        const index = args.records.indexOf(record);
        if (index >= 0) args.records.splice(index, 1);
        try { args.save(); } catch { /* the caller's error is the useful one */ }
        if (args.exists(record.implementationSessionId)) {
          await args.discard(record.implementationSessionId).catch(() => undefined);
        }
      };

      const promise = (async () => {
        try {
          const existing = args.records.find((candidate) => candidate.itemId === args.itemId);
          let record = existing;
          if (!record?.submitted) {
            const request = await args.pending();
            if (!request || request.kind !== "plan_approval" || request.source !== "codex" || request.subagent) {
              if (record) await dropReservation(record);
              throw new Error("This Codex plan is no longer waiting for approval.");
            }
            const plan = request.description?.trim() || request.questions[0]?.question?.trim();
            if (!plan) throw new Error("The approved plan is empty. Keep planning before starting a new chat.");
            if (Buffer.byteLength(plan, "utf8") > 256_000) {
              throw new Error("This plan is too large to hand off. Implement it here or shorten the plan first.");
            }
            if (!record) {
              const fresh: CodexPlanHandoffRecord = {
                itemId: args.itemId,
                implementationSessionId: randomUUID(),
                turnId: request.turnId ?? null,
                submitted: false,
              };
              reservePlanHandoff(args.records, fresh);
              // Durable before a destination can exist, so a failed save leaves
              // nothing behind to clean up.
              try { args.save(); } catch (error) { await dropReservation(fresh); throw error; }
              record = fresh;
            }
            try {
              await args.create(record);
              // Another client may have answered or cancelled the card while the
              // chat was starting; then this plan is no longer what is approved.
              if (!await args.pending()) {
                throw new Error("This plan was answered or cancelled while its implementation chat was starting.");
              }
              const presence = await args.hasPlan(record.implementationSessionId, args.itemId);
              if (presence === "unknown") {
                throw new Error("Couldn't read the implementation chat to confirm the plan. Nothing was sent; retry in a moment.");
              }
              if (presence === "absent") {
                try {
                  await args.send(record.implementationSessionId, plan);
                } catch (error) {
                  // Only a confirmed "absent" may send again; an unreadable
                  // destination keeps the plan where it is.
                  if (await args.hasPlan(record.implementationSessionId, args.itemId) === "absent") throw error;
                  // The prompt is in the destination's transcript, so that chat
                  // owns recovery. Sending it again would put it in twice.
                  args.onAcceptedSendError(error);
                }
              }
            } catch (error) {
              const presence = await args.hasPlan(record.implementationSessionId, args.itemId).catch(() => "unknown" as const);
              if (presence === "absent") await dropReservation(record);
              throw error;
            }
            record.submitted = true;
            try { args.save(); } catch (error) { record.submitted = false; throw error; }
          }
          await args.complete(record);
          return { implementationSessionId: record.implementationSessionId };
        } finally {
          if (inFlight.get(args.sessionId) === entry) inFlight.delete(args.sessionId);
        }
      })();

      entry.promise = promise;
      return promise;
    },
  };
}
