import type {
  UpdateTransactionResult,
  UpdateTransactionStep,
  UpdateTransactionStepId,
} from "../../../shared/types";

export type {
  UpdateTransactionResult,
  UpdateTransactionStep,
  UpdateTransactionStepId,
  UpdateTransactionStepStatus,
} from "../../../shared/types";

/**
 * One plain line per step, naming what failed. Applying an update is one
 * transaction — app swap, background service reinstalled, service restarted,
 * service answering — so a failure has to say which of those four did not
 * happen instead of leaving a silently broken app.
 */
export const UPDATE_TRANSACTION_FAILURE_COPY: Record<UpdateTransactionStepId, string> = {
  swap: "The update didn't finish installing — ADE is still on the old version.",
  service: "Updated the app, but the background service couldn't be set up — click Repair.",
  restart: "Updated the app, but the background service didn't restart — click Repair.",
  health: "Updated the app, but the background service isn't answering — click Repair.",
};

export type UpdateTransactionStepOutcome = {
  ok: boolean;
  /** Technical detail for the log. Never rendered as the failure line. */
  detail?: string;
};

export type UpdateTransactionDeps = {
  /** The app version now running after the swap, i.e. `app.getVersion()`. */
  installedVersion: string | null;
  /**
   * The version the update was supposed to deliver, when it is known. A
   * relaunch on anything else means the swap did not land.
   */
  expectedVersion?: string | null;
  /** Reinstall the per-user background service so it points at the new app. */
  reinstallService: () => Promise<UpdateTransactionStepOutcome>;
  /** Restart the background service and wait for it to come back. */
  restartService: () => Promise<UpdateTransactionStepOutcome>;
  /** Side-effect-free probe: is the service answering, on compatible code? */
  checkHealth: () => Promise<UpdateTransactionStepOutcome & { version: string | null }>;
};

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function step(
  id: UpdateTransactionStepId,
  status: UpdateTransactionStep["status"],
  detail: string,
): UpdateTransactionStep {
  return { id, status, detail };
}

/**
 * Runs the post-relaunch verification sequence and reports it as one typed
 * result. Pure apart from the injected dependencies: no Electron, no timers, no
 * globals, so the whole matrix is testable.
 *
 * Every step runs at most once. The first failure stops the sequence and every
 * later step is recorded as `skipped`, because a service that could not be
 * installed cannot meaningfully be restarted or pinged. A dependency that
 * throws becomes a `failed` step — this never rejects.
 */
export async function runUpdateTransaction(
  deps: UpdateTransactionDeps,
): Promise<UpdateTransactionResult> {
  const steps: UpdateTransactionStep[] = [];
  const installedVersion = deps.installedVersion?.trim() || null;
  const expectedVersion = deps.expectedVersion?.trim() || null;

  const finish = (failedStep: UpdateTransactionStepId | null): UpdateTransactionResult => {
    if (failedStep) {
      for (const id of ["swap", "service", "restart", "health"] as const) {
        if (!steps.some((entry) => entry.id === id)) {
          steps.push(step(id, "skipped", "Skipped after an earlier step failed."));
        }
      }
    }
    return {
      ok: failedStep == null,
      version: installedVersion,
      steps,
      failureMessage: failedStep ? UPDATE_TRANSACTION_FAILURE_COPY[failedStep] : null,
    };
  };

  if (!installedVersion || (expectedVersion && installedVersion !== expectedVersion)) {
    steps.push(step(
      "swap",
      "failed",
      installedVersion
        ? `Running ${installedVersion}, expected ${expectedVersion}.`
        : "The running app version could not be read.",
    ));
    return finish("swap");
  }
  steps.push(step("swap", "ok", `Running ${installedVersion}.`));

  let serviceOutcome: UpdateTransactionStepOutcome;
  try {
    serviceOutcome = await deps.reinstallService();
  } catch (error) {
    steps.push(step("service", "failed", failureDetail(error)));
    return finish("service");
  }
  if (!serviceOutcome.ok) {
    steps.push(step("service", "failed", serviceOutcome.detail ?? ""));
    return finish("service");
  }
  steps.push(step("service", "ok", serviceOutcome.detail ?? ""));

  let restartOutcome: UpdateTransactionStepOutcome;
  try {
    restartOutcome = await deps.restartService();
  } catch (error) {
    steps.push(step("restart", "failed", failureDetail(error)));
    return finish("restart");
  }
  if (!restartOutcome.ok) {
    steps.push(step("restart", "failed", restartOutcome.detail ?? ""));
    return finish("restart");
  }
  steps.push(step("restart", "ok", restartOutcome.detail ?? ""));

  let healthOutcome: UpdateTransactionStepOutcome & { version: string | null };
  try {
    healthOutcome = await deps.checkHealth();
  } catch (error) {
    steps.push(step("health", "failed", failureDetail(error)));
    return finish("health");
  }
  const healthDetail = healthOutcome.detail
    ?? (healthOutcome.version ? `Background service is running ${healthOutcome.version}.` : "");
  if (!healthOutcome.ok) {
    steps.push(step("health", "failed", healthDetail));
    return finish("health");
  }
  steps.push(step("health", "ok", healthDetail));

  return finish(null);
}
