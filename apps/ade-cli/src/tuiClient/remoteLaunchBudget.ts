export const REMOTE_RPC_TIMEOUT_MS = 20_000;
export const REMOTE_CONNECT_TOTAL_TIMEOUT_MS = 45_000;

export type RemoteLaunchBudget = {
  deadline: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
};

export class RemoteLaunchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteLaunchTimeoutError";
  }
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Remote ADE connection cancelled.");
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function onAbort(): void {
      if (signal) finish(() => reject(cancellationError(signal)));
    }
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(new RemoteLaunchTimeoutError(message))),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function createRemoteLaunchBudget(
  totalTimeoutMs = REMOTE_CONNECT_TOTAL_TIMEOUT_MS,
  signal?: AbortSignal,
): RemoteLaunchBudget {
  const normalizedTimeoutMs = Math.max(1, totalTimeoutMs);
  return {
    deadline: Date.now() + normalizedTimeoutMs,
    totalTimeoutMs: normalizedTimeoutMs,
    signal,
  };
}

function remainingBudgetMs(budget: RemoteLaunchBudget): number {
  if (budget.signal?.aborted) throw cancellationError(budget.signal);
  return Math.max(0, budget.deadline - Date.now());
}

export function attemptTimeoutMs(
  budget: RemoteLaunchBudget,
  maximum = REMOTE_RPC_TIMEOUT_MS,
): number {
  const remaining = remainingBudgetMs(budget);
  if (remaining <= 0) {
    throw new Error(
      `Remote connection deadline exceeded after ${budget.totalTimeoutMs}ms.`,
    );
  }
  return Math.max(1, Math.min(maximum, remaining));
}

function createBoundedAttempt(
  budget: RemoteLaunchBudget,
  maximum: number,
): { signal: AbortSignal; timeoutMs: number; dispose: () => void } {
  const timeoutMs = attemptTimeoutMs(budget, maximum);
  const controller = new AbortController();
  const budgetSignal = budget.signal;
  const onBudgetAbort = (): void => {
    if (budgetSignal) controller.abort(cancellationError(budgetSignal));
  };
  if (budgetSignal?.aborted) onBudgetAbort();
  else budgetSignal?.addEventListener("abort", onBudgetAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Remote connection attempt exceeded its ${timeoutMs}ms budget.`),
    );
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timeoutMs,
    dispose: () => {
      clearTimeout(timer);
      budgetSignal?.removeEventListener("abort", onBudgetAbort);
    },
  };
}

export async function withBoundedAttempt<T>(
  budget: RemoteLaunchBudget,
  maximum: number,
  run: (attempt: { signal: AbortSignal; timeoutMs: number }) => Promise<T>,
): Promise<T> {
  const attempt = createBoundedAttempt(budget, maximum);
  try {
    return await run(attempt);
  } finally {
    attempt.dispose();
  }
}
