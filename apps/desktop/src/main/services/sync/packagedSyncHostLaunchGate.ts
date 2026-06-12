import { app, clipboard, dialog } from "electron";
import {
  detectSyncHostSingletonConflict,
  isSameChannelSyncHostOwner,
  type SyncHostSingletonConflict,
} from "../../../../../ade-cli/src/services/sync/syncHostSingleton";

export type PackagedSyncHostConflictDialogContent = {
  title: string;
  message: string;
  detail: string;
  quitCommand: string;
};

export function resolveLaunchingDesktopAppName(
  channel: "alpha" | "beta" | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.ADE_DESKTOP_APP_NAME?.trim();
  if (fromEnv) return fromEnv;
  if (channel === "alpha") return "ADE Alpha";
  if (channel === "beta") return "ADE Beta";
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

export function detectCrossChannelSyncHostConflict(
  env: NodeJS.ProcessEnv = process.env,
): SyncHostSingletonConflict | null {
  return resolveCrossChannelSyncHostConflict(detectSyncHostSingletonConflict(), env);
}

export function buildPackagedSyncHostConflictDialogContent(args: {
  launchingAppName: string;
  conflict: SyncHostSingletonConflict;
}): PackagedSyncHostConflictDialogContent {
  const owner = args.conflict.owner;
  const ownerName = owner.appName ?? "ADE";
  const portText = owner.port != null ? ` on sync port ${owner.port}` : "";
  const pidText = Number.isFinite(owner.pid) && owner.pid > 0 ? `pid ${owner.pid}` : "unknown pid";
  const quitCommand = owner.quitCommand.trim();

  return {
    title: `Cannot launch ${args.launchingAppName}`,
    message: `${ownerName} is already running with phone sync.`,
    detail: [
      "Only one official ADE build can host phone sync at a time.",
      "",
      `Running now: ${ownerName} (${pidText})${portText}.`,
      `Quit that brain before launching ${args.launchingAppName}.`,
      "",
      "Run this in Terminal:",
      quitCommand,
      "",
      `The command has been copied to your clipboard. Relaunch ${args.launchingAppName} after it finishes.`,
    ].join("\n"),
    quitCommand,
  };
}

export type PackagedSyncHostLaunchGateDeps = {
  isPackaged: boolean;
  channel: "alpha" | "beta" | null;
  env?: NodeJS.ProcessEnv;
  detectConflict?: (env: NodeJS.ProcessEnv) => SyncHostSingletonConflict | null | undefined;
  showDialog?: (content: PackagedSyncHostConflictDialogContent) => void;
  copyToClipboard?: (text: string) => void;
  quit?: () => void;
};

export function blockPackagedLaunchForCrossChannelSyncConflict(
  deps: PackagedSyncHostLaunchGateDeps,
): boolean {
  const env = deps.env ?? process.env;
  if (!deps.isPackaged) return false;
  if (env.NODE_ENV === "test") return false;
  if (env.ADE_DISABLE_SYNC_HOST_LAUNCH_GATE === "1") return false;

  const rawConflict = deps.detectConflict
    ? deps.detectConflict(env) ?? null
    : detectSyncHostSingletonConflict();
  const conflict = resolveCrossChannelSyncHostConflict(rawConflict, env);
  if (!conflict) return false;

  const content = buildPackagedSyncHostConflictDialogContent({
    launchingAppName: resolveLaunchingDesktopAppName(deps.channel, env),
    conflict,
  });

  (deps.copyToClipboard ?? ((text) => clipboard.writeText(text)))(content.quitCommand);
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
