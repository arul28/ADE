import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";
import { releaseAssetUrl } from "../lib/releaseAssets";
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
const UPDATE_FEED_ASSET = "latest.yml";

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

async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("base64");
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
  if (facts.appStatus === "Valid" && facts.installerSubject !== facts.appSubject) {
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

function runInstaller(installerPath: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(installerPath, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
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
  // The installer stops whatever still runs from the install folder, and its
  // setup step registers and starts the new build's background service.
  const exitCode = await runInstaller(installerPath, ["--updated", "/S", ...(reopen ? ["--force-run"] : [])]);
  if (exitCode === 0) {
    return { ok: true, message: `Installed ADE ${plan.targetVersion}; its background service is starting.` };
  }

  // The old app is still in place. Put its service back so the machine stays
  // reachable, using that app's own CLI so the service runs the app's brain.
  const restore = spawnSync(
    plan.appExe,
    [path.win32.join(plan.installDir, "resources", "ade-cli", "cli.cjs"), "serve", "--install-service"],
    { env: { ...args.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  const restored = restore.status === 0 ? "Its previous background service was restarted." : "Restarting its previous background service also failed.";
  return {
    ok: false,
    message: `The ADE ${plan.targetVersion} installer ${exitCode === null ? "did not finish" : `exited with code ${exitCode}`}. ${restored}`,
  };
}
