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
  RemoteRuntimeUpdateRoute,
  RemoteRuntimeUpdateStep,
  RemoteRuntimeUpdateStepId,
  RemoteRuntimeUpdateStepStatus,
} from "../../../../desktop/src/shared/types/remoteRuntime";
import { compareUpdateVersions } from "../../../../desktop/src/shared/updateVersions";
import type {
  DesktopAppUpdateInstallResult,
  DesktopAppUpdateRouting,
} from "./desktopAppUpdateBridge";

export type MachineUpdateAndRestartResult = {
  ok: boolean;
  /** True when a new version was actually installed, not just a restart. */
  updateApplied: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  steps: RemoteRuntimeUpdateStep[];
  /** One plain line for the client to show. Names the failed step. */
  message: string;
  /** Which updater took the request: the open desktop app, or the standalone runtime. */
  route: RemoteRuntimeUpdateRoute;
  /**
   * The version the client should see once it reconnects, when the update is
   * still in flight. Null when nothing is expected to change (a failure, or a
   * plain restart). The client checks the machine against it rather than
   * trusting "reconnecting…".
   */
  pendingVersion: string | null;
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
  /**
   * Hand the update to this machine's open desktop app, when there is one.
   *
   * Asked first. An app that owns the brain re-registers its own (older)
   * runtime the moment the standalone update restarts the service, so with an
   * app open the app's own update is the only one that lands. Absent, or
   * `attached: false`: no capable app is open and the standalone path runs.
   */
  requestDesktopAppUpdate?: (targetVersion: string | null) => Promise<DesktopAppUpdateRouting>;
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
  /** See `MachineUpdateAndRestartDeps.requestDesktopAppUpdate`. */
  requestDesktopAppUpdate?: (targetVersion: string | null) => Promise<DesktopAppUpdateRouting>;
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
      const result = await runBrainUpdateCommand(
        normalizedTarget ? ["check", "--version", normalizedTarget] : ["check"],
        { currentVersion: args.version },
      );
      // The check does not only throw on failure — it can hand back `ok: false`.
      // Reporting that as "update available" sends the caller into a swap the
      // check just said it could not stand behind, so surface it as a failed
      // CHECK step rather than a silent "already newest".
      if (result.ok === false) {
        const detail = typeof result.message === "string" && result.message
          ? result.message
          : "The update check did not pass.";
        throw new Error(detail);
      }
      // The check resolves whatever the caller asked for, including "latest".
      // If that resolves to the version already installed, there is nothing to
      // apply, and saying otherwise makes the client show an update that never
      // lands.
      const resolvedRaw = typeof result.requestedVersion === "string"
        ? result.requestedVersion.trim()
        : "";
      const resolved = resolvedRaw && resolvedRaw.toLowerCase() !== "latest" ? resolvedRaw : null;
      const effectiveTarget = normalizedTarget ?? resolved;
      if (effectiveTarget && sameVersion(effectiveTarget, args.version)) {
        return {
          available: false,
          currentVersion: args.version,
          targetVersion: effectiveTarget,
          detail: "Already on the newest version.",
        };
      }
      return {
        available: true,
        currentVersion: args.version,
        targetVersion: effectiveTarget,
        detail: `Update available — ${effectiveTarget ?? "newest version"}.`,
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
    ...(args.requestDesktopAppUpdate ? { requestDesktopAppUpdate: args.requestDesktopAppUpdate } : {}),
  };
}

function step(
  id: RemoteRuntimeUpdateStepId,
  status: RemoteRuntimeUpdateStepStatus,
  detail: string,
): RemoteRuntimeUpdateStep {
  return { id, status, detail };
}

async function runStandaloneUpdateAndRestart(
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
      route: "standalone",
      pendingVersion: null,
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
        route: "standalone",
        pendingVersion: null,
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
        route: "standalone",
        pendingVersion: check.targetVersion,
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
      route: "standalone",
      pendingVersion: null,
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
    route: "standalone",
    pendingVersion: updateApplied ? check.targetVersion : null,
  };
}

