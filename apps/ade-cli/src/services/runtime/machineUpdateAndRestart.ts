/**
 * "Update & restart", run on the machine itself at a client's request.
 *
 * The 2026-08-05 incident had two halves. One was a brain that wedged; the
 * other was that fixing it required physically reaching the machine. A
 * headless or closed-app Mac never notices that `/Applications/ADE.app` was
 * replaced -- the version check only runs when a LOCAL desktop connects -- so
 * it can serve old code indefinitely, and nothing a remote client could press
 * would change that.
 *
 * This is that button's host half. It is always user-initiated, never silent,
 * and it reports what happened one step at a time so a failure names the step
 * that failed instead of "something went wrong".
 */

import type {
  RemoteRuntimeUpdateStep,
  RemoteRuntimeUpdateStepId,
  RemoteRuntimeUpdateStepStatus,
} from "../../../../desktop/src/shared/types/remoteRuntime";
import { compareUpdateVersions } from "../../../../desktop/src/shared/updateVersions";

export type MachineUpdateAndRestartResult = {
  ok: boolean;
  /** True when a new version was actually installed, not just a restart. */
  updateApplied: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  steps: RemoteRuntimeUpdateStep[];
  /** One plain line for the client to show. Names the failed step. */
  message: string;
};

export type MachineUpdateCheck = {
  available: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  detail: string;
};

export type MachineUpdateOutcome = {
  ok: boolean;
  version: string | null;
  detail: string;
  /**
   * True when the updater already owns the restart.
   *
   * The staged-apply helper swaps the binary AND re-registers the service
   * itself, so a second restart from here would race a mid-swap install. When
   * this is set, the orchestrator leaves the restart to the helper.
   */
  restartHandledByUpdater?: boolean;
};

export type MachineUpdateAndRestartDeps = {
  /**
   * Is a newer build actually published for this machine's channel?
   *
   * `targetVersion` is what the CLIENT believes is newest. The client is the
   * half of this that can see the release feed -- the host only knows its own
   * version and whether the release assets resolve -- so it names the target and
   * the host refuses to "update" to the version it is already running. Null
   * means "whatever is latest".
   */
  checkForUpdate: (targetVersion: string | null) => Promise<MachineUpdateCheck>;
  /** Download, verify, and swap the runtime in one transaction. */
  applyUpdate: (targetVersion: string | null) => Promise<MachineUpdateOutcome>;
  /**
   * Reinstall the service definition and restart the brain.
   *
   * This kills the process answering the request, so it is REQUESTED, not
   * awaited: a brain cannot report on its own death. The step comes back
   * `pending`, and the client confirms by reconnecting and reading the version.
   */
  requestRestart: () => { ok: boolean; detail: string };
};

export type MachineUpdateControlsArgs = {
  /** This brain's own version — the one thing it can compare a target against. */
  version: string;
  logger: { error: (message: string, fields?: Record<string, unknown>) => void };
  /**
   * Reinstall the service definition and restart this brain.
   *
   * Resolved by the caller because the command has to be looked up at call
   * time: after an update the on-disk runtime is a different file.
   */
  requestRestart: () => Promise<{ status: number | null; stdout: string; stderr: string }>;
};

// One comparator for the whole app. Slightly wider than the old local
// normalizer — it also ignores a capitalized leading "V" and build metadata.
const sameVersion = (left: string, right: string): boolean =>
  compareUpdateVersions(left, right) === 0;

