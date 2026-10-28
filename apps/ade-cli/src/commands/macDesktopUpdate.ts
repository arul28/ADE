import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";
import { manifestNameForPlatform, releaseAssetUrl, sha512Base64 } from "../lib/releaseAssets";
import { packagedCliNodeModulePaths, shellQuote } from "../serviceManager/common";
import type { DesktopAppUpdateRouting } from "../services/runtime/desktopAppUpdateBridge";
import {
  defaultMacApplicationsDirs,
  readInstalledDesktopApp,
  readMacAppBundleInfo,
} from "../../../desktop/src/main/services/native/nativeHelperPaths";
import { parseDesktopManifest } from "./setupDesktop";
import { withoutHelperEnv } from "./windowsDesktopRescue";

/**
 * The macOS half of `brain update --apply-staged`: when the ADE app is
 * installed, the brain and the app move to the same version together.
 *
 * The app owns this Mac's brain. Its service runs the app's own runtime
 * (`ADE.app/Contents/MacOS/ADE … cli.cjs serve`), which keeps the app's privacy
 * permissions, and the app takes the service back whenever it sees a brain of
 * its own version built differently. A brain update that only swapped the
 * standalone `~/.ade/bin/ade` and pointed the service at it left the app
 * behind (1.2.123 app, 1.2.125 brain, 2026-10-27) until someone pressed
 * Restart and install.
 *
 * So, with the app installed:
 * - app already on the target or newer: the service is registered on the
 *   app's runtime, so the brain runs the app's version;
 * - app open: the app installs its own update (the same request "Update &
 *   restart" sends), and its post-update launch restarts the brain on it;
 * - app closed: the release's app archive is downloaded, checked against the
 *   update feed's SHA-512 and the installed app's code signature, swapped in,
 *   and the service is registered on the new app's runtime. Any failure puts
 *   the old app and its service back.
 * Anything that cannot be done safely changes nothing and says why, rather
 * than leaving the brain and the app on different versions.
 */

type CommandResult = { status: number | null; stdout: string; stderr: string };

export type MacCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => CommandResult;

export const defaultMacCommandRunner: MacCommandRunner = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    env: options.env,
    encoding: "utf8",
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

/** How long `brain start` may take: a service install plus the wait for the brain to answer. */
const APP_SERVICE_START_TIMEOUT_MS = 120_000;
const PS_TIMEOUT_MS = 5_000;
const CODESIGN_TIMEOUT_MS = 180_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

export type MacDesktopApp = {
  /** `/Applications/ADE.app`. */
  appPath: string;
  bundleName: string;
  /** `Contents/MacOS/<CFBundleExecutable>`. */
  executablePath: string;
  cliPath: string;
  version: string;
  bundleId: string | null;
};

export function defaultApplicationsDirs(): string[] {
  return defaultMacApplicationsDirs(os.homedir());
}

/** The bundle at `appPath`, read the way every installed-app check reads it (`readMacAppBundleInfo`). */
function describeApp(appPath: string): MacDesktopApp | null {
  const info = readMacAppBundleInfo(appPath);
  if (!info?.version) return null;
  const executable = info.executable ?? path.basename(appPath, ".app");
  return {
    appPath,
    bundleName: path.basename(appPath),
    executablePath: path.join(appPath, "Contents", "MacOS", executable),
    cliPath: path.join(appPath, "Contents", "Resources", "ade-cli", "cli.cjs"),
    version: info.version,
    bundleId: info.id,
  };
}

export type MacDesktopAppLookup =
  | { state: "none" }
  | { state: "channel"; appName: string }
  | { state: "unreadable"; appPath: string }
  | { state: "found"; app: MacDesktopApp };

/**
 * The ADE app for this ADE home: the one `readInstalledDesktopApp` reports, so
 * the update moves the app the machine says it has. Only the stable product is
 * updated: Beta and Alpha have no update feed of their own and must never
 * receive a stable build.
 */
