import { app, clipboard, dialog } from "electron";
import {
  detectSyncHostSingletonConflictAsync,
  isSameChannelSyncHostOwner,
  type SyncHostProbeRunner,
  type SyncHostSingletonConflict,
  type SyncHostSingletonOwner,
} from "../../../../../ade-cli/src/services/sync/syncHostSingleton";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";
import { BRAND } from "../../../shared/brand";
import { installedDesktopAppDisplayName } from "../../../shared/packageChannel";

export type PackagedSyncHostConflictDialogContent = {
  title: string;
  message: string;
  detail: string;
  quitCommand: string;
};

export function resolveLaunchingDesktopAppName(
  channel: "alpha" | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.ADE_DESKTOP_APP_NAME?.trim();
  if (fromEnv) return fromEnv;
  if (channel === "alpha") return "ADE Alpha";
  return "ADE";
}

export function resolveCrossChannelSyncHostConflict(
  conflict: SyncHostSingletonConflict | null,
  env: NodeJS.ProcessEnv = process.env,
): SyncHostSingletonConflict | null {
  if (!conflict) return null;
  if (isSameChannelSyncHostOwner(conflict.owner, env)) return null;
  return conflict;
}

/** The owner-identity probe as a PowerShell child spawned off the main thread. */
const runWindowsProbeOffThread: SyncHostProbeRunner = (command, args, timeoutMs, maxBuffer) =>
  execFileOffThread(command, args, { timeoutMs, maxBuffer }).then((result) => ({
    stdout: result.stdout,
    failed: result.error !== null || result.exitCode !== 0,
  }));

/**
 * This gate runs at the top of `app.whenReady()`, before any window exists, so
 * everything it does is charged directly against time-to-first-paint.
 *
 * On Windows the native listener scan is a full-machine `Get-NetTCPConnection`
 * joined to `Get-CimInstance Win32_Process` via a PowerShell spawn -- strictly
 * heavier than the ~2.7s `runtime service-status` round trip measured on this
 * hardware, with a 15s ceiling. It would run on every packaged launch, since the
 * lock-file check short-circuits only when it already found a conflict. That is
 * the same class of pre-paint main-thread block this branch set out to remove.
 *
 * So on Windows the gate skips the listener scan and answers from the lock file.
 * The downgrade: a brain that holds phone sync without a usable lock file
 * (missing, unreadable, or another lock version) is not seen at launch, so two
 * channels can briefly both hold phone sync. A hard-killed brain's lock is cleared
 * once its PID is dead. Every current build writes the lock, so the missing-lock
 * case is the legacy one only -- and `ade serve` still runs the full scan when it
 * starts a brain, where the cost is bounded and nothing is waiting to paint.
 * Documented in docs/development/windows-support.md.
 *
 * The one process probe left is the owner-identity check that rejects a reused
 * PID, and it runs off the main thread. For a live owner on ANOTHER channel the
 * launch awaits it, because that verdict decides whether to block. A same-channel
 * owner is never blocked, so the launch does not wait for its check: the check
 * runs in the background and only clears a stale lock.
 */
