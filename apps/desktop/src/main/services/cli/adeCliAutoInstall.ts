import type { Logger } from "../logging/logger";
import type { AdeCliAutoInstall, GlobalState } from "../state/globalState";
import type { createAdeCliService } from "./adeCliService";

/**
 * Installing the app is the opt-in for the `ade` command, exactly as running
 * `curl -fsSL https://ade-app.dev/install.sh | sh` is. The DMG has no
 * install-time hook (drag-and-drop copies a bundle; no code runs) and this app
 * has no onboarding flow, so app startup is the only chance to make the command
 * exist for a user who never opens Settings and never learns it is there.
 *
 * It writes to the user's shell profile, so it is deliberately timid:
 *
 * - It never runs when `ade` already resolves on the user's PATH. Homebrew,
 *   `install.sh`'s `~/.ade/bin/ade`, and a hand-made symlink all count; ADE must
 *   not shadow or clobber an install it does not own.
 * - It runs once ever, not once per launch, via a marker in the global state
 *   file. Deleting the binary or stripping the PATH line afterwards is a
 *   deliberate act and must not be silently undone on the next launch.
 * - It only marks a machine settled once it knows the outcome. A build that
 *   shipped without the installer leaves no marker, so an update self-heals.
 *
 * Failure is silent and non-fatal: this is a convenience and must never block
 * or error app startup. The Settings card remains the surface a user reads and
 * the way to repair or reinstall.
 */

export type AdeCliAutoInstallOutcome =
  /** Turned off for this process (used by tests and packaging smokes). */
  | "disabled"
  /** A previous launch already settled this machine. */
  | "already-settled"
  /** Some other install already owns `ade` on the user's PATH. */
  | "already-available"
  /** This build cannot install it (no packaged installer / no local build). */
  | "unavailable"
  | "installed"
  | "failed";

type AdeCliAutoInstallArgs = {
  adeCli: Pick<ReturnType<typeof createAdeCliService>, "getStatus" | "installForUser">;
  logger: Logger;
  readState: () => GlobalState;
  writeState: (state: GlobalState) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export async function runAdeCliAutoInstall(
  args: AdeCliAutoInstallArgs,
): Promise<AdeCliAutoInstallOutcome> {
  try {
    return await attemptAdeCliAutoInstall(args);
  } catch (error) {
    // Nothing here is allowed to reach startup. `installForUser` already
    // resolves its own failures, so a throw means something unexpected — say so
    // once, at warn, and leave the machine unsettled so an update can retry.
    args.logger.warn("ade_cli.auto_install_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

async function attemptAdeCliAutoInstall(
  args: AdeCliAutoInstallArgs,
): Promise<AdeCliAutoInstallOutcome> {
  const env = args.env ?? process.env;
  if (env.ADE_DISABLE_CLI_AUTO_INSTALL === "1") return "disabled";

  const state = args.readState();
  if (state.adeCliAutoInstall) return "already-settled";

  const settle = (marker: AdeCliAutoInstall): void => {
    // Re-read: the state file is shared with the rest of main, and this task is
    // deliberately deferred, so anything could have written it meanwhile.
    args.writeState({ ...args.readState(), adeCliAutoInstall: marker });
  };
  const completedAt = (args.now ?? (() => new Date()))().toISOString();

  const status = await args.adeCli.getStatus();
  if (status.terminalInstalled) {
    settle({ completedAt, outcome: "already-available", command: status.command });
    return "already-available";
  }
  if (!status.installAvailable) {
    args.logger.debug("ade_cli.auto_install_skipped", {
      command: status.command,
      reason: "installer_unavailable",
    });
    return "unavailable";
  }

  const result = await args.adeCli.installForUser();
  if (!result.ok) {
    args.logger.warn("ade_cli.auto_install_failed", {
      command: result.status.command,
      installTargetPath: result.status.installTargetPath,
      message: result.message,
    });
    return "failed";
  }
  settle({ completedAt, outcome: "installed", command: result.status.command });
  args.logger.info("ade_cli.auto_install", {
    ok: true,
    command: result.status.command,
    installTargetPath: result.status.installTargetPath,
    message: result.message,
  });
  return "installed";
}
