import os from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathsEqual } from "../../../../desktop/src/main/services/shared/pathCompare";

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

/** True only when machine state resolves to the user's default ADE home. */
export function isMachineAdeHome(adeDir: string, machineHome = resolveMachineAdeDir({})): boolean {
  const actual = path.resolve(adeDir);
  const expected = path.resolve(machineHome);
  return process.platform === "darwin" || process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

/**
 * Whether a brain in this home may run machine sync: the user's default home,
 * or a packaged channel (Alpha, Beta) in its own channel home.
 *
 * Any other home is an isolated copy of machine state (a scratch home, a
 * hand-started brain) whose device identity must not claim the projects it
 * shares with the real brain. A channel build is not that: it is the way a
 * build is tested end to end, phone included, and the sync-host singleton
 * already keeps two channels from syncing at once. Dev apps never get here
 * with sync on; their launcher starts the brain with `--no-sync`.
 */
export function isSyncCapableAdeHome(adeDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isMachineAdeHome(adeDir)) return true;
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel !== "alpha") return false;
  return isMachineAdeHome(adeDir, adeHomeForChannel(channel));
}

/**
 * The default ADE home of a package channel: `~/.ade` or `~/.ade-alpha`. Beta
 * is an update track of the normal install and uses `~/.ade`.
 */
export function adeHomeForChannel(channel: string | null): string {
  if (channel === "alpha") return path.join(os.homedir(), ".ade-alpha");
  return path.join(os.homedir(), ".ade");
}

let cachedWindowsTokenUser: { profile: string | null; username: string | null } | undefined;

/**
 * The account that owns this process's Windows token, as libuv reads it
 * (`GetUserProfileDirectoryW` / `GetUserNameW` on the process token). No
 * environment variable can change it, and no child process is spawned.
 * Memoized: a process cannot change the account it runs as.
 */
function windowsTokenUser(): { profile: string | null; username: string | null } {
  if (cachedWindowsTokenUser) return cachedWindowsTokenUser;
  let profile: string | null = null;
  let username: string | null = null;
  try {
    const info = os.userInfo();
    const home = info.homedir?.trim();
    profile = home ? path.win32.resolve(home).toLowerCase() : null;
    username = info.username?.trim() || null;
  } catch {
    // A token without a loaded profile: fall back to the environment below.
  }
  cachedWindowsTokenUser = { profile, username };
  return cachedWindowsTokenUser;
}

/**
 * The Windows user a pipe name belongs to: the profile folder of the account
 * that owns this process.
 *
 * Pipe names used to hash `USERDOMAIN\USERNAME` from the environment, and the
 * environment does not say who the user is. OpenSSH gives an account
 * `USERDOMAIN=WORKGROUP` where its desktop logon has the machine name, so
 * `ade brain status` over SSH dialed a pipe the running brain never opened
 * (reproduced 2026-10-28). The profile folder of the token is the same for
 * every logon of one account (desktop, SSH, scheduled task, service, `runas`)
 * and differs between accounts: Windows gives each SID its own folder and
 * appends `.DOMAIN` or `.000` on a clash. It stands in for the SID, which Node
 * cannot read without spawning `whoami` on a hot path.
 *
 * A non-Windows host has no Windows token; when it computes a Windows layout,
 * the profile named in the env it was given stands for it.
 */
function windowsUserIdentity(env: NodeJS.ProcessEnv): string {
  const tokenProfile = process.platform === "win32" ? windowsTokenUser().profile : null;
  if (tokenProfile) return `user-profile:${tokenProfile}`;
  const envProfile = env.USERPROFILE?.trim();
  if (envProfile) return `user-profile:${path.win32.resolve(envProfile).toLowerCase()}`;
  return legacyWindowsUserIdentity(env);
}

