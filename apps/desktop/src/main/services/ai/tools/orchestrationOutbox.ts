import type { createOrchestrationService } from "../../orchestration/orchestrationService";
import type { OrchestrationOutboxEntry } from "../../../../shared/types/orchestration";
import type {
  OrchestrationAgentChatHandle,
  OrchestrationSessionContext,
} from "./orchestrationTools";

const inFlight = new Map<string, Promise<void>>();

type DrainContext = Pick<OrchestrationSessionContext, "runId" | "bundlePath">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deliver(
  chat: OrchestrationAgentChatHandle,
  entry: OrchestrationOutboxEntry,
): Promise<void> {
  const args = {
    sessionId: entry.targetSessionId,
    text: entry.delivery.text,
    ...(entry.delivery.metadata ? { metadata: entry.delivery.metadata } : {}),
  };
  if (entry.delivery.op === "sendMessage") {
    await chat.sendMessage(args, { awaitDispatch: false });
    return;
  }
  if (entry.delivery.op === "steer") {
    await chat.steer(args);
    return;
  }
  if (entry.delivery.op === "interrupt-replace") {
    await chat.interrupt({ sessionId: entry.targetSessionId });
    await chat.sendMessage(args, { awaitDispatch: false });
    return;
  }
  await chat.interrupt({ sessionId: entry.targetSessionId });
}

async function runDrain(
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
  ctx: DrainContext,
): Promise<void> {
  const attempted = new Set<string>();
  while (true) {
    const due = svc
      .listDueOutbox(ctx.runId)
      .filter((entry) => !attempted.has(entry.id));
    if (!due.length) return;
    let claimedAny = false;
    for (const candidate of due) {
      attempted.add(candidate.id);
      let claimed: typeof candidate | null = null;
      try {
        claimed = await svc.claimOutboxEntry(
          ctx.runId,
          ctx.bundlePath,
          candidate.id,
        );
        if (!claimed) continue;
        claimedAny = true;
        try {
          await deliver(chat, claimed);
          await svc.settleOutboxEntry(
            ctx.runId,
            ctx.bundlePath,
            claimed.id,
            { status: "delivered" },
          );
        } catch (err) {
          const nextAttempts = claimed.attempts + 1;
          await svc.settleOutboxEntry(
            ctx.runId,
            ctx.bundlePath,
            claimed.id,
            {
              status: nextAttempts >= claimed.maxAttempts ? "failed" : "pending",
              error: errorMessage(err),
              backoffMs: Math.min(30_000, 500 * 2 ** claimed.attempts),
            },
          );
        }
      } catch {
        // A failed claim/settlement leaves the durable row available for the
        // next event-driven drain or recovery sweep.
      }
    }
    if (!claimedAny) return;
  }
}

/**
 * Drain a run's durable chat-delivery queue. Calls coalesce per run; a caller
 * that arrives during an active drain waits for it and then performs one more
 * pass so a late enqueue cannot be missed. No timers or polling loops are used.
 */
export async function drainOutbox(
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
  ctx: DrainContext,
): Promise<void> {
  try {
    const active = inFlight.get(ctx.runId);
    if (active) {
      await active;
      if (inFlight.get(ctx.runId) === active) inFlight.delete(ctx.runId);
      await drainOutbox(svc, chat, ctx);
      return;
    }
    const work = runDrain(svc, chat, ctx).catch(() => undefined);
    inFlight.set(ctx.runId, work);
    try {
      await work;
    } finally {
      if (inFlight.get(ctx.runId) === work) inFlight.delete(ctx.runId);
    }
  } catch {
    // Delivery is best-effort at the call boundary. The durable manifest row
    // remains the source of truth and will be retried by the next drain event.
  }
}
