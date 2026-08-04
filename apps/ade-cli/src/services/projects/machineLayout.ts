import os from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MachineAdeLayout = {
  adeDir: string;
  projectsPath: string;
  secretsDir: string;
  sockDir: string;
  socketPath: string;
  /**
   * Side-channel JSON-RPC socket for Electron-main-only domains
   * (currently `built_in_browser`). Hosted by the desktop main process; the
   * runtime daemon proxies calls through here when present. The runtime daemon
   * cannot host these domains itself because they need Electron APIs
   * (WebContentsView, etc.) that aren't available under ELECTRON_RUN_AS_NODE.
   */
  desktopBridgeSocketPath: string;
  binDir: string;
  runtimeDir: string;
  personalChatsDir?: string;
  personalChatsStateRoot?: string;
  personalChatsWorkspaceRoot?: string;
};

export function resolveMachineAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".ade");
}

function windowsUserIdentity(env: NodeJS.ProcessEnv): string {
  const sid = env.ADE_WINDOWS_USER_SID?.trim() || env.USER_SID?.trim();
  if (sid) return `sid:${sid.toLowerCase()}`;
  const username = env.USERNAME?.trim();
  const domain = env.USERDOMAIN?.trim();
  if (username) {
    return `account:${domain ? `${domain}\\` : ""}${username}`.toLowerCase();
  }
  const profile = env.USERPROFILE?.trim();
  if (profile) {
    return `profile:${path.win32.resolve(profile).toLowerCase()}`;
  }
  const userInfo = os.userInfo();
  return `fallback:${userInfo.username}\0${userInfo.homedir}`.toLowerCase();
}

function windowsChannelIdentity(adeDir: string, env: NodeJS.ProcessEnv): {
  identity: string;
  label: string;
} {
  const serviceName = env.ADE_RUNTIME_SERVICE_NAME?.trim().toLowerCase();
  const explicitChannel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  const homeName = path.win32.basename(adeDir).toLowerCase();
  const inferred = homeName === ".ade-alpha"
    ? "alpha"
    : homeName === ".ade-beta"
      ? "beta"
      : homeName === ".ade"
        ? "stable"
        : "custom";
  const label = explicitChannel === "alpha" || explicitChannel === "beta"
    ? explicitChannel
    : explicitChannel === "stable"
      ? "stable"
      : serviceName?.endsWith(".alpha")
        ? "alpha"
        : serviceName?.endsWith(".beta")
          ? "beta"
          : serviceName === "com.ade.runtime"
            ? "stable"
            : inferred;
  return {
    identity: serviceName || explicitChannel || inferred,
    label,
  };
}

/**
 * The on-disk casing of `value`, for the components that exist. Components that
 * do not exist yet can only be re-joined as they were given.
 */
function canonicalWindowsPath(value: string): string {
  const original = path.win32.resolve(value).replace(/\//g, "\\");
  const missingParts: string[] = [];
  let cursor = original;
  for (;;) {
    try {
      return path.win32.join(fs.realpathSync.native(cursor), ...missingParts);
    } catch {
      const parent = path.win32.dirname(cursor);
      if (parent === cursor) return original;
      missingParts.unshift(path.win32.basename(cursor));
      cursor = parent;
    }
  }
}

function windowsPipeIdentity(
  adeDir: string,
  env: NodeJS.ProcessEnv,
): { channelLabel: string; hash: string } {
  const canonicalAdeDir = canonicalWindowsPath(adeDir);
  const channel = windowsChannelIdentity(canonicalAdeDir, env);
  // Case-FOLD the path before hashing. `canonicalWindowsPath` returns the real
  // on-disk casing for the components that exist and the caller's casing for
  // the ones that do not, so the two disagree across the exact moment ADE_HOME
  // is created: `ADE_HOME=C:\Users\x\.ADE` hashed the given ".ADE" before the
  // directory existed and whatever the filesystem recorded afterwards. A daemon
  // started inside that window listened on pipe A while every later CLI
  // computed pipe B -- an orphaned, unreachable brain. Windows path components
  // are case-insensitive, so folding loses nothing and is the only spelling
  // that is stable on both sides of that moment.
  const hash = createHash("sha256")
    .update(`${canonicalAdeDir.toLowerCase()}\0${channel.identity}\0${windowsUserIdentity(env)}`)
    .digest("hex")
    .slice(0, 16);
  return { channelLabel: channel.label, hash };
}

function windowsPipePath(
  prefix: "ade-runtime" | "ade-desktop-bridge",
  adeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const identity = windowsPipeIdentity(adeDir, env);
  return `\\\\.\\pipe\\${prefix}-${identity.channelLabel}-${identity.hash}`;
}

export function resolveMachineAdeLayout(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): MachineAdeLayout {
  const adeDir = resolveMachineAdeDir(env);
  const pipeAdeDir = env.ADE_HOME?.trim() || adeDir;
  const secretsDir = path.join(adeDir, "secrets");
  const sockDir = path.join(adeDir, "sock");
  const socketPath = platform === "win32"
    ? windowsPipePath("ade-runtime", pipeAdeDir, env)
    : path.join(sockDir, "ade.sock");
  const desktopBridgeSocketPath = platform === "win32"
    ? windowsPipePath("ade-desktop-bridge", pipeAdeDir, env)
    : path.join(sockDir, "desktop-bridge.sock");
  return {
    adeDir,
    projectsPath: path.join(adeDir, "projects.json"),
    secretsDir,
    sockDir,
    socketPath,
    desktopBridgeSocketPath,
    binDir: path.join(adeDir, "bin"),
    runtimeDir: path.join(adeDir, "runtime"),
    personalChatsDir: path.join(adeDir, "personal-chats"),
    personalChatsStateRoot: path.join(adeDir, "personal-chats", "state"),
    personalChatsWorkspaceRoot: path.join(adeDir, "personal-chats", "workspaces"),
  };
}
