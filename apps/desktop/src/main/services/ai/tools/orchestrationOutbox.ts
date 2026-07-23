import type { createOrchestrationService } from "../../orchestration/orchestrationService";
import type { OrchestrationOutboxEntry } from "../../../../shared/types/orchestration";
import type {
  OrchestrationAgentChatHandle,
  OrchestrationSessionContext,
} from "./orchestrationTools";

const inFlight = new Map<string, Promise<void>>();

// One coalesced retry timer per run. A drain pass is event-driven (fired on a
// mutation commit); an entry deferred by backoff (`nextAttemptAt` in the future)
// would otherwise never be retried until some unrelated mutation happens to fire
// another drain. When a pass leaves such an entry we arm ONE timer for the
// soonest `nextAttemptAt` that performs exactly one more drain. It is cleared and
// re-armed on every later pass (so it always tracks the current soonest wake) and
// unref'd so it can never hold the process open. This is a single pending-work
// timer, not a poll loop.
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

type DrainContext = Pick<OrchestrationSessionContext, "runId" | "bundlePath">;

function clearRetryTimer(runId: string): void {
  const existing = retryTimers.get(runId);
  if (existing) {
    clearTimeout(existing);
    retryTimers.delete(runId);
  }
}

/**
 * Tear down a single run's outbox scheduling state. Called from the service's
 * run-runtime teardown (`runs.delete`) so a disposed/removed run cannot fire a
 * stray deferred-retry drain against a service that is gone. Clears the coalesced
 * retry timer and drops the in-flight coalescing entry.
 */
export function disposeRunOutbox(runId: string): void {
  clearRetryTimer(runId);
  inFlight.delete(runId);
}

/**
 * Tear down all outbox scheduling state (service `dispose()`). Ensures no armed
 * timer survives service shutdown.
 */
export function disposeAllOutbox(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  inFlight.clear();
}

/**
 * After a drain pass, arm a single coalesced timer for the soonest future
 * `nextAttemptAt` among still-pending entries. Delays are measured against the
 * service clock (`svc.nowMs()`) so an injected/frozen test clock cannot make the
 * timer spin against wall time. No-op when nothing is deferred.
 */
function scheduleDeferredRetry(
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
  ctx: DrainContext,
): void {
  clearRetryTimer(ctx.runId);
  const manifest = svc.getManifestForRun(ctx.runId);
  if (!manifest) return;
  const nowMs = svc.nowMs();
  let soonest = Number.POSITIVE_INFINITY;
  for (const entry of manifest.outbox ?? []) {
    if (entry.status !== "pending" || !entry.nextAttemptAt) continue;
    const at = Date.parse(entry.nextAttemptAt);
    if (Number.isFinite(at) && at > nowMs && at < soonest) soonest = at;
  }
  if (!Number.isFinite(soonest)) return;
  const delay = Math.max(0, soonest - nowMs);
  const timer = setTimeout(() => {
    retryTimers.delete(ctx.runId);
    void drainOutbox(svc, chat, ctx);
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  retryTimers.set(ctx.runId, timer);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deliver(
  chat: OrchestrationAgentChatHandle,
  entry: OrchestrationOutboxEntry,
): Promise<void> {
  const args = {
    sessionId: entry.targetSessionId,
    // sendMessage/steer require a string; delivery.text is optional on the entry
    // (interrupt carries none). Coalesce so the typed contract holds — an empty
    // send is a no-op downstream, matching prior behaviour.
    text: entry.delivery.text ?? "",
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
  try {
    await drainLoop(svc, chat, ctx, attempted);
  } finally {
    // Always (re)arm the deferred-retry timer against the post-pass state so an
    // entry parked on backoff is retried even if no further mutation fires a
    // drain. Runs in `finally` so a mid-loop throw still schedules the wake.
    scheduleDeferredRetry(svc, chat, ctx);
  }
}

async function drainLoop(
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
  ctx: DrainContext,
  attempted: Set<string>,
): Promise<void> {
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