/**
 * Map the desktop app's answer onto the same step-by-step result the
 * standalone path reports, so the asking client renders either the same way.
 */
function desktopAppResult(
  answer: DesktopAppUpdateInstallResult,
  targetVersion: string | null,
): MachineUpdateAndRestartResult {
  const version = answer.version ?? targetVersion;
  const named = version ?? "the newest version";
  const base = {
    currentVersion: answer.currentVersion,
    targetVersion: version,
    route: "desktop_app" as const,
  };
  switch (answer.outcome) {
    case "installing":
      return {
        ...base,
        ok: true,
        updateApplied: true,
        steps: [
          step("check", "ok", `The ADE app on this machine has ${named} ready.`),
          step("apply", "pending", answer.message || `The ADE app is installing ${named}.`),
          step("restart", "pending", "The app restarts the background service after it installs."),
        ],
        message: `Installing ADE ${named} — the app on that machine restarts, then reconnecting…`,
        pendingVersion: version,
      };
    case "downloading":
      return {
        ...base,
        ok: true,
        updateApplied: false,
        steps: [
          step("check", "ok", `The ADE app on this machine found ${named}.`),
          step("apply", "pending", answer.message || `Downloading ${named}; it installs when the download finishes.`),
          step("restart", "pending", "The app restarts the background service after it installs."),
        ],
        message: `Downloading ADE ${named} on that machine — it installs and restarts when the download finishes.`,
        pendingVersion: version,
      };
    case "no_update":
      return {
        ...base,
        ok: false,
        updateApplied: false,
        steps: [step("check", "failed", answer.message || "The ADE app found no newer version.")],
        message: answer.message
          || `The ADE app on that machine found no newer version than ${answer.currentVersion ?? "the one it runs"}.`,
        pendingVersion: null,
      };
    case "failed":
    default:
      return {
        ...base,
        ok: false,
        updateApplied: false,
        steps: [step("apply", "failed", answer.message || "The ADE app could not install the update.")],
        message: `Couldn't update the ADE app on that machine — ${answer.message || "it did not say why"}`,
        pendingVersion: null,
      };
  }
}

export async function runMachineUpdateAndRestart(
  deps: MachineUpdateAndRestartDeps,
  targetVersion: string | null = null,
): Promise<MachineUpdateAndRestartResult> {
  if (deps.requestDesktopAppUpdate) {
    let routing: DesktopAppUpdateRouting;
    try {
      routing = await deps.requestDesktopAppUpdate(targetVersion);
    } catch (error) {
      routing = { attached: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (routing.attached) {
      const answer = routing.result;
      // "unsupported" is a development or channel build with no updater of its
      // own: there is nothing to defer to, so the standalone runtime updates.
      // "already_current" means the app is already there and only the brain
      // lags -- a restart picks the app's runtime back up, an apply would not.
      if (answer.outcome === "already_current") {
        const restart = deps.requestRestart();
        return {
          ok: restart.ok,
          updateApplied: false,
          currentVersion: answer.currentVersion,
          targetVersion: answer.version ?? targetVersion,
          steps: [
            step("check", "ok", answer.message || "The ADE app is already on the newest version."),
            step("apply", "skipped", "Already on the newest version."),
            step("restart", restart.ok ? "pending" : "failed", restart.detail),
          ],
          message: restart.ok
            ? "The ADE app is already up to date — restarting its background service, reconnecting…"
            : `The background service didn't restart — ${restart.detail}`,
          route: "desktop_app",
          pendingVersion: restart.ok ? answer.currentVersion : null,
        };
      }
      if (answer.outcome !== "unsupported") return desktopAppResult(answer, targetVersion);
    }
  }
  return await runStandaloneUpdateAndRestart(deps, targetVersion);
}
