/**
 * Start an `npx <package>` MCP server without npm's launcher process.
 *
 * `npx` keeps a whole npm CLI (`npm exec ...`) alive as the parent of the
 * server for as long as the server runs, and for a tag or bare name it asks
 * the registry first. Measured on macOS for `npx @playwright/mcp@latest`: two
 * processes, ~290 MB fresh, 1.3-1.8 s to `tools/list`; the same installed
 * package run with `node` is one process, ~104 MB, 0.2-0.4 s. Every chat
 * carries its own copy, so the launcher is paid once per chat.
 *
 * The rewrite runs the exact copy npx would run: the package npx already
 * installed in its own cache, and only when that copy is the one npx would
 * pick today. Anything this cannot prove leaves the launch as it was:
 *
 * - npx flags other than `-y` / `--yes` / `-q` / `--quiet` / `--silent`,
 *   git/path/URL specs and version ranges;
 * - the package, or a command of its name, in the project tree or the global
 *   prefix (npx would run that one);
 * - a custom registry, or a registry answer this computer does not have yet
 *   (a tag or bare name is checked against the registry like npx does; an
 *   answer older than 15 minutes is refreshed in the background, one older
 *   than six hours is not used, and a launch never waits on it for longer than
 *   a moment);
 * - a bin that is not a plain `node` script.
 *
 * Nothing here writes to any config file. The rewrite is a launch-time value.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getPathEnvKey, getPathEnvValue, resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { readJson } from "./mcpProviderConfigScan";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
/** A registry answer older than this is checked again in the background. */
const LATEST_FRESH_MS = 15 * 60 * 1000;
/** A registry answer older than this is not used at all. */
const LATEST_USABLE_MS = 6 * 60 * 60 * 1000;
const LATEST_FETCH_TIMEOUT_MS = 5_000;
/** The longest a launch waits for a registry answer it does not have yet. */
const LAUNCH_WAIT_MS = 1_500;
const NPX_PASSTHROUGH_FLAGS = new Set(["-y", "--yes", "-q", "--quiet", "--silent"]);
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][\w.-]*$/;

export type NpxInvocation = {
  /** The spec exactly as written, which is also what npx hashes its cache dir from. */
  spec: string;
  name: string;
  /** An exact version, or a dist-tag (`latest` for a bare name). */
  want: { kind: "version"; version: string } | { kind: "tag"; tag: string };
  /** Arguments after the package, handed to the server unchanged. */
  rest: string[];
};

/**
 * The direct launch. `env.PATH` puts the npx install's `node_modules/.bin`
 * first, as npm's launcher does, so a server that runs one of its
 * dependencies' commands by name finds the same one.
 */
export type NpxDirectCommand = { command: string; args: string[]; env: Record<string, string> };

function isNpxCommand(command: string): boolean {
  const base = path.basename(command.trim()).toLowerCase();
  return base === "npx" || base === "npx.cmd" || base === "npx.exe";
}

/** `npx [-y] <spec> ...rest` as its parts, or null for any other shape. */
export function parseNpxInvocation(command: string, args: readonly string[]): NpxInvocation | null {
  if (!isNpxCommand(command)) return null;
  let index = 0;
  while (index < args.length && NPX_PASSTHROUGH_FLAGS.has(args[index]!)) index += 1;
  if (args[index] === "--") index += 1;
  const spec = args[index];
  if (!spec || spec.startsWith("-")) return null;
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at < 0 ? spec : spec.slice(0, at);
  const suffix = at < 0 ? "" : spec.slice(at + 1);
  if (!PACKAGE_NAME.test(name)) return null;
  let want: NpxInvocation["want"];
  if (!suffix) want = { kind: "tag", tag: "latest" };
  else if (EXACT_VERSION.test(suffix)) want = { kind: "version", version: suffix };
  else if (DIST_TAG.test(suffix) && !/^v?\d/.test(suffix)) want = { kind: "tag", tag: suffix };
  else return null;
  return { spec, name, want, rest: args.slice(index + 1) };
}

/** npx's cache folder for one package spec (libnpmexec: sha512 of the sorted specs, first 16 hex). */
export function npxCacheInstallDir(npmCacheDir: string, spec: string): string {
  return path.join(npmCacheDir, "_npx", createHash("sha512").update(spec).digest("hex").slice(0, 16));
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * `key=value` lines of an `.npmrc`, comments dropped; empty when the file
 * does not exist, null when it exists but cannot be read (its settings are
 * then unknown, so the launch stays on npx).
 */
function readNpmrc(filePath: string): Map<string, string> | null {
  const values = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? values : null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
  }
  return values;
}

type NpmSetup = {
  cacheDir: string;
  globalModulesDirs: string[];
  globalBinDirs: string[];
  customRegistryScopes: Set<string> | "all";
};