export function findMacDesktopApp(args: {
  env: NodeJS.ProcessEnv;
  applicationsDirs: readonly string[];
}): MacDesktopAppLookup {
  const installed = readInstalledDesktopApp({ platform: "darwin", env: args.env, applicationsDirs: args.applicationsDirs });
  if (!installed) return { state: "none" };
  if (!installed.updatable) return { state: "channel", appName: installed.name };
  const app = describeApp(installed.path);
  return app ? { state: "found", app } : { state: "unreadable", appPath: installed.path };
}

/**
 * Whether the app itself is open. Its brain runs the same executable with the
 * CLI script (`ADE …/cli.cjs serve`), and agents' `ade` does too, so a command
 * line naming `cli.cjs` is not the app. Its helpers live in other bundles.
 */
export function isMacDesktopAppRunning(app: MacDesktopApp, run: MacCommandRunner): boolean {
  const result = run("/bin/ps", ["-axww", "-o", "command="], { timeout: PS_TIMEOUT_MS });
  if (result.status !== 0) return true; // Unknown is treated as open: never swap a bundle that may be running.
  return result.stdout.split(/\r?\n/).some((line) => {
    const command = line.trim();
    if (command !== app.executablePath && !command.startsWith(`${app.executablePath} `)) return false;
    return !command.includes("cli.cjs");
  });
}

/** `isMacDesktopAppRunning` for an app known only by its path, as `ade setup` has it. */
export function isMacDesktopAppRunningAt(appPath: string, run: MacCommandRunner = defaultMacCommandRunner): boolean {
  const app = describeApp(appPath);
  return app ? isMacDesktopAppRunning(app, run) : false;
}

/**
 * The paths a swap has to change: the folder holding the app (two renames)
 * and the top of the bundle (the old copy is deleted afterwards). Sampled, not
 * walked, like the app's own ownership check.
 */
async function unwritableAppPaths(app: MacDesktopApp): Promise<string[]> {
  const targets = [
    path.dirname(app.appPath),
    app.appPath,
    path.join(app.appPath, "Contents"),
    path.join(app.appPath, "Contents", "MacOS"),
    path.join(app.appPath, "Contents", "Resources"),
  ];
  const problems: string[] = [];
  for (const target of targets) {
    try {
      await fsp.access(target, fsConstants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(target);
    }
  }
  return problems;
}

/** `TeamIdentifier=…` from `codesign -dv`, which prints to stderr. Null when unsigned or ad hoc. */
function readTeamIdentifier(run: MacCommandRunner, appPath: string): string | null {
  const result = run("/usr/bin/codesign", ["-dv", "--verbose=2", appPath], { timeout: CODESIGN_TIMEOUT_MS });
  const match = /^TeamIdentifier=(.+)$/m.exec(`${result.stderr}\n${result.stdout}`);
  const team = match?.[1]?.trim() ?? "";
  return result.status === 0 && team && team !== "not set" ? team : null;
}

/**
 * The new bundle must be intact, signed by the installed app's team, the same
 * app, and the version asked for. The feed checksum proves the archive is the
 * release's; this proves the release is ours and is what it says.
 */
function verifyStagedApp(args: {
  run: MacCommandRunner;
  installed: MacDesktopApp;
  stagedAppPath: string;
  targetVersion: string;
}): void {
  const { run, installed, stagedAppPath, targetVersion } = args;
  const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedAppPath], { timeout: CODESIGN_TIMEOUT_MS });
  if (verify.status !== 0) {
    throw new Error(`The downloaded app's code signature is not valid: ${(verify.stderr || verify.stdout).trim() || `exit ${verify.status}`}.`);
  }
  // Fail closed: with no team on the installed app there is nothing to match,
  // and any valid signature would pass.
  const installedTeam = readTeamIdentifier(run, installed.appPath);
  if (!installedTeam) {
    throw new Error("The installed ADE app has no signing team, so the download's publisher can't be confirmed.");
  }
  const stagedTeam = readTeamIdentifier(run, stagedAppPath);
  if (stagedTeam !== installedTeam) {
    throw new Error(`The downloaded app is signed by team ${stagedTeam ?? "none"}, not by the installed app's team ${installedTeam}.`);
  }
  const staged = describeApp(stagedAppPath);
  if (!staged) throw new Error("The downloaded app's version can't be read.");
  if (installed.bundleId && staged.bundleId !== installed.bundleId) {
    throw new Error(`The downloaded app is ${staged.bundleId ?? "an unknown app"}, not ${installed.bundleId}.`);
  }
  if (compareUpdateVersions(staged.version, targetVersion) !== 0) {
    throw new Error(`The downloaded app is ${staged.version}, not ${targetVersion}.`);
  }
}

