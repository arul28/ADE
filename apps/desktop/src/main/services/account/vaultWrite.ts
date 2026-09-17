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

/** Queue a vault mutation without making local credential persistence wait on the brain. */
export function fireAndForgetVaultWrite(
  options: VaultWriteOptions,
  operation: "set" | "remove",
  call: (vault: AccountVaultBridge) => Promise<unknown>,
): void {
  const retryDelayMs = options.retryDelayMs ?? VAULT_WRITE_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? VAULT_WRITE_MAX_ATTEMPTS;
  const schedule = options.schedule ?? defaultSchedule;
  let attempt = 0;

  const retryOrStop = (): void => {
    if (attempt >= maxAttempts) return;
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
      if (result && typeof result === "object" && "ok" in result && result.ok === true) return;
      fail(result);
    }).catch((error: unknown) => {
      fail(error);
    });
  };

  run();
}
