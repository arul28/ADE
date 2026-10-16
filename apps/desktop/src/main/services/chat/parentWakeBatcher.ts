import type { AgentChatSpawnCompletion } from "../../../shared/types";

/** Longest an idle parent waits for sibling subagents before its wake goes anyway. */
export const PARENT_WAKE_BATCH_HOLD_MS = 15_000;

type PendingEntry = {
  childSessionId: string;
  wakeText: string;
  spawnCompletion: AgentChatSpawnCompletion;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingBatch = {
  entries: PendingEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
};

/**
 * Child completions waiting to wake an idle parent together. A parent that is
 * mid-turn takes each result inline as it lands, at no extra cost; an idle
 * parent would otherwise start one full turn per finished child, so results
 * from siblings that finish close together share one wake. A batch flushes as
 * soon as no sibling subagent of that parent is still running, or after
 * `holdMs`. Each `wake` promise settles with its batch's delivery, so the
 * caller's retry and failure paths stay per child.
 */
export function createParentWakeBatcher(deps: {
  /** True while the parent is mid-turn (it then takes the result inline). */
  isParentBusy: (parentSessionId: string) => boolean;
  /** True while another subagent of the parent is still running. */
  hasRunningSibling: (parentSessionId: string, exceptChildId: string) => boolean;
  /** Send one wake carrying `text`, anchored on the lead child's completion. */
  deliverWake: (parentSessionId: string, text: string, lead: AgentChatSpawnCompletion) => Promise<void>;
  /** Write a batched (non-lead) child's own completion row after its wake landed. */
  recordBatchedCompletion: (parentSessionId: string, completion: AgentChatSpawnCompletion) => void;
  onDelivered: (event: { parentSessionId: string; completions: number; heldMs: number; joinedLiveTurn: boolean }) => void;
  /** A batched child's row could not be written after its wake landed. */
  onRecordFailed?: (event: { parentSessionId: string; childSessionId: string; error: unknown }) => void;
  holdMs?: number;
}) {
  const holdMs = deps.holdMs ?? PARENT_WAKE_BATCH_HOLD_MS;
  const pending = new Map<string, PendingBatch>();

  const flush = async (parentSessionId: string): Promise<void> => {
    const batch = pending.get(parentSessionId);
    if (!batch) return;
    pending.delete(parentSessionId);
    if (batch.timer) clearTimeout(batch.timer);
    const [lead, ...rest] = batch.entries;
    if (!lead) return;
    try {
      const text = rest.length
        ? [`${batch.entries.length} of your subagents finished:`, ...batch.entries.map((entry) => entry.wakeText)].join("\n\n")
        : lead.wakeText;
      await deps.deliverWake(parentSessionId, text, lead.spawnCompletion);
      // Written only once the wake landed: each row is also that child's
      // delivery dedupe anchor, so a failed wake must leave them undelivered.
      for (const entry of rest) {
        // The wake already landed; a failed row write must not reject the
        // batch, or every child's retry would wake the parent again.
        try {
          deps.recordBatchedCompletion(parentSessionId, entry.spawnCompletion);
        } catch (error) {
          deps.onRecordFailed?.({ parentSessionId, childSessionId: entry.childSessionId, error });
        }
      }
      try {
        deps.onDelivered({
          parentSessionId,
          completions: batch.entries.length,
          heldMs: Date.now() - batch.startedAt,
          joinedLiveTurn: false,
        });
      } catch {
        // Telemetry only; the wake already landed.
      }
      for (const entry of batch.entries) entry.resolve();
    } catch (error) {
      for (const entry of batch.entries) entry.reject(error);
    }
  };

  return {
    wake(
      parentSessionId: string,
      childSessionId: string,
      wakeText: string,
      spawnCompletion: AgentChatSpawnCompletion,
    ): Promise<void> {
      const existing = pending.get(parentSessionId);
      const parentBusy = deps.isParentBusy(parentSessionId);
      if (!existing && parentBusy) {
        return deps.deliverWake(parentSessionId, wakeText, spawnCompletion).then(() => {
          try {
            deps.onDelivered({ parentSessionId, completions: 1, heldMs: 0, joinedLiveTurn: true });
          } catch {
            // Telemetry only; rejecting here would make the caller wake the parent again.
          }
        });
      }
      return new Promise<void>((resolve, reject) => {
        const batch: PendingBatch = existing ?? { entries: [], timer: null, startedAt: Date.now() };
        batch.entries.push({ childSessionId, wakeText, spawnCompletion, resolve, reject });
        pending.set(parentSessionId, batch);
        // A parent that turned busy while results were held takes them now,
        // inline, instead of waiting out the hold.
        if (parentBusy || !deps.hasRunningSibling(parentSessionId, childSessionId)) {
          void flush(parentSessionId);
          return;
        }
        if (!batch.timer) {
          batch.timer = setTimeout(() => { void flush(parentSessionId); }, holdMs);
          batch.timer.unref?.();
        }
      });
    },
    /** Drop every held batch; each child's delivery fails through its normal path. */
    dispose(): void {
      for (const [parentSessionId, batch] of pending) {
        if (batch.timer) clearTimeout(batch.timer);
        for (const entry of batch.entries) entry.reject(new Error("Chat service is shutting down."));
        pending.delete(parentSessionId);
      }
    },
  };
}