/** The env the installed app's CLI runs in, as the app gives it to the brain it starts. */
function appCliEnv(app: MacDesktopApp, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...withoutHelperEnv(env),
    ADE_PACKAGE_CHANNEL: "stable",
    ADE_DESKTOP_APP_NAME: path.basename(app.appPath, ".app"),
    ADE_DISABLE_CLI_AUTO_INSTALL: "1",
    ELECTRON_RUN_AS_NODE: "1",
    // The CLI's externals live in the app's asar, as the app's own `ade` wrapper sets them.
    NODE_PATH: packagedCliNodeModulePaths(app.cliPath, { platform: "darwin" }).join(path.delimiter),
    // Re-registering the service stops the brain that is running now, which
    // may be this helper's ancestor (a remote "Update & restart").
    ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
  };
}

/**
 * Registers and starts the background service on the app's own runtime, with
 * that app's CLI. `brain start`, not `serve --install-service`: the latter
 * registers at whatever ADE_DEFAULT_ROLE is, and unset that is `agent`, which
 * refuses the desktop app and the phone.
 */
export function startMacAppService(
  app: MacDesktopApp,
  env: NodeJS.ProcessEnv,
  run: MacCommandRunner,
): { ok: boolean; detail: string } {
  const result = run(app.executablePath, [app.cliPath, "brain", "start", "--json"], {
    env: appCliEnv(app, env),
    timeout: APP_SERVICE_START_TIMEOUT_MS,
  });
  if (result.status === 0) return { ok: true, detail: "" };
  let message: string | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as { message?: unknown };
    message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
  } catch {
    // Not JSON: an early failure before the CLI could answer.
  }
  const lastErrorLine = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  return { ok: false, detail: message ?? lastErrorLine ?? `exit ${result.status}` };
}

type DownloadedRelease = { archivePath: string };

async function downloadAppArchive(args: {
  repo: string;
  targetVersion: string;
  arch: string;
  stagingDir: string;
  downloadFile: (url: string, outPath: string) => Promise<void>;
}): Promise<DownloadedRelease> {
  const feedName = manifestNameForPlatform("darwin");
  const feedPath = path.join(args.stagingDir, feedName);
  await args.downloadFile(releaseAssetUrl(args.repo, args.targetVersion, feedName), feedPath);
  const feedText = await fsp.readFile(feedPath, "utf8");
  const feedVersion = /^\s*version:\s*(\S+)\s*$/m.exec(feedText)?.[1] ?? null;
  if (!feedVersion || compareUpdateVersions(feedVersion, args.targetVersion) !== 0) {
    throw new Error(`The ${args.targetVersion} update feed names a different version (${feedVersion ?? "none"}).`);
  }
  const entry = parseDesktopManifest(feedText, "darwin", args.arch);
  if (!entry) throw new Error(`The ${args.targetVersion} update feed names no ${args.arch} app archive.`);
  const archivePath = path.join(args.stagingDir, path.basename(entry.name));
  await args.downloadFile(releaseAssetUrl(args.repo, args.targetVersion, entry.name), archivePath);
  if (await sha512Base64(archivePath) !== entry.sha512) {
    throw new Error(`The downloaded ${path.basename(entry.name)} does not match the release checksum.`);
  }
  return { archivePath };
}

