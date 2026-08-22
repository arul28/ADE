import type { MachineRuntimeIdentity } from "../localRuntime/localRuntimeConnectionPool";
import type { UpdateTransactionStepOutcome } from "./updateTransaction";

/**
 * A runtime process that answered with the wrong identity and is STILL alive.
 *
 * An update that reinstalls the service leaves the pre-update brain running
 * whenever the old process outlives the service definition it was started
 * from: the replacement binds a socket, answers correctly, and the survivor
 * keeps the machine-wide sync-host lease. So "the socket answers on the new
 * build" is not by itself proof that the old runtime is gone.
 */
export type StaleRuntimeRecord = {
  pid: number;
  version: string | null;
};

export type RuntimeIdentityVerdict =
  | { matches: true; detail: string }
  | {
    matches: false;
    reason: "unreachable" | "incompatible" | "version" | "build" | "stale_runtime";
    detail: string;
  };

function describeVersion(version: string | null): string {
  return version ?? "an unknown version";
}

/**
 * Decides whether the runtime that answered the machine endpoint IS the one
 * this update was supposed to leave behind. Pure: every input is a value.
 *
 * A newer compatible brain passes on purpose — the app is allowed to talk to
 * one, and restarting it would kill work the user did not ask to lose.
 */
export function verifyRuntimeIdentity(args: {
  identity: MachineRuntimeIdentity | null;
  expectedVersion: string | null;
  staleRuntime?: StaleRuntimeRecord | null;
}): RuntimeIdentityVerdict {
  const { identity } = args;
  if (!identity) {
    return { matches: false, reason: "unreachable", detail: "The background service did not answer." };
  }
  if (!identity.ok) {
    return {
      matches: false,
      reason: "incompatible",
      detail: identity.detail || `The background service answered on ${describeVersion(identity.version)}.`,
    };
  }
  if (!identity.compatibleNewer) {
    const expectedVersion = args.expectedVersion?.trim() || null;
    if (expectedVersion && identity.version && identity.version !== expectedVersion) {
      return {
        matches: false,
        reason: "version",
        detail: `The background service is running ${identity.version}, expected ${expectedVersion}.`,
      };
    }
    if (
      identity.expectedBuildHash
      && identity.buildHash
      && identity.buildHash !== identity.expectedBuildHash
    ) {
      return {
        matches: false,
        reason: "build",
        detail: "The background service is running a different build than this app.",
      };
    }
  }
  const stale = args.staleRuntime ?? null;
  if (stale && stale.pid !== identity.pid) {
    return {
      matches: false,
      reason: "stale_runtime",
      detail:
        `The pre-update background service (${describeVersion(stale.version)}, process ${stale.pid}) is still running.`,
    };
  }
  return {
    matches: true,
    detail: identity.version
      ? `Background service is running ${identity.version}.`
      : "Background service is answering on the new build.",
  };
}

export type VerifiedRuntimeRestartDeps = {
  /** The version this update delivered, when it is known. */
  expectedVersion: string | null;
  /** Side-effect-free identity probe of the machine endpoint. */
  probeIdentity: () => Promise<MachineRuntimeIdentity | null>;
  /** The one real restart path; the same one the Repair button uses. */
  restartService: () => Promise<void>;
  /**
   * A pre-update runtime that answered with the wrong identity and is still
   * alive, re-read after every restart. `null` when nothing stale is left.
   */
  readStaleRuntime?: () => StaleRuntimeRecord | null;
  /** How many real restarts to spend before reporting the truth. Default 2. */
  maxRestarts?: number;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * Probe who is serving the machine and judge the answer, in one call.
 *
 * The restart step and the health check both need exactly this composition, and
 * a second hand-written copy is how the two drift into disagreeing about what
 * "verified" means. A probe that throws counts as "no identity", which
 * `verifyRuntimeIdentity` already reports as a mismatch.
 */
export async function checkRuntimeIdentity(
  deps: Pick<VerifiedRuntimeRestartDeps, "expectedVersion" | "probeIdentity" | "readStaleRuntime">,
): Promise<{ identity: MachineRuntimeIdentity | null; verdict: RuntimeIdentityVerdict }> {
  const identity = await deps.probeIdentity().catch(() => null);
  return {
    identity,
    verdict: verifyRuntimeIdentity({
      identity,
      expectedVersion: deps.expectedVersion,
      staleRuntime: deps.readStaleRuntime?.() ?? null,
    }),
  };
}

/**
 * The update transaction's restart step.
 *
 * The old step skipped the restart whenever the endpoint answered `ok`, and
 * reported that skip as success. On a machine where the pre-update brain
 * survived the service reinstall, that turned "a stale runtime is still
 * serving this machine" into a green transaction — the failure mode this
 * exists to prevent. So the skip now has to earn itself: the runtime that
 * answers must carry the expected version and build, and no stale mismatched
 * runtime may still be alive. Anything else restarts and re-verifies, and a
 * runtime that still does not match after the last restart is reported as a
 * failed step rather than a successful one.
 */
export async function runVerifiedRuntimeRestart(
  deps: VerifiedRuntimeRestartDeps,
): Promise<UpdateTransactionStepOutcome> {
  const maxRestarts = Math.max(1, deps.maxRestarts ?? 2);
  const log = deps.log ?? (() => undefined);

  const check = async (): Promise<RuntimeIdentityVerdict> =>
    (await checkRuntimeIdentity(deps)).verdict;

  let verdict = await check();
  if (verdict.matches) {
    log("autoUpdate.restart_not_needed", { detail: verdict.detail });
    return { ok: true, detail: `${verdict.detail} Restart not needed.` };
  }

  for (let attempt = 1; attempt <= maxRestarts; attempt++) {
    log("autoUpdate.restart_required", {
      attempt,
      maxRestarts,
      reason: verdict.reason,
      detail: verdict.detail,
    });
    try {
      await deps.restartService();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("autoUpdate.restart_attempt_failed", { attempt, maxRestarts, error: message });
      if (attempt >= maxRestarts) {
        return { ok: false, detail: `The background service did not restart: ${message}` };
      }
      continue;
    }
    verdict = await check();
    if (verdict.matches) {
      log("autoUpdate.restart_verified", { attempt, detail: verdict.detail });
      return { ok: true, detail: `${verdict.detail} Restarted and verified.` };
    }
  }

  log("autoUpdate.restart_verification_failed", {
    reason: verdict.reason,
    detail: verdict.detail,
    restarts: maxRestarts,
  });
  return {
    ok: false,
    detail: `${verdict.detail} Still wrong after ${maxRestarts} restart${maxRestarts === 1 ? "" : "s"}.`,
  };
}