/** The host half of "Update & restart", wired to this machine's installed runtime. */
export function createMachineUpdateControls(
  args: MachineUpdateControlsArgs,
): MachineUpdateAndRestartDeps {
  return {
    checkForUpdate: async (targetVersion) => {
      const normalizedTarget = targetVersion?.trim() || null;
      // The one thing the host can decide on its own: it will not "update" to
      // the version it is already running.
      if (normalizedTarget && sameVersion(normalizedTarget, args.version)) {
        return {
          available: false,
          currentVersion: args.version,
          targetVersion: normalizedTarget,
          detail: "Already on the newest version.",
        };
      }
      const { runBrainUpdateCommand } = await import("../../commands/brainUpdate");
      // `check` is the dry run: it resolves the release assets without touching
      // the installation, so a target that does not exist fails here rather
      // than halfway through a swap.
      await runBrainUpdateCommand(
        normalizedTarget ? ["check", "--version", normalizedTarget] : ["check"],
        { currentVersion: args.version },
      );
      return {
        available: true,
        currentVersion: args.version,
        targetVersion: normalizedTarget,
        detail: `Update available — ${normalizedTarget ?? "newest version"}.`,
      };
    },
    applyUpdate: async (targetVersion) => {
      const normalizedTarget = targetVersion?.trim() || null;
      const { runBrainUpdateCommand } = await import("../../commands/brainUpdate");
      const result = await runBrainUpdateCommand(
        normalizedTarget ? ["--version", normalizedTarget] : [],
        { currentVersion: args.version },
      );
      // `detached` is the staged-apply helper; `restarted` is the same helper
      // run in the foreground. Either way it re-registers and restarts the
      // service after the swap, so this side must not restart as well.
      // The detached helper only restarts when the manifest says to: a
      // `--no-restart` staged apply hands back `detached: true` with
      // `restartService: false`, and assuming a restart there would leave the
      // swapped-in runtime with no restart authority at all.
      const restartHandledByUpdater =
        (result.detached === true && result.restartService !== false)
        || result.restarted === true;
      return {
        ok: result.ok !== false,
        version: normalizedTarget,
        detail: typeof result.message === "string" && result.message
          ? result.message
          : `Installed ${normalizedTarget ?? "the update"}.`,
        restartHandledByUpdater,
      };
    },
    requestRestart: () => {
      // Deliberately not awaited: this tears down the very process answering
      // the call, so the reply has to be on the wire first. The client confirms
      // by reconnecting and reading the version -- which is the only honest
      // confirmation available to a process about its own replacement.
      setTimeout(() => {
        void args.requestRestart().then((restart) => {
          if (restart.status !== 0) {
            args.logger.error("brain.remote_restart_failed", {
              status: restart.status,
              error: restart.stderr || restart.stdout || "service restart failed",
            });
          }
        }, (error: unknown) => {
          args.logger.error("brain.remote_restart_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        // Referenced on purpose: this timer IS the requested action.
      }, 500);
      return { ok: true, detail: "Restarting the background service." };
    },
  };
}

function step(
  id: RemoteRuntimeUpdateStepId,
  status: RemoteRuntimeUpdateStepStatus,
  detail: string,
): RemoteRuntimeUpdateStep {
  return { id, status, detail };
}

export async function runMachineUpdateAndRestart(
  deps: MachineUpdateAndRestartDeps,
  targetVersion: string | null = null,
): Promise<MachineUpdateAndRestartResult> {
  const steps: RemoteRuntimeUpdateStep[] = [];

  let check: MachineUpdateCheck;
  try {
    check = await deps.checkForUpdate(targetVersion);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push(step("check", "failed", detail));
    return {
      ok: false,
      updateApplied: false,
      currentVersion: null,
      targetVersion: null,
      steps,
      message: `Couldn't check for an update — ${detail}`,
    };
  }
  steps.push(step("check", "ok", check.detail));

  let updateApplied = false;
  if (!check.available) {
    // Still worth doing. A machine that is merely stuck -- reachable but not
    // answering properly -- is the other reason this button exists.
    steps.push(step("apply", "skipped", "Already on the newest version."));
  } else {
    let applied: MachineUpdateOutcome;
    try {
      applied = await deps.applyUpdate(check.targetVersion);
    } catch (error) {
      applied = {
        ok: false,
        version: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!applied.ok) {
      steps.push(step("apply", "failed", applied.detail));
      steps.push(step("restart", "skipped", "Not restarted — the update didn't install."));
      return {
        ok: false,
        updateApplied: false,
        currentVersion: check.currentVersion,
        targetVersion: check.targetVersion,
        steps,
        message: `Couldn't install the update — ${applied.detail}`,
      };
    }
    updateApplied = true;
    steps.push(step("apply", "ok", applied.detail));

    if (applied.restartHandledByUpdater) {
      // The updater is already restarting the service. Asking a second time
      // would race it while the binary is being swapped, so we stop here and
      // let the client confirm the same way it would otherwise — by
      // reconnecting and reading the version.
      steps.push(step("restart", "pending", "The updater is restarting the background service."));
      return {
        ok: true,
        updateApplied: true,
        currentVersion: check.currentVersion,
        targetVersion: check.targetVersion,
        steps,
        message: `Updating to ${check.targetVersion ?? "the newest version"} — reconnecting…`,
      };
    }
  }

  const restart = deps.requestRestart();
  if (!restart.ok) {
    steps.push(step("restart", "failed", restart.detail));
    return {
      ok: false,
      updateApplied,
      currentVersion: check.currentVersion,
      targetVersion: check.targetVersion,
      steps,
      message: updateApplied
        ? `Updated ADE, but the background service didn't restart — ${restart.detail}`
        : `The background service didn't restart — ${restart.detail}`,
    };
  }
  steps.push(step("restart", "pending", restart.detail));
  return {
    ok: true,
    updateApplied,
    currentVersion: check.currentVersion,
    targetVersion: check.targetVersion,
    steps,
    message: updateApplied
      ? `Updating to ${check.targetVersion ?? "the newest version"} — reconnecting…`
      : "Restarting — reconnecting…",
  };
}