/**
 * Installs the verified app over the closed one. The new bundle is expanded
 * beside the old (same folder, so both renames stay on one volume), checked,
 * and swapped in; the service is stopped first and registered on the new
 * runtime after. A failure at any step puts the old app and its service back.
 */
async function installOverClosedApp(args: {
  app: MacDesktopApp;
  targetVersion: string;
  repo: string;
  arch: string;
  stagingDir: string;
  env: NodeJS.ProcessEnv;
  run: MacCommandRunner;
  downloadFile: (url: string, outPath: string) => Promise<void>;
  stopService: () => { ok: boolean; message: string };
  onStep: (message: string) => Promise<void>;
}): Promise<{ ok: boolean; applied: boolean; message: string }> {
  const { app, targetVersion, run } = args;
  await args.onStep(`Downloading the ADE ${targetVersion} app.`);
  const { archivePath } = await downloadAppArchive(args);

  const parent = path.dirname(app.appPath);
  const expandDir = path.join(parent, `.${app.bundleName}.update-${process.pid}`);
  const backupPath = path.join(parent, `.${app.bundleName}.previous-${process.pid}`);
  const stagedAppPath = path.join(expandDir, app.bundleName);
  const cleanupExpanded = () => fsp.rm(expandDir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fsp.rm(expandDir, { recursive: true, force: true });
    await fsp.mkdir(expandDir, { recursive: true });
    const expand = run("/usr/bin/ditto", ["-x", "-k", archivePath, expandDir], { timeout: EXTRACT_TIMEOUT_MS });
    if (expand.status !== 0 || !fs.existsSync(stagedAppPath)) {
      throw new Error(`The app archive could not be expanded: ${(expand.stderr || expand.stdout).trim() || `no ${app.bundleName} inside`}.`);
    }
    await args.onStep(`Checking the ADE ${targetVersion} app's signature.`);
    verifyStagedApp({ run, installed: app, stagedAppPath, targetVersion });
  } catch (error) {
    await cleanupExpanded();
    throw error;
  }

  // Checked again here: the download can take minutes, and a bundle swapped
  // under a running app takes it down mid-session.
  if (isMacDesktopAppRunning(app, run)) {
    await cleanupExpanded();
    return { ok: false, applied: false, message: "ADE was opened while the update downloaded, so nothing was installed. Use Restart and install in ADE, or quit it and update again." };
  }

  await args.onStep(`Stopping the ADE background service to install ${targetVersion}.`);
  const stopped = args.stopService();
  if (!stopped.ok) {
    await cleanupExpanded();
    return { ok: false, applied: false, message: `The background service could not be stopped, so nothing was installed: ${stopped.message}` };
  }

  // From here the service is down, so nothing may throw past this function:
  // a status write that fails must not turn into "nothing was changed".
  const step = (message: string) => args.onStep(message).catch(() => undefined);
  // What the swap has done so far. Only these say what to undo: a leftover
  // `.previous-<pid>` from another run is not this run's old app, and the live
  // app is deleted only when this run moved the new one in over it.
  let movedOld = false;
  let movedNew = false;
  const restoreOldApp = async (): Promise<string> => {
    const errors: string[] = [];
    if (movedOld) {
      try {
        if (movedNew) await fsp.rm(app.appPath, { recursive: true, force: true });
        await fsp.rename(backupPath, app.appPath);
      } catch (error) {
        errors.push(`restoring the previous app failed (${error instanceof Error ? error.message : String(error)}; it is at ${backupPath})`);
      }
    }
    // Put its service back so the machine stays reachable, on that app's own runtime.
    const restarted = startMacAppService(app, args.env, run);
    if (!restarted.ok) errors.push(`restarting its background service failed (${restarted.detail})`);
    await cleanupExpanded();
    return errors.length === 0
      ? `ADE ${app.version} and its background service were put back.`
      : `Putting ADE ${app.version} back was incomplete: ${errors.join("; ")}.`;
  };

  // The stop takes seconds, and ADE can be opened meanwhile. Its service goes
  // back up and nothing is swapped under it.
  if (isMacDesktopAppRunning(app, run)) {
    const restarted = startMacAppService(app, args.env, run);
    await cleanupExpanded();
    return {
      ok: false,
      applied: false,
      message: `ADE was opened while its background service stopped, so nothing was installed. ${restarted.ok
        ? "Its background service was started again."
        : `Starting its background service again failed (${restarted.detail}); open ADE to start it.`} Use Restart and install in ADE, or quit it and update again.`,
    };
  }

  await step(`Installing ADE ${targetVersion} over ${app.version}.`);
  try {
    await fsp.rm(backupPath, { recursive: true, force: true });
    await fsp.rename(app.appPath, backupPath);
    movedOld = true;
    await fsp.rename(stagedAppPath, app.appPath);
    movedNew = true;
  } catch (error) {
    const restored = await restoreOldApp();
    return { ok: false, applied: false, message: `Installing ADE ${targetVersion} failed (${error instanceof Error ? error.message : String(error)}). ${restored}` };
  }

  await step(`Starting the background service on ADE ${targetVersion}.`);
  const installed: MacDesktopApp = { ...app, version: targetVersion };
  const started = startMacAppService(installed, args.env, run);
  if (!started.ok) {
    const restored = await restoreOldApp();
    return { ok: false, applied: false, message: `ADE ${targetVersion} installed, but its background service did not start (${started.detail}). ${restored}` };
  }
  const leftBehind = await fsp.rm(backupPath, { recursive: true, force: true }).then(
    () => null,
    (error: unknown) => `The previous app could not be removed (${error instanceof Error ? error.message : String(error)}); delete ${backupPath} to free its space.`,
  );
  await cleanupExpanded();
  return {
    ok: true,
    applied: true,
    message: `Installed ADE ${targetVersion} and started its background service on it.${leftBehind ? ` ${leftBehind}` : ""}`,
  };
}