/** The env-based user identity ADE up to v1.2.125 hashed into its pipe names. */
function legacyWindowsUserIdentity(env: NodeJS.ProcessEnv): string {
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

/**
 * Every user identity an older ADE of this account may have hashed, the exact
 * one for this env first.
 *
 * An older brain or desktop computed its name from the env of the session that
 * started it, which this session cannot see. What that env can differ in is
 * small: the domain is the machine name at the desktop, `WORKGROUP` over
 * OpenSSH, or empty in some service contexts. So the variants are tried over
 * those domains for this account's name.
 */
function legacyWindowsUserIdentities(env: NodeJS.ProcessEnv): string[] {
  const identities = new Set<string>([legacyWindowsUserIdentity(env)]);
  const usernames = new Set<string>();
  const envUsername = env.USERNAME?.trim();
  if (envUsername) usernames.add(envUsername);
  const tokenUsername = process.platform === "win32" ? windowsTokenUser().username : null;
  if (tokenUsername) usernames.add(tokenUsername);
  const domains = new Set<string>();
  for (const domain of [env.USERDOMAIN, env.COMPUTERNAME, env.USERDOMAIN_ROAMINGPROFILE, "WORKGROUP"]) {
    const trimmed = domain?.trim();
    if (trimmed) domains.add(trimmed);
  }
  for (const username of usernames) {
    for (const domain of domains) identities.add(`account:${domain}\\${username}`.toLowerCase());
    identities.add(`account:${username}`.toLowerCase());
  }
  return [...identities];
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
    : homeName === ".ade"
      ? "stable"
      : "custom";
  const label = explicitChannel === "alpha"
    ? explicitChannel
    : explicitChannel === "stable"
      ? "stable"
      : serviceName?.endsWith(".alpha")
        ? "alpha"
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

type WindowsPipeIdentityBase = { canonicalAdeDir: string; channel: { identity: string; label: string } };

function windowsPipeIdentityBase(adeDir: string, env: NodeJS.ProcessEnv): WindowsPipeIdentityBase {
  const canonicalAdeDir = canonicalWindowsPath(adeDir);
  return { canonicalAdeDir, channel: windowsChannelIdentity(canonicalAdeDir, env) };
}

function windowsPipeHash(base: WindowsPipeIdentityBase, userIdentity: string): string {
  // Case-FOLD the path before hashing. `canonicalWindowsPath` returns the real
  // on-disk casing for the components that exist and the caller's casing for
  // the ones that do not, so the two disagree across the exact moment ADE_HOME
  // is created: `ADE_HOME=C:\Users\x\.ADE` hashed the given ".ADE" before the
  // directory existed and whatever the filesystem recorded afterwards. A daemon
  // started inside that window listened on pipe A while every later CLI
  // computed pipe B -- an orphaned, unreachable brain. Windows path components
  // are case-insensitive, so folding loses nothing and is the only spelling
  // that is stable on both sides of that moment.
  return createHash("sha256")
    .update(`${base.canonicalAdeDir.toLowerCase()}\0${base.channel.identity}\0${userIdentity}`)
    .digest("hex")
    .slice(0, 16);
}

type WindowsPipePrefix = "ade-runtime" | "ade-desktop-bridge";

function windowsPipeName(prefix: WindowsPipePrefix, base: WindowsPipeIdentityBase, hash: string): string {
  return `\\\\.\\pipe\\${prefix}-${base.channel.label}-${hash}`;
}

function windowsPipePath(
  prefix: WindowsPipePrefix,
  adeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const base = windowsPipeIdentityBase(adeDir, env);
  return windowsPipeName(prefix, base, windowsPipeHash(base, windowsUserIdentity(env)));
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

/**
 * Every name this machine's brain endpoints answer on, the current name first.
 *
 * Off Windows there is one socket per endpoint. On Windows the current name is
 * keyed on the account's profile folder, and the rest are the names ADE up to
 * v1.2.125 derived from `USERDOMAIN\\USERNAME` (see
 * `legacyWindowsUserIdentities`). A brain on the current name also listens on
 * those, so an older `ade` or desktop still reaches it, and a newer client
 * that finds no current name dials them, so it still reaches an older brain.
 * The brain also refuses to start while any of them is taken, which keeps an
 * older and a newer brain from both running on one ADE home.
 */
export function resolveMachineEndpointNames(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { runtime: string[]; desktopBridge: string[] } {
  if (platform !== "win32") {
    const layout = resolveMachineAdeLayout(env, platform);
    return { runtime: [layout.socketPath], desktopBridge: [layout.desktopBridgeSocketPath] };
  }
  const base = windowsPipeIdentityBase(env.ADE_HOME?.trim() || resolveMachineAdeDir(env), env);
  const hashes = new Set<string>([windowsPipeHash(base, windowsUserIdentity(env))]);
  for (const identity of legacyWindowsUserIdentities(env)) hashes.add(windowsPipeHash(base, identity));
  return {
    runtime: [...hashes].map((hash) => windowsPipeName("ade-runtime", base, hash)),
    desktopBridge: [...hashes].map((hash) => windowsPipeName("ade-desktop-bridge", base, hash)),
  };
}

/** One spelling per Windows pipe: `/` and `\\` are the same separator, and names ignore case. */
function windowsPipeKey(value: string): string {
  return value.trim().replace(/\//g, "\\").toLowerCase();
}

/**
 * Whether `socketPath` is one of `names` (a `resolveMachineEndpointNames`
 * list). A socket path is compared as a file path, by the platform's case
 * rules; a named pipe has no file to resolve and is compared by name.
 */
export function isMachineEndpointName(socketPath: string, names: readonly string[]): boolean {
  if (!/^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(socketPath.trim())) {
    const resolved = path.resolve(socketPath);
    return names.some((name) => pathsEqual(path.resolve(name), resolved));
  }
  const key = windowsPipeKey(socketPath);
  return names.some((name) => windowsPipeKey(name) === key);
}

/**
 * The first of `names` that some process is listening on now, or null.
 *
 * Reads the pipe namespace (`\\\\.\\pipe\\`) once, which lists names without
 * opening any of them: dialing a pipe to test it would take a connection from
 * its server. Off Windows, or when the listing fails, it answers null.
 */
export function findListeningWindowsPipe(names: readonly string[]): string | null {
  if (process.platform !== "win32" || names.length === 0) return null;
  let listed: Set<string>;
  try {
    listed = new Set(fs.readdirSync("\\\\.\\pipe\\").map((name) => name.toLowerCase()));
  } catch {
    return null;
  }
  const prefix = "\\\\.\\pipe\\";
  return names.find((name) => {
    const key = windowsPipeKey(name);
    return key.startsWith(prefix) && listed.has(key.slice(prefix.length));
  }) ?? null;
}

/**
 * Whether `name` has the shape of a machine brain pipe of this ADE home's
 * channel, under any user identity: `\\.\pipe\ade-runtime-<channel>-<16 hex>`
 * and nothing after it. The desktop's isolated brain appends
 * `-<version>-<build>` to the machine name, so it never matches: it is a
 * second brain on purpose, not the machine brain on a name this process does
 * not derive. False off Windows, where there are no pipe names.
 */
export function isChannelRuntimePipeName(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const { label } = windowsPipeIdentityBase(env.ADE_HOME?.trim() || resolveMachineAdeDir(env), env).channel;
  const prefix = windowsPipeKey(`\\\\.\\pipe\\ade-runtime-${label}-`);
  const key = windowsPipeKey(name);
  return key.startsWith(prefix) && /^[0-9a-f]{16}$/.test(key.slice(prefix.length));
}

function resolveReachableMachineEndpoint(names: readonly string[]): string {
  if (names.length < 2) return names[0]!;
  return findListeningWindowsPipe(names) ?? names[0]!;
}

/**
 * The brain endpoint a client should dial: the current name, or an older name
 * when only an older brain is listening (see `resolveMachineEndpointNames`).
 * Anything that connects to the machine brain without an explicit socket goes
 * through this; `resolveMachineAdeLayout().socketPath` stays the name a brain
 * starts on.
 */
export function resolveReachableMachineRuntimeSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveReachableMachineEndpoint(resolveMachineEndpointNames(env, platform).runtime);
}

/** `resolveReachableMachineRuntimeSocketPath` for the desktop app's bridge. */
export function resolveReachableMachineDesktopBridgeSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveReachableMachineEndpoint(resolveMachineEndpointNames(env, platform).desktopBridge);
}

/** The brain's machine log: every brain on this ADE home writes it, and error reports read its tail. */
export function brainLogPath(layout: Pick<MachineAdeLayout, "runtimeDir"> = resolveMachineAdeLayout()): string {
  return path.join(layout.runtimeDir, "brain.jsonl");
}
