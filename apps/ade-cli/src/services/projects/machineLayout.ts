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

/**
 * Release channels that own a machine home of their own. Data-driven so adding
 * a channel is one entry here rather than a new branch in three places.
 */
const CHANNEL_ADE_HOME_NAMES = ["alpha", "beta"] as const;

/** How each channel spells itself in the app bundle it ships as. */
const CHANNEL_APP_BUNDLE_NAMES: Record<AdeReleaseChannel, string> = {
  alpha: "ADE Alpha",
  beta: "ADE Beta",
};

type AdeReleaseChannel = (typeof CHANNEL_ADE_HOME_NAMES)[number];

/** Why `resolveMachineAdeDirWithReason` landed on the directory it returned. */
export type MachineAdeDirReason = "env" | "channel-env" | "bundle" | "default";

export type MachineAdeDirResolution = {
  dir: string;
  reason: MachineAdeDirReason;
  /** The signal the reason was read from, for anything that reports this. */
  detail?: string;
};

function channelAdeDir(channel: AdeReleaseChannel): string {
  return path.join(os.homedir(), `.ade-${channel}`);
}

function parseAdeReleaseChannel(value: string | null | undefined): AdeReleaseChannel | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return CHANNEL_ADE_HOME_NAMES.find((channel) => channel === normalized) ?? null;
}

/**
 * The `Name.app` bundle `entryPath` runs out of, or null.
 *
 * Split by hand rather than with `path.basename`, because the value can carry
 * either separator and this has to read the same on every platform.
 */
function appBundleNameOf(entryPath: string): string | null {
  const match = /^(.*?)\.app(?:[/\\]|$)/.exec(entryPath);
  const prefix = match?.[1];
  if (prefix == null) return null;
  const parts = prefix.split(/[/\\]/);
  return parts[parts.length - 1] ?? null;
}

/**
 * The release channel of the app bundle this CLI is running out of, or null.
 *
 * A packaged channel build exports `ADE_HOME` to everything it spawns, so this
 * is a backstop -- but a needed one: the Cursor SDK worker stripped `ADE_HOME`
 * from its environment, and the Alpha `ade` it injected then resolved the
 * STABLE machine home. The agent was living inside `ADE Alpha.app` and its CLI
 * could not reach the Alpha brain at all. The bundle a binary sits in is the
 * one channel signal no env scrubbing can take away.
 *
 * `ADE.app` carries no channel word and must fall through to `~/.ade`, so the
 * match is on the exact product names channel builds ship under.
 */
function channelFromAppBundlePath(entryPath: string | null | undefined): AdeReleaseChannel | null {
  const trimmed = entryPath?.trim();
  if (!trimmed) return null;
  const bundleName = appBundleNameOf(trimmed)?.toLowerCase();
  if (!bundleName) return null;
  return CHANNEL_ADE_HOME_NAMES.find(
    (channel) => bundleName === CHANNEL_APP_BUNDLE_NAMES[channel].toLowerCase(),
  ) ?? null;
}

/**
 * The machine home this process reads, and the signal that decided it.
 *
 * Callers that only need the directory use `resolveMachineAdeDir`; `ade doctor`
 * needs the reason too, because "which home" was never the confusing part --
 * "why THAT home" was, and a row that prints only the path reads the same
 * whether the value was chosen or defaulted into.
 */
export function resolveMachineAdeDirWithReason(
  env: NodeJS.ProcessEnv = process.env,
  entryPath: string | null = typeof process.argv[1] === "string" ? process.argv[1] : null,
  platform: NodeJS.Platform = process.platform,
): MachineAdeDirResolution {
  const explicit = env.ADE_HOME?.trim();
  if (explicit) return { dir: path.resolve(explicit), reason: "env", detail: "$ADE_HOME" };

  const explicitChannel = parseAdeReleaseChannel(env.ADE_PACKAGE_CHANNEL);
  if (explicitChannel) {
    return {
      dir: channelAdeDir(explicitChannel),
      reason: "channel-env",
      detail: `$ADE_PACKAGE_CHANNEL=${explicitChannel}`,
    };
  }

  // App bundles are a macOS shape. On Windows a channel install is told apart
  // by its service name and product name, and sniffing `.app` there could only
  // ever misfire on a directory that happens to be spelled that way.
  if (platform !== "win32") {
    const bundleChannel = channelFromAppBundlePath(entryPath);
    if (bundleChannel) {
      return {
        dir: channelAdeDir(bundleChannel),
        reason: "bundle",
        detail: `${CHANNEL_APP_BUNDLE_NAMES[bundleChannel]}.app`,
      };
    }
  }

  return { dir: path.join(os.homedir(), ".ade"), reason: "default" };
}

export function resolveMachineAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMachineAdeDirWithReason(env).dir;
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
 *
 * Exported because the hardware anchor folds the same ADE home path into its
 * hash and must agree with the pipe identity on what one path IS: `realpath`
 * also expands 8.3 short names (`C:\Users\ADAOBI~1\.ade`) and resolves junction
 * casing, so two spellings of one directory cannot become two machines.
 */
export function canonicalWindowsPath(value: string): string {
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