/** npm's settings for this launch, or null when one of its config files cannot be read. */
function npmSetup(env: NodeJS.ProcessEnv, homeDir: string, cwd: string, npxPath: string): NpmSetup | null {
  const isWindows = process.platform === "win32";
  // npm's built-in prefix: the folder above `bin/npx` on POSIX, the folder of
  // `npx.cmd` on Windows. Its global config is `<prefix>/etc/npmrc`.
  const npxDir = path.dirname(npxPath);
  const builtinPrefix = isWindows ? npxDir : path.dirname(npxDir);
  const projectRcs: Array<Map<string, string> | null> = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const rc = path.join(dir, ".npmrc");
    if (fileExists(rc)) projectRcs.push(readNpmrc(rc));
    if (path.dirname(dir) === dir) break;
  }
  const userRc = readNpmrc(env.NPM_CONFIG_USERCONFIG?.trim() || env.npm_config_userconfig?.trim() || path.join(homeDir, ".npmrc"));
  const globalRc = readNpmrc(env.NPM_CONFIG_GLOBALCONFIG?.trim() || env.npm_config_globalconfig?.trim() || path.join(builtinPrefix, "etc", "npmrc"));
  // npm's precedence: env, project, user, global.
  const rcs = [...projectRcs, userRc, globalRc];
  if (rcs.some((rc) => rc == null)) return null;
  const files = rcs as Array<Map<string, string>>;
  const lookup = (key: string): string | undefined =>
    env[`npm_config_${key}`]?.trim() || env[`NPM_CONFIG_${key.toUpperCase()}`]?.trim()
    || files.find((rc) => rc.has(key))?.get(key);

  let customRegistryScopes: NpmSetup["customRegistryScopes"] = new Set();
  const registry = lookup("registry");
  if (registry && registry.replace(/\/?$/, "/") !== DEFAULT_REGISTRY) customRegistryScopes = "all";
  else {
    for (const rc of files) {
      for (const key of rc.keys()) {
        const scoped = key.match(/^(@[^:]+):registry$/);
        if (scoped) customRegistryScopes.add(scoped[1]!.toLowerCase());
      }
    }
  }

  const cacheDir = lookup("cache")
    || (isWindows
      ? path.join(env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local"), "npm-cache")
      : path.join(homeDir, ".npm"));
  const prefixes = new Set<string>();
  const configuredPrefix = lookup("prefix");
  if (configuredPrefix) prefixes.add(configuredPrefix);
  // The built-in prefix, plus `%APPDATA%\npm` where `npm i -g` lands on Windows.
  prefixes.add(builtinPrefix);
  if (isWindows && env.APPDATA?.trim()) prefixes.add(path.join(env.APPDATA.trim(), "npm"));
  return {
    cacheDir,
    globalModulesDirs: [...prefixes].map((prefix) => isWindows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules")),
    // Global commands: `<prefix>/bin` on POSIX, the prefix itself on Windows.
    globalBinDirs: [...prefixes].map((prefix) => isWindows ? prefix : path.join(prefix, "bin")),
    customRegistryScopes,
  };
}

/** npx's `getBinFromManifest`: the one bin, or the bin named like the package. */
function binEntry(packageDir: string, manifest: Record<string, unknown>, name: string): { name: string; script: string } | null {
  const unscoped = name.split("/").pop()!;
  const bin = manifest.bin;
  const bins: Record<string, string> = typeof bin === "string"
    ? { [unscoped]: bin }
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? Object.fromEntries(Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  const targets = new Set(Object.values(bins));
  const binName = targets.size === 1 ? Object.keys(bins)[0]! : bins[unscoped] ? unscoped : null;
  if (!binName) return null;
  const script = path.resolve(packageDir, bins[binName]!);
  if (!script.startsWith(packageDir + path.sep) || !fileExists(script)) return null;
  return { name: binName, script };
}

/** A script npm would start with `node`: a `node` shebang without extra options. */
function isPlainNodeScript(script: string): boolean {
  let head: string;
  try {
    const fd = fs.openSync(script, "r");
    try {
      const buffer = Buffer.alloc(256);
      head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const first = head.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) return false;
  return /^#!\s*(?:\/usr\/bin\/env\s+node|\S*\/node)\s*$/.test(first);
}

function commandFileExists(dir: string, command: string): boolean {
  const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.ps1`] : [command];
  return names.some((name) => fileExists(path.join(dir, name)));
}

/**
 * True when npx would run something other than its own cache: the package in
 * the project tree or the global prefix, or a command named like npx's first
 * argument there (npx tries `node_modules/.bin` and the global bin folder
 * first, with the argument as written, version and all).
 */
function installedOutsideNpxCache(name: string, commands: readonly string[], cwd: string, setup: NpmSetup): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fileExists(path.join(dir, "node_modules", name, "package.json"))) return true;
    if (commands.some((command) => commandFileExists(path.join(dir, "node_modules", ".bin"), command))) return true;
    if (path.dirname(dir) === dir) break;
  }
  if (setup.globalModulesDirs.some((dir) => fileExists(path.join(dir, name, "package.json")))) return true;
  return setup.globalBinDirs.some((dir) => commands.some((command) => commandFileExists(dir, command)));
}

/** `PATH` for the child, with `dir` first, under this env's own PATH key (`Path` on Windows). */
function pathWithFirst(env: NodeJS.ProcessEnv, dir: string): Record<string, string> {
  const current = getPathEnvValue(env);
  return { [getPathEnvKey(env)]: current ? `${dir}${path.delimiter}${current}` : dir };
}

/**
 * A server's env with a direct launch's `PATH` in place of its own. Resolve
 * the launch with the server's env merged over the launch env, so that `PATH`
 * already starts from the server's own. On Windows every case variant of the
 * key is dropped first, because env keys are case-insensitive there.
 */
/**
 * The env to resolve a server's launch with: the server's own env over the
 * launch env. On Windows a server key replaces every case variant of it,
 * because env keys are case-insensitive there.
 */
export function serverLaunchEnv(
  launchEnv: NodeJS.ProcessEnv,
  serverEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!serverEnv) return launchEnv;
  if (process.platform !== "win32") return { ...launchEnv, ...serverEnv };
  const serverKeys = new Set(Object.keys(serverEnv).map((key) => key.toUpperCase()));
  const kept = Object.entries(launchEnv).filter(([key]) => !serverKeys.has(key.toUpperCase()));
  return { ...Object.fromEntries(kept), ...serverEnv };
}

export function withDirectLaunchEnv(
  serverEnv: Record<string, string> | undefined,
  direct: NpxDirectCommand,
): Record<string, string> {
  const isPathKey = process.platform === "win32"
    ? (key: string) => key.toUpperCase() === "PATH"
    : (key: string) => key in direct.env;
  const kept = Object.entries(serverEnv ?? {}).filter(([key]) => !isPathKey(key));
  return { ...Object.fromEntries(kept), ...direct.env };
}

/**
 * The registry's answer for one tag: the version and when it was fetched, and
 * when the last attempt ran. A failed attempt keeps the previous answer, which
 * is then used only while it is still fresh.
 */
type LatestEntry = { version: string | null; checkedAt: number; attemptedAt: number };

type NpxDirectLogger = {
  info: (event: string, data: Record<string, unknown>) => void;
  warn?: (event: string, data: Record<string, unknown>) => void;
};

export type NpxDirectLauncher = {
  /**
   * The direct command for one npx server, or null to launch it as written.
   * Never waits on the network: a tag with no usable answer starts a
   * background check and returns null, and an answer older than 15 minutes is
   * used while a background check refreshes it.
   */
  resolve(args: { command: string; args?: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }): NpxDirectCommand | null;
  /**
   * Fetch the registry answers these servers need, waiting at most a moment.
   * Asks only about packages `resolve` could re-point: on the public
   * registry, not installed elsewhere, and already in npx's cache.
   */
  prepare(servers: Array<{ command: string; args?: readonly string[] }>, args: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void>;
};

export function createNpxDirectLauncher(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  homeDir?: string;
  logger?: NpxDirectLogger | null;
} = {}): NpxDirectLauncher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const homeDir = options.homeDir ?? os.homedir();
  const logger = options.logger ?? null;
  const latest = new Map<string, LatestEntry>();
  const inflight = new Map<string, Promise<void>>();

  const latestKey = (name: string, tag: string) => `${name}@${tag}`;
  const refreshLatest = (name: string, tag: string): Promise<void> => {
    const key = latestKey(name, tag);
    const running = inflight.get(key);
    if (running) return running;
    const url = `${DEFAULT_REGISTRY}${name.replace("/", "%2f")}/${encodeURIComponent(tag)}`;
    const task = (async () => {
      let version: string | null = null;
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(LATEST_FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
          const body = await response.json() as { version?: unknown };
          if (typeof body.version === "string") version = body.version;
        } else {
          logger?.warn?.("mcp.npx_direct_registry_check_failed", { package: name, tag, status: response.status });
        }
      } catch (error) {
        // Offline or refused: no answer, so launches keep using npx.
        logger?.warn?.("mcp.npx_direct_registry_check_failed", {
          package: name,
          tag,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      const previous = latest.get(key);
      latest.set(key, version != null || !previous
        ? { version, checkedAt: now(), attemptedAt: now() }
        // No answer this time: keep the last good one until it ages out.
        : { ...previous, attemptedAt: now() });
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };
  /** The usable answer for a tag, kicking a background check when it is missing or getting old. */
  const latestAnswer = (name: string, tag: string): LatestEntry | null => {
    const entry = latest.get(latestKey(name, tag));
    const age = entry ? now() - entry.checkedAt : Infinity;
    const sinceAttempt = entry ? now() - entry.attemptedAt : Infinity;
    if (age >= LATEST_FRESH_MS && sinceAttempt >= LATEST_FRESH_MS) void refreshLatest(name, tag);
    if (!entry || age >= LATEST_USABLE_MS) return null;
    // The last check failed and this answer is no longer fresh: the tag may
    // have moved, so the launch stays on npx until a check succeeds.
    if (age >= LATEST_FRESH_MS && entry.attemptedAt > entry.checkedAt) return null;
    return entry;
  };

  /** Everything `resolve` checks before the version: null when the launch must stay on npx. */
  const eligible = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const invocation = parseNpxInvocation(command, args);
    if (!invocation) return null;
    const npx = path.isAbsolute(command) ? { path: command } : resolveExecutableFromKnownLocations(command, env);
    if (!npx) return null;
    const setup = npmSetup(env, homeDir, cwd, npx.path);
    if (!setup) return null;
    const scope = invocation.name.startsWith("@") ? invocation.name.split("/")[0]!.toLowerCase() : null;
    if (setup.customRegistryScopes === "all" || (scope && setup.customRegistryScopes.has(scope))) return null;
    const installDir = npxCacheInstallDir(setup.cacheDir, invocation.spec);
    const recorded = readJson(path.join(installDir, "package.json"))?._npx as { packages?: unknown } | undefined;
    if (!Array.isArray(recorded?.packages) || recorded.packages.length !== 1 || recorded.packages[0] !== invocation.spec) return null;
    const packageDir = path.join(installDir, "node_modules", ...invocation.name.split("/"));
    const manifest = readJson(path.join(packageDir, "package.json"));
    if (!manifest || manifest.name !== invocation.name || typeof manifest.version !== "string") return null;
    const bin = binEntry(packageDir, manifest, invocation.name);
    if (!bin || !isPlainNodeScript(bin.script)) return null;
    // npx looks for its first argument, exactly as written, as a command in
    // the local `.bin` folders and the global bin folder before its cache.
    if (installedOutsideNpxCache(invocation.name, [invocation.spec], cwd, setup)) return null;
    return { invocation, npxPath: npx.path, installDir, version: manifest.version, script: bin.script };
  };

  return {
    resolve({ command, args = [], cwd, env = process.env }) {
      const found = eligible(command, args, cwd, env);
      if (!found) return null;
      const { invocation, npxPath, installDir, version, script } = found;
      if (invocation.want.kind === "version") {
        if (version !== invocation.want.version) return null;
      } else if (latestAnswer(invocation.name, invocation.want.tag)?.version !== version) {
        return null;
      }
      const besideNpx = path.join(path.dirname(npxPath), process.platform === "win32" ? "node.exe" : "node");
      const node = fileExists(besideNpx) ? besideNpx : resolveExecutableFromKnownLocations("node", env)?.path;
      if (!node) return null;
      logger?.info("mcp.npx_direct_launch", { spec: invocation.spec, version });
      return {
        command: node,
        args: [script, ...invocation.rest],
        env: pathWithFirst(env, path.join(installDir, "node_modules", ".bin")),
      };
    },

    async prepare(servers, { cwd, env = process.env }) {
      const pending: Promise<void>[] = [];
      for (const server of servers) {
        const found = eligible(server.command, server.args ?? [], cwd, env);
        if (!found || found.invocation.want.kind !== "tag") continue;
        const { name, want } = found.invocation;
        const entry = latest.get(latestKey(name, want.tag));
        const stale = !entry || now() - entry.checkedAt >= LATEST_USABLE_MS;
        if (stale && (!entry || now() - entry.attemptedAt >= LATEST_FRESH_MS)) pending.push(refreshLatest(name, want.tag));
      }
      if (!pending.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, LAUNCH_WAIT_MS); }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}

let shared: NpxDirectLauncher | null = null;
let sharedLogger: NpxDirectLogger | null = null;

/**
 * The one launcher of this process, so chats and terminals share one set of
 * registry answers. The first caller that has a logger gives it one.
 */
export function sharedNpxDirectLauncher(logger?: NpxDirectLogger | null): NpxDirectLauncher {
  if (logger && !sharedLogger) sharedLogger = logger;
  shared ??= createNpxDirectLauncher({
    logger: {
      info: (event, data) => sharedLogger?.info(event, data),
      warn: (event, data) => sharedLogger?.warn?.(event, data),
    },
  });
  return shared;
}
