import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";
import { terminateProcessTree } from "../../../desktop/src/main/services/shared/processExecution";
import { manifestNameForPlatform, releaseAssetUrl, sha512Base64 } from "../lib/releaseAssets";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import { readWindowsServiceBrainCommand } from "../serviceManager/installWindows";

/**
 * Installs the ADE desktop app's own update on a Windows machine whose app
 * cannot install it itself.
 *
 * ADE 1.2.112 and 1.2.113 abort every update install on Windows: before the
 * install they prove the running brain against the wrong command and refuse to
 * stop it. Their in-app updater is the very code that cannot be fixed by an
 * update, so the fix has to arrive another way. One does: when such a
 * machine's brain is asked to update while the app is closed, it downloads
 * the release's standalone runtime, checks it against the release checksums,
 * and runs it as `brain update --apply-staged`. That is this release's code,
 * and it can install the app properly.
 *
 * It does what the in-app updater does on a working build: stop the
 * background service, run the signed installer with `--updated /S`, and let
 * the installer's own setup step start the new build's service.
 */

const INSTALLER_TIMEOUT_MS = 15 * 60_000;
const UPDATE_FEED_ASSET = manifestNameForPlatform("win32");

export type WindowsDesktopRescuePlan = {
  appExe: string;
  installDir: string;
  installedVersion: string;
  targetVersion: string;
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

function runPowerShell(script: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(
    resolveTrustedWindowsTool("powershell"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
}

/** `1.2.112.0` (a Windows file version) as `1.2.112`; null when it is not a version. */
function releaseVersionOf(fileVersion: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(fileVersion.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * The stable desktop app on this machine. Prefers the app the installed
 * background service runs from, so a machine that installed ADE somewhere
 * unusual is still found; falls back to the per-user default location.
 */
function locateStableDesktopApp(env: NodeJS.ProcessEnv): { appExe: string; installDir: string } | null {
  const candidates: string[] = [];
  const service = readWindowsServiceBrainCommand(env);
  if (service && path.win32.basename(service.command).toLowerCase() === "ade.exe") {
    candidates.push(service.command);
  }
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) candidates.push(path.win32.join(localAppData, "Programs", "ADE", "ADE.exe"));
  for (const appExe of candidates) {
    const installDir = path.win32.dirname(appExe);
    // Only the stable product: Beta and Alpha install beside it under their own
    // names, have no release feed, and must never receive a stable installer.
    if (path.win32.basename(installDir).toLowerCase() !== "ade") continue;
    if (!fs.existsSync(appExe)) continue;
    if (!fs.existsSync(path.win32.join(installDir, "resources", "ade-cli", "cli.cjs"))) continue;
    return { appExe, installDir };
  }
  return null;
}

/**
 * What a rescue would install, or why there is nothing to rescue: no stable
 * desktop app here, its version cannot be read, or it already runs
 * `targetVersion` or newer. The reason is recorded in the update status, so a
 * runtime-only update on Windows says why it left the app alone.
 */
export function planWindowsDesktopRescue(args: {
  env: NodeJS.ProcessEnv;
  targetVersion: string;
}):
  | { plan: WindowsDesktopRescuePlan }
  | { skipped: string; reason: "no_app" | "version_unreadable" | "app_current"; appExe?: string } {
  const app = locateStableDesktopApp(args.env);
  if (!app) return { skipped: "no stable ADE desktop app was found on this machine", reason: "no_app" };
  const read = runPowerShell(
    "[Console]::Out.Write((Get-Item -LiteralPath $env:ADE_RESCUE_APP_EXE).VersionInfo.ProductVersion)",
    { ...args.env, ADE_RESCUE_APP_EXE: app.appExe },
  );
  const installedVersion = read.status === 0 ? releaseVersionOf(read.stdout) : null;
  if (!installedVersion) {
    return {
      skipped: `the version of ${app.appExe} could not be read (${read.stderr || read.stdout || `exit ${read.status}`})`,
      reason: "version_unreadable",
      appExe: app.appExe,
    };
  }
  if (compareUpdateVersions(installedVersion, args.targetVersion) >= 0) {
    return { skipped: `the ADE app is already on ${installedVersion}`, reason: "app_current", appExe: app.appExe };
  }
  return { plan: { ...app, installedVersion, targetVersion: args.targetVersion } };
}

/** The installer's sha512 as the release's update feed publishes it. */
function feedSha512(feedText: string, installerName: string, targetVersion: string): string {
  const feed = YAML.parse(feedText) as {
    version?: unknown;
    files?: Array<{ url?: unknown; sha512?: unknown }>;
  } | null;
  if (!feed || String(feed.version ?? "").trim() !== targetVersion) {
    throw new Error(`The ${targetVersion} update feed names a different version (${String(feed?.version ?? "none")}).`);
  }
  const entry = (feed.files ?? []).find((file) => file.url === installerName);
  if (typeof entry?.sha512 !== "string" || !entry.sha512.trim()) {
    throw new Error(`The ${targetVersion} update feed has no checksum for ${installerName}.`);
  }
  return entry.sha512.trim();
}

/**
 * The installer must carry a valid Authenticode signature from the same signer
 * as the app it replaces. The checksum proves it is the release's file; this
 * proves the release is ours.
 */
function verifyInstallerSigner(installerPath: string, appExe: string, env: NodeJS.ProcessEnv): void {
  const read = runPowerShell(
    [
      "$ErrorActionPreference = 'Stop'",
      "$installer = Get-AuthenticodeSignature -LiteralPath $env:ADE_RESCUE_INSTALLER",
      "$app = Get-AuthenticodeSignature -LiteralPath $env:ADE_RESCUE_APP_EXE",
      "[Console]::Out.Write((@{ installerStatus = [string]$installer.Status; installerSubject = [string]$installer.SignerCertificate.Subject; appStatus = [string]$app.Status; appSubject = [string]$app.SignerCertificate.Subject } | ConvertTo-Json -Compress))",
    ].join("; "),
    { ...env, ADE_RESCUE_INSTALLER: installerPath, ADE_RESCUE_APP_EXE: appExe },
  );
  let facts: Record<string, string> = {};
  try {
    facts = JSON.parse(read.stdout) as Record<string, string>;
  } catch {
    throw new Error(`Could not read the installer's signature: ${read.stderr || read.stdout || `exit ${read.status}`}.`);
  }
  if (facts.installerStatus !== "Valid") {
    throw new Error(`The downloaded installer's signature is not valid (${facts.installerStatus || "unknown"}).`);
  }
  // Fail closed: with no valid signer on the installed app there is nothing to
  // match, and any publisher's valid certificate would pass.
  if (facts.appStatus !== "Valid") {
    throw new Error(`The installed ADE app's signature is not valid (${facts.appStatus || "unknown"}), so the installer's publisher can't be confirmed.`);
  }
  if (facts.installerSubject !== facts.appSubject) {
    throw new Error(`The downloaded installer is signed by "${facts.installerSubject}", not by the installed app's signer.`);
  }
}

/** Whether the desktop app itself (not its brain or a helper) has a window open. */
function isDesktopAppRunning(appExe: string, env: NodeJS.ProcessEnv): boolean {
  const read = runPowerShell(
    [
      "$exe = $env:ADE_RESCUE_APP_EXE.ToLowerInvariant()",
      "$open = @(Get-CimInstance Win32_Process -Filter 'ExecutablePath IS NOT NULL' | Where-Object { $_.ExecutablePath.ToLowerInvariant() -eq $exe -and $_.CommandLine -notmatch 'cli\\.cjs|--type=' })",
      "[Console]::Out.Write($open.Count)",
    ].join("; "),
    { ...env, ADE_RESCUE_APP_EXE: appExe },
  );
  return read.status === 0 && Number(read.stdout) > 0;
}

function runInstaller(installerPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(installerPath, args, { env, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      // The installer runs the old build's uninstaller as a child; kill the tree.
      terminateProcessTree(child);
      resolve(null);
    }, INSTALLER_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function runWindowsDesktopRescue(
  plan: WindowsDesktopRescuePlan,
  args: {
    repo: string;
    stagingDir: string;
    env: NodeJS.ProcessEnv;
    downloadFile: (url: string, outPath: string) => Promise<void>;
    /** Stops the background service with this release's code; ok false leaves it running. */
    stopService: () => { ok: boolean; message: string };
    onStep: (message: string) => Promise<void>;
  },
): Promise<{ ok: boolean; message: string }> {
  const installerName = `ADE-${plan.targetVersion}-win-x64.exe`;
  const installerPath = path.join(args.stagingDir, installerName);
  const feedPath = path.join(args.stagingDir, UPDATE_FEED_ASSET);

  await args.onStep(`Downloading the ADE ${plan.targetVersion} app installer.`);
  await args.downloadFile(releaseAssetUrl(args.repo, plan.targetVersion, installerName), installerPath);
  await args.downloadFile(releaseAssetUrl(args.repo, plan.targetVersion, UPDATE_FEED_ASSET), feedPath);
  const expected = feedSha512(await fsp.readFile(feedPath, "utf8"), installerName, plan.targetVersion);
  const actual = await sha512Base64(installerPath);
  if (actual !== expected) {
    throw new Error(`The downloaded ${installerName} does not match the release checksum.`);
  }
  verifyInstallerSigner(installerPath, plan.appExe, args.env);

  // Reopen the app afterwards only if it was open: the person is not here to
  // be surprised by a window, but someone who had it open expects it back.
  const reopen = isDesktopAppRunning(plan.appExe, args.env);
  await args.onStep(`Stopping the ADE background service to install ${plan.targetVersion}.`);
  const stopped = args.stopService();
  if (!stopped.ok) {
    return { ok: false, message: `The background service could not be stopped, so nothing was installed: ${stopped.message}` };
  }

  await args.onStep(`Installing ADE ${plan.targetVersion} over ${plan.installedVersion}.`);
  // The same arguments electron-updater gives the installer: an update, silent.
  // The installer stops whatever still runs from the install folder. On an
  // update its setup step leaves the background service to the relaunched app,
  // so with the app closed the service is started here instead.
  const exitCode = await runInstaller(installerPath, ["--updated", "/S", ...(reopen ? ["--force-run"] : [])], withoutHelperEnv(args.env));
  if (exitCode === 0) {
    if (reopen) return { ok: true, message: `Installed ADE ${plan.targetVersion}; it is reopening and starts its background service.` };
    const started = startAppService(plan, args.env);
    return started.ok
      ? { ok: true, message: `Installed ADE ${plan.targetVersion} and started its background service.` }
      : { ok: false, message: `Installed ADE ${plan.targetVersion}, but its background service did not start (${started.detail}). Open ADE on this PC to start it.` };
  }

  // The old app is still in place. Put its service back so the machine stays
  // reachable, through that app's own CLI so the service runs the app's brain.
  const restored = startAppService(plan, args.env).ok
    ? "Its previous background service was restarted."
    : "Restarting its previous background service also failed.";
  return {
    ok: false,
    message: `The ADE ${plan.targetVersion} installer ${exitCode === null ? "did not finish" : `exited with code ${exitCode}`}. ${restored}`,
  };
}

/**
 * `env` without what belongs to this update helper. It runs the standalone
 * runtime, so its runtime root and module paths point into the update's
 * staging folder (a service registered with them would load from a folder
 * that is about to be deleted), and it carries the helper's own permissions,
 * which must not reach the app the installer reopens or its agent shells.
 */
export function withoutHelperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    "ADE_RUNTIME_ROOT",
    "ADE_RUNTIME_NODE_MODULES",
    "ADE_RESOLVED_RUNTIME_ROOT",
    "NODE_PATH",
    "ADE_CLI_PATH",
    "ADE_CLI_ENTRY_PATH",
    "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION",
    "ADE_BRAIN_UPDATE_APPLY",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    delete next[key];
  }
  return next;
}

/** The environment the installed app's CLI runs in, as its installer's setup step gives it (windows-install-setup.ps1). */
function appCliEnv(plan: WindowsDesktopRescuePlan, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resources = path.win32.join(plan.installDir, "resources");
  return {
    ...withoutHelperEnv(env),
    ADE_PACKAGE_CHANNEL: "stable",
    ADE_DESKTOP_APP_NAME: path.win32.basename(plan.appExe, ".exe"),
    ADE_DISABLE_CLI_AUTO_INSTALL: "1",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_PATH: [
      path.win32.join(resources, "app.asar.unpacked", "node_modules"),
      path.win32.join(resources, "app.asar", "node_modules"),
    ].join(";"),
  };
}

/**
 * Registers and starts the installed app's background service with that app's
 * own CLI. `brain start`, not `serve --install-service`: the latter registers
 * at whatever ADE_DEFAULT_ROLE is, and unset that is `agent`, which refuses the
 * desktop app and the phone.
 */
function startAppService(plan: WindowsDesktopRescuePlan, env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  const result = spawnSync(
    plan.appExe,
    [path.win32.join(plan.installDir, "resources", "ade-cli", "cli.cjs"), "brain", "start", "--json"],
    { env: appCliEnv(plan, env), encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  if (result.status === 0) return { ok: true, detail: "" };
  let message: string | null = null;
  try {
    const parsed = JSON.parse(result.stdout ?? "") as { message?: unknown };
    message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
  } catch {
    // Not JSON: an early failure before the CLI could answer.
  }
  const lastErrorLine = (result.stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  return { ok: false, detail: result.error?.message ?? message ?? lastErrorLine ?? `exit ${result.status}` };
}

/**
 * The Windows half of `brain update --apply-staged`: when a stable desktop app
 * is installed, the update is that app's installer and nothing else. Returns
 * the finished outcome, or (no app here) why the app was left alone so the
 * caller can go on with a runtime-only update and say so.
 *
 * The app owns this machine's brain. Pointing its service at the standalone
 * runtime would be undone the next time the app starts, and a failed swap left
 * the service naming a deleted file.
 */
export async function applyWindowsDesktopUpdate(args: {
  targetVersion: string;
  repo: string;
  stagingDir: string;
  env: NodeJS.ProcessEnv;
  downloadFile: (url: string, outPath: string) => Promise<void>;
  stopService: () => { ok: boolean; message: string };
  writeStatus: (state: "applying" | "succeeded" | "failed", message: string, error?: string) => Promise<void>;
}): Promise<
  | { finished: { ok: boolean; applied: boolean; message: string } }
  | { runtimeOnly: string }
> {
  const decision = planWindowsDesktopRescue({ env: args.env, targetVersion: args.targetVersion });
  if ("skipped" in decision) {
    if (decision.reason === "no_app") return { runtimeOnly: decision.skipped };
    const ok = decision.reason === "app_current";
    const message = ok
      ? `Nothing to install: ${decision.skipped}.`
      : `The ADE app was not updated because ${decision.skipped}. Nothing was changed.`;
    await args.writeStatus(ok ? "succeeded" : "failed", message, ok ? undefined : message);
    return { finished: { ok, applied: false, message } };
  }
  const { plan } = decision;
  await args.writeStatus("applying", `Updating the ADE app from ${plan.installedVersion} to ${plan.targetVersion}.`);
  const outcome = await runWindowsDesktopRescue(plan, {
    repo: args.repo,
    stagingDir: args.stagingDir,
    env: args.env,
    downloadFile: args.downloadFile,
    stopService: args.stopService,
    onStep: (message) => args.writeStatus("applying", message),
  });
  await args.writeStatus(outcome.ok ? "succeeded" : "failed", outcome.message, outcome.ok ? undefined : outcome.message);
  return { finished: { ok: outcome.ok, applied: outcome.ok, message: outcome.message } };
}
