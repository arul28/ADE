import type { AccountVaultBridge } from "./accountVaultBridge";

export type VaultWriteOptions = {
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void } | null;
  logEvent: string;
  context?: Record<string, unknown>;
};

export function describeVaultFailure(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
    return detail.message;
  }
  return String(detail ?? "unknown error");
}

/** Queue a vault mutation without making local credential persistence wait on the brain. */
export function fireAndForgetVaultWrite(
  options: VaultWriteOptions,
  operation: "set" | "remove",
  call: (vault: AccountVaultBridge) => Promise<unknown>,
): void {
  let vault: AccountVaultBridge | null | undefined;
  try {
    vault = options.getAccountVault?.() ?? null;
  } catch (error) {
    options.logger?.warn?.(options.logEvent, {
      operation,
      ...options.context,
      error: describeVaultFailure(error),
    });
    return;
  }
  if (!vault) return;

  let pending: Promise<unknown>;
  try {
    pending = call(vault);
  } catch (error) {
    options.logger?.warn?.(options.logEvent, {
      operation,
      ...options.context,
      error: describeVaultFailure(error),
    });
    return;
  }
  void Promise.resolve(pending).then((result) => {
    if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
      options.logger?.warn?.(options.logEvent, {
        operation,
        ...options.context,
        error: describeVaultFailure(result),
      });
    }
  }).catch((error: unknown) => {
    options.logger?.warn?.(options.logEvent, {
      operation,
      ...options.context,
      error: describeVaultFailure(error),
    });
  });
}
