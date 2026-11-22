import type { AccountVaultBridge } from "./accountVaultBridge";

export const VAULT_WRITE_RETRY_DELAY_MS = 5_000;
export const VAULT_WRITE_MAX_ATTEMPTS = 3;

export type VaultWriteOptions = {
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void } | null;
  logEvent: string;
  context?: Record<string, unknown>;
  retryDelayMs?: number;
  maxAttempts?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
};

export function describeVaultFailure(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
    return detail.message;
  }
  return String(detail ?? "unknown error");
}

function defaultSchedule(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
}

/**
 * Queue a vault mutation without making local credential persistence wait on
 * the brain. The returned promise is for a caller that wants to act once the
 * write settled: true when it landed, false when every attempt failed or the
 * account refused it as stale (a newer revision replaced the one it named). It
 * never rejects, so nobody has to await it.
 */
export function fireAndForgetVaultWrite(
  options: VaultWriteOptions,
  operation: "set" | "remove",
  call: (vault: AccountVaultBridge) => Promise<unknown>,
): Promise<boolean> {
  const retryDelayMs = options.retryDelayMs ?? VAULT_WRITE_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? VAULT_WRITE_MAX_ATTEMPTS;
  const schedule = options.schedule ?? defaultSchedule;
  let attempt = 0;
  let settle: (landed: boolean) => void = () => {};
  const settled = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const retryOrStop = (): void => {
    if (attempt >= maxAttempts) {
      settle(false);
      return;
    }
    schedule(run, retryDelayMs);
  };

  const fail = (detail: unknown): void => {
    options.logger?.warn?.(options.logEvent, {
      operation,
      ...options.context,
      error: describeVaultFailure(detail),
      attempt,
    });
    retryOrStop();
  };

  const run = (): void => {
    attempt += 1;
    let vault: AccountVaultBridge | null | undefined;
    try {
      vault = options.getAccountVault?.() ?? null;
    } catch (error) {
      fail(error);
      return;
    }
    if (!vault) {
      fail("vault unavailable");
      return;
    }

    let pending: Promise<unknown>;
    try {
      pending = call(vault);
    } catch (error) {
      fail(error);
      return;
    }
    void Promise.resolve(pending).then((result) => {
      if (result && typeof result === "object" && "ok" in result && result.ok === true) {
        settle(true);
        return;
      }
      // A write that named a revision the item no longer has is an answer, not
      // a failure: the same write again would be refused again. It did not
      // land; the caller reads again on its next sync and decides again.
      if (result && typeof result === "object" && "stale" in result && result.stale === true) {
        settle(false);
        return;
      }
      fail(result);
    }).catch((error: unknown) => {
      fail(error);
    });
  };

  run();
  return settled;
}
