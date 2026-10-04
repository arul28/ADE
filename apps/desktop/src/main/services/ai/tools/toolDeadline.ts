import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutableTool } from "./executableTool";

/**
 * How long a provider's MCP client may wait on one ADE tool call.
 *
 * Deliberately far above every ADE tool budget below, so the provider never
 * ends a call first: when it does, the model is told the call failed while
 * ADE's work goes on finishing, and a remote lane create retried on that
 * error makes a second lane. ADE ends its own waits instead
 * (`runAdeToolWithDeadline`). Just over the approval cap, the longest wait a
 * tool can hold.
 */
export const ADE_MCP_TRANSPORT_TIMEOUT_MS = 65 * 60_000;

/** A tool's working budget when it declares none. The old transport cap. */
export const DEFAULT_ADE_TOOL_BUDGET_MS = 120_000;

/** Longest an ADE approval card holds a tool call open waiting for the user. */
export const ADE_TOOL_APPROVAL_TIMEOUT_MS = 60 * 60_000;

/**
 * What a call to another machine adds on top of its own call timeout: the
 * bridge's connect budget (25 s), its 1 s answer slack, and the machine
 * directory read before it.
 */
export const REMOTE_CALL_ALLOWANCE_MS = 40_000;

type DeadlineState = {
  /** Time spent paused (an open approval card) so far, in ms. */
  pausedMs: number;
  pausedAt: number | null;
  /** Re-arms the expiry timer for whatever budget is left. */
  rearm: () => void;
  disarm: () => void;
};

const activeDeadline = new AsyncLocalStorage<DeadlineState>();

export class AdeToolDeadlineError extends Error {
  constructor(readonly budgetMs: number) {
    super(
      `ADE stopped waiting for this tool after ${Math.round(budgetMs / 1000)}s. `
      + "The operation may still finish on its own. Check the current state "
      + "(for example list lanes or chats) before trying it again.",
    );
    this.name = "AdeToolDeadlineError";
  }
}

/** The budget a tool declared for these arguments, or the default. */
export function resolveAdeToolBudgetMs(tool: Pick<ExecutableTool, "budgetMs">, args: unknown): number {
  const declared = typeof tool.budgetMs === "function" ? tool.budgetMs(args) : tool.budgetMs;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : DEFAULT_ADE_TOOL_BUDGET_MS;
}

/**
 * Run one tool call under ADE's own deadline.
 *
 * Time spent inside `pauseAdeToolDeadline` (a user deciding on an approval
 * card) does not count against the budget. When the budget runs out the call
 * rejects with `AdeToolDeadlineError`; the work itself cannot be cancelled, so
 * it keeps running and its eventual result is dropped.
 */
export function runAdeToolWithDeadline<T>(budgetMs: number, work: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const state: DeadlineState = {
      pausedMs: 0,
      pausedAt: null,
      rearm: () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        const remaining = budgetMs - (Date.now() - startedAt - state.pausedMs);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new AdeToolDeadlineError(budgetMs));
        }, Math.max(0, remaining));
      },
      disarm: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
    state.rearm();
    activeDeadline.run(state, () => {
      Promise.resolve()
        .then(work)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            state.disarm();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            state.disarm();
            reject(error);
          },
        );
    });
  });
}

/**
 * Stop the calling tool's deadline clock while `work` runs. A no-op outside a
 * deadline (a headless caller, a test). Nested pauses count once.
 */
export async function pauseAdeToolDeadline<T>(work: () => Promise<T>): Promise<T> {
  const state = activeDeadline.getStore();
  if (!state || state.pausedAt !== null) return await work();
  state.pausedAt = Date.now();
  state.disarm();
  try {
    return await work();
  } finally {
    state.pausedMs += Date.now() - state.pausedAt;
    state.pausedAt = null;
    state.rearm();
  }
}