function bridgeOutcome(
  routing: Extract<DesktopAppUpdateRouting, { attached: true }>,
  targetVersion: string,
): { ok: boolean; applied: boolean; message: string } | "already_current" {
  const answer = routing.result;
  switch (answer.outcome) {
    case "installing":
      return { ok: true, applied: true, message: `The open ADE app is installing ${answer.version ?? targetVersion}; it restarts the background service on it when it reopens.` };
    case "downloading":
      return { ok: true, applied: true, message: `The open ADE app is downloading ${answer.version ?? targetVersion}; it installs it, and restarts the background service on it, when the download finishes.` };
    case "already_current":
      return "already_current";
    case "no_update":
      return { ok: false, applied: false, message: `The open ADE app found no ${targetVersion} to install, so nothing was changed: updating only the brain would leave it on a different version from the app.` };
    case "unsupported":
      return { ok: false, applied: false, message: `The open ADE app cannot update itself (${answer.message || "a development or channel build"}), so nothing was changed.` };
    case "failed":
    default:
      return { ok: false, applied: false, message: `The open ADE app could not install ${targetVersion}: ${answer.message || "it did not say why"}. Nothing else was changed.` };
  }
}

export type MacDesktopUpdateArgs = {
  targetVersion: string;
  repo: string;
  /** `arm64` or `x64`, from the runtime target. */
  arch: string;
  stagingDir: string;
  env: NodeJS.ProcessEnv;
  restartService: boolean;
  applicationsDirs: readonly string[];
  run: MacCommandRunner;
  downloadFile: (url: string, outPath: string) => Promise<void>;
  /** Asks the open app, over its desktop bridge, to install its own update. */
  requestAppUpdate: (targetVersion: string) => Promise<DesktopAppUpdateRouting>;
  /** Stops the background service with this release's code; ok false leaves it running. */
  stopService: () => { ok: boolean; message: string };
  writeStatus: (state: "applying" | "succeeded" | "failed", message: string, error?: string) => Promise<void>;
};