export async function detectCrossChannelSyncHostConflict(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SyncHostSingletonConflict | null> {
  const conflict = await detectSyncHostSingletonConflictAsync(
    { skipListenerScan: platform === "win32" },
    {
      ignoreOwner: (owner: SyncHostSingletonOwner) => isSameChannelSyncHostOwner(owner, env),
      ...(offThreadSpawnEnabled(env) ? { runProbe: runWindowsProbeOffThread } : {}),
    },
  );
  return resolveCrossChannelSyncHostConflict(conflict, env);
}

export function buildPackagedSyncHostConflictDialogContent(args: {
  launchingAppName: string;
  conflict: SyncHostSingletonConflict;
}): PackagedSyncHostConflictDialogContent {
  const owner = args.conflict.owner;
  // App names name the install on disk (ADE.app); the dialog shows their Daex names.
  const ownerName = installedDesktopAppDisplayName(owner.appName ?? "ADE");
  const launchingAppName = installedDesktopAppDisplayName(args.launchingAppName);
  const portText = owner.port != null ? ` on sync port ${owner.port}` : "";
  const pidText = Number.isFinite(owner.pid) && owner.pid > 0 ? `pid ${owner.pid}` : "unknown pid";
  const quitCommand = owner.quitCommand.trim();

  return {
    title: `Cannot launch ${launchingAppName}`,
    message: `${ownerName} is already running with phone sync.`,
    detail: [
      `Only one official ${BRAND.NAME} build can host phone sync at a time.`,
      "",
      `Running now: ${ownerName} (${pidText})${portText}.`,
      `Quit that brain before launching ${launchingAppName}.`,
      "",
      "Run this in Terminal:",
      quitCommand,
      "",
      `The command has been copied to your clipboard. Relaunch ${launchingAppName} after it finishes.`,
    ].join("\n"),
    quitCommand,
  };
}

/** Whether this launch runs the gate at all: a packaged app, not a test, not switched off. */
function launchGateApplies(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return isPackaged && env.NODE_ENV !== "test" && env.ADE_DISABLE_SYNC_HOST_LAUNCH_GATE !== "1";
}

/**
 * Starts the conflict check before `app.whenReady()`. It needs no Electron API,
 * only the lock file and the `lsof`/`ps` listener scan, so it runs while
 * Chromium starts, and the gate at ready reads its answer instead of waiting
 * for those processes before the first window (up to ~75 ms on a cold disk).
 * Null when the gate does not apply. Call it after the channel defaults are in
 * the environment: the same-channel test reads them.
 */
export function startCrossChannelSyncHostConflictCheck(args: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<SyncHostSingletonConflict | null> | null {
  const env = args.env ?? process.env;
  if (!launchGateApplies(args.isPackaged, env)) return null;
  const pending = detectCrossChannelSyncHostConflict(env, args.platform);
  // Awaited at ready, which rethrows as the gate always did; this only keeps a
  // failure before then from being reported as an unhandled rejection.
  pending.catch(() => {});
  return pending;
}

export type PackagedSyncHostLaunchGateDeps = {
  isPackaged: boolean;
  channel: "alpha" | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detectConflict?: (env: NodeJS.ProcessEnv) => SyncHostSingletonConflict | null | undefined;
  /** The check `startCrossChannelSyncHostConflictCheck` began before ready; when absent, the gate runs it now. */
  pendingConflict?: Promise<SyncHostSingletonConflict | null> | null;
  showDialog?: (content: PackagedSyncHostConflictDialogContent) => void;
  copyToClipboard?: (text: string) => void | Promise<void>;
  quit?: () => void;
};

export async function blockPackagedLaunchForCrossChannelSyncConflict(
  deps: PackagedSyncHostLaunchGateDeps,
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!launchGateApplies(deps.isPackaged, env)) return false;

  // See `detectCrossChannelSyncHostConflict` for why Windows answers from the
  // lock file on this path and awaits its identity probe off the main thread.
  const pending = deps.detectConflict ? null : deps.pendingConflict;
  const conflict = deps.detectConflict
    ? resolveCrossChannelSyncHostConflict(deps.detectConflict(env) ?? null, env)
    : pending
      ? await pending
      : await detectCrossChannelSyncHostConflict(env, deps.platform);
  if (!conflict) return false;
  // The early check runs while Chromium starts, so the other channel can exit
  // before ready. Only a positive answer is re-read (a fast lock-file probe):
  // its stale "already running" would quit this launch for nothing.
  if (pending && !(await detectCrossChannelSyncHostConflict(env, deps.platform))) return false;

  const content = buildPackagedSyncHostConflictDialogContent({
    launchingAppName: resolveLaunchingDesktopAppName(deps.channel, env),
    conflict,
  });

  // Land the quit command before the dialog blocks and the app quits; a
  // clipboard failure must not stop the dialog.
  await Promise.resolve((deps.copyToClipboard ?? ((text) => clipboard.writeText(text)))(content.quitCommand)).catch(() => {});
  (deps.showDialog ?? showPackagedSyncHostConflictDialog)(content);
  (deps.quit ?? (() => app.quit()))();
  return true;
}

export function showPackagedSyncHostConflictDialog(
  content: PackagedSyncHostConflictDialogContent,
): void {
  dialog.showMessageBoxSync({
    type: "error",
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
    title: content.title,
    message: content.message,
    detail: content.detail,
  });
}