/**
 * Returns the finished outcome when the app decided it (the caller then only
 * brings the standalone `ade` along, without touching the service), or why
 * there was no app to update so the caller goes on with a runtime-only update
 * and says so.
 */
export async function applyMacDesktopUpdate(args: MacDesktopUpdateArgs): Promise<
  | { finished: { ok: boolean; applied: boolean; message: string } }
  | { runtimeOnly: string }
> {
  const lookup = findMacDesktopApp(args);
  if (lookup.state === "none") return { runtimeOnly: "no ADE app is installed on this Mac" };
  if (lookup.state === "channel") {
    return { runtimeOnly: `${lookup.appName} has no update feed, so it stays on its own build and is now behind the brain; rebuild it to match` };
  }
  const finish = async (outcome: { ok: boolean; applied: boolean; message: string }) => {
    await args.writeStatus(outcome.ok ? "succeeded" : "failed", outcome.message, outcome.ok ? undefined : outcome.message);
    return { finished: outcome };
  };
  if (lookup.state === "unreadable") {
    return await finish({ ok: false, applied: false, message: `The version of ${lookup.appPath} could not be read, so nothing was changed.` });
  }
  const { app } = lookup;

  const registerAppRuntime = async (prefix: string) => {
    if (!args.restartService) {
      return await finish({ ok: true, applied: false, message: `${prefix} The background service was left as it is (--no-restart).` });
    }
    await args.writeStatus("applying", `${prefix} Moving the background service onto the app's runtime.`);
    const started = startMacAppService(app, args.env, args.run);
    return await finish(started.ok
      ? { ok: true, applied: true, message: `${prefix} The background service runs the app's ${app.version} runtime.` }
      : { ok: false, applied: false, message: `${prefix} Its background service did not start on the app's runtime (${started.detail}). Open ADE on this Mac to start it.` });
  };

  if (compareUpdateVersions(app.version, args.targetVersion) >= 0) {
    return await registerAppRuntime(`The ADE app is already on ${app.version}.`);
  }

  const routing = await args.requestAppUpdate(args.targetVersion).catch((error: unknown): DesktopAppUpdateRouting => ({
    attached: false,
    detail: error instanceof Error ? error.message : String(error),
  }));
  if (routing.attached) {
    const outcome = bridgeOutcome(routing, args.targetVersion);
    if (outcome === "already_current") return await registerAppRuntime(`The ADE app is already on ${app.version}.`);
    return await finish(outcome);
  }

  if (isMacDesktopAppRunning(app, args.run)) {
    return await finish({
      ok: false,
      applied: false,
      message: `ADE ${app.version} is open but did not answer the update request, so nothing was changed. Use Restart and install in ADE, or quit it and update again.`,
    });
  }
  if (!args.restartService) {
    return await finish({
      ok: false,
      applied: false,
      message: `Updating the ADE app restarts the background service, so with --no-restart nothing was changed. The app is on ${app.version}.`,
    });
  }
  const unwritable = await unwritableAppPaths(app);
  if (unwritable.length > 0) {
    return await finish({
      ok: false,
      applied: false,
      message: `Your account can't replace ${app.appPath} (${unwritable.join(", ")}), so nothing was changed. Open ADE and use Restart and install (it asks for an administrator password), or run \`sudo chown -R "$(id -un)":"$(id -gn)" ${shellQuote(app.appPath)}\` and update again.`,
    });
  }

  await args.writeStatus("applying", `Updating the ADE app from ${app.version} to ${args.targetVersion}.`);
  try {
    return await finish(await installOverClosedApp({
      app,
      targetVersion: args.targetVersion,
      repo: args.repo,
      arch: args.arch,
      stagingDir: args.stagingDir,
      env: args.env,
      run: args.run,
      downloadFile: args.downloadFile,
      stopService: args.stopService,
      onStep: (message) => args.writeStatus("applying", message),
    }));
  } catch (error) {
    // Everything that throws runs before the service is touched.
    return await finish({
      ok: false,
      applied: false,
      message: `The ADE app was not updated, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
