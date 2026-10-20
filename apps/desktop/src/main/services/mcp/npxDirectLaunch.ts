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
 * - a copy of the package in the project tree or the global prefix (npx would
 *   run that one);
 * - a custom registry, or a registry answer this computer does not have yet
 *   (a tag or bare name is checked against the registry like npx does, once
 *   per six hours, never on the launch path for longer than a moment);
 * - a bin that is not a plain `node` script.
 *
 * Nothing here writes to any config file. The rewrite is a launch-time value.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
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

export type NpxDirectCommand = { command: string; args: string[] };

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

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** `key=value` lines of an `.npmrc`, comments dropped. */
function readNpmrc(filePath: string): Map<string, string> {
  const values = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return values;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
  }
  return values;
}

type NpmSetup = { cacheDir: string; globalModulesDirs: string[]; customRegistryScopes: Set<string> | "all" };

function npmSetup(env: NodeJS.ProcessEnv, homeDir: string, cwd: string, npxPath: string): NpmSetup {
  const userRc = readNpmrc(env.NPM_CONFIG_USERCONFIG?.trim() || env.npm_config_userconfig?.trim() || path.join(homeDir, ".npmrc"));
  const projectRcs: Map<string, string>[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const rc = path.join(dir, ".npmrc");
    if (fileExists(rc)) projectRcs.push(readNpmrc(rc));
    if (path.dirname(dir) === dir) break;
  }
  const lookup = (key: string): string | undefined =>
    env[`npm_config_${key}`]?.trim() || env[`NPM_CONFIG_${key.toUpperCase()}`]?.trim()
    || projectRcs.find((rc) => rc.has(key))?.get(key) || userRc.get(key);

  let customRegistryScopes: NpmSetup["customRegistryScopes"] = new Set();
  const registry = lookup("registry");
  if (registry && registry.replace(/\/?$/, "/") !== DEFAULT_REGISTRY) customRegistryScopes = "all";
  else {
    for (const rc of [userRc, ...projectRcs]) {
      for (const key of rc.keys()) {
        const scoped = key.match(/^(@[^:]+):registry$/);
        if (scoped) customRegistryScopes.add(scoped[1]!.toLowerCase());
      }
    }
  }

  const isWindows = process.platform === "win32";
  const cacheDir = lookup("cache")
    || (isWindows
      ? path.join(env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local"), "npm-cache")
      : path.join(homeDir, ".npm"));
  const prefixes = new Set<string>();
  const configuredPrefix = lookup("prefix");
  if (configuredPrefix) prefixes.add(configuredPrefix);
  // npm's default prefix: the folder above `bin/npx` on POSIX, the folder of
  // `npx.cmd` on Windows, plus `%APPDATA%\npm` where `npm i -g` lands there.
  const npxDir = path.dirname(npxPath);
  prefixes.add(isWindows ? npxDir : path.dirname(npxDir));
  if (isWindows && env.APPDATA?.trim()) prefixes.add(path.join(env.APPDATA.trim(), "npm"));
  const globalModulesDirs = [...prefixes].map((prefix) => isWindows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"));
  return { cacheDir, globalModulesDirs, customRegistryScopes };
}

/** npx's `getBinFromManifest`: the one bin, or the bin named like the package. */
function binScriptPath(packageDir: string, manifest: Record<string, unknown>, name: string): string | null {
  const unscoped = name.split("/").pop()!;
  const bin = manifest.bin;
  const bins: Record<string, string> = typeof bin === "string"
    ? { [unscoped]: bin }
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? Object.fromEntries(Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  const targets = new Set(Object.values(bins));
  const relative = targets.size === 1 ? [...targets][0]! : bins[unscoped];
  if (!relative) return null;
  const script = path.resolve(packageDir, relative);
  if (!script.startsWith(packageDir + path.sep) || !fileExists(script)) return null;
  return script;
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

/** True when npx would find this package before its own cache: the project tree or the global prefix. */
function installedOutsideNpxCache(name: string, cwd: string, globalModulesDirs: string[]): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fileExists(path.join(dir, "node_modules", name, "package.json"))) return true;
    if (path.dirname(dir) === dir) break;
  }
  return globalModulesDirs.some((dir) => fileExists(path.join(dir, name, "package.json")));
}

type LatestEntry = { version: string | null; checkedAt: number };

export type NpxDirectLauncher = {
  /**
   * The direct command for one npx server, or null to launch it as written.
   * Never touches the network; a tag it has no fresh answer for starts a
   * background check and returns null.
   */
  resolve(args: { command: string; args?: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }): NpxDirectCommand | null;
  /** Fetch the registry answers these servers need, waiting at most a moment. */
  prepare(servers: Array<{ command: string; args?: readonly string[] }>, env?: NodeJS.ProcessEnv): Promise<void>;
};

export function createNpxDirectLauncher(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  homeDir?: string;
  logger?: { info: (event: string, data: Record<string, unknown>) => void } | null;
} = {}): NpxDirectLauncher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const homeDir = options.homeDir ?? os.homedir();
  const latest = new Map<string, LatestEntry>();
  const inflight = new Map<string, Promise<void>>();

  const latestKey = (name: string, tag: string) => `${name}@${tag}`;
  const freshLatest = (name: string, tag: string): LatestEntry | null => {
    const entry = latest.get(latestKey(name, tag));
    return entry && now() - entry.checkedAt < LATEST_TTL_MS ? entry : null;
  };
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
        }
      } catch {
        // Offline or refused: no answer, so launches keep using npx.
      }
      latest.set(key, { version, checkedAt: now() });
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };

  const plan = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
    const invocation = parseNpxInvocation(command, args);
    if (!invocation) return null;
    const npx = path.isAbsolute(command) ? { path: command } : resolveExecutableFromKnownLocations(command, env);
    return npx ? { invocation, npxPath: npx.path } : null;
  };

  return {
    resolve({ command, args = [], cwd, env = process.env }) {
      const planned = plan(command, args, env);
      if (!planned) return null;
      const { invocation, npxPath } = planned;
      const setup = npmSetup(env, homeDir, cwd, npxPath);
      const scope = invocation.name.startsWith("@") ? invocation.name.split("/")[0]!.toLowerCase() : null;
      if (setup.customRegistryScopes === "all" || (scope && setup.customRegistryScopes.has(scope))) return null;
      if (installedOutsideNpxCache(invocation.name, cwd, setup.globalModulesDirs)) return null;

      const installDir = npxCacheInstallDir(setup.cacheDir, invocation.spec);
      const recorded = readJson(path.join(installDir, "package.json"))?._npx as { packages?: unknown } | undefined;
      if (!Array.isArray(recorded?.packages) || recorded.packages.length !== 1 || recorded.packages[0] !== invocation.spec) return null;
      const packageDir = path.join(installDir, "node_modules", ...invocation.name.split("/"));
      const manifest = readJson(path.join(packageDir, "package.json"));
      if (!manifest || manifest.name !== invocation.name || typeof manifest.version !== "string") return null;

      if (invocation.want.kind === "version") {
        if (manifest.version !== invocation.want.version) return null;
      } else {
        const answer = freshLatest(invocation.name, invocation.want.tag);
        if (!answer) {
          void refreshLatest(invocation.name, invocation.want.tag);
          return null;
        }
        if (answer.version !== manifest.version) return null;
      }

      const script = binScriptPath(packageDir, manifest, invocation.name);
      if (!script || !isPlainNodeScript(script)) return null;
      const besideNpx = path.join(path.dirname(npxPath), process.platform === "win32" ? "node.exe" : "node");
      const node = fileExists(besideNpx) ? besideNpx : resolveExecutableFromKnownLocations("node", env)?.path;
      if (!node) return null;
      options.logger?.info("mcp.npx_direct_launch", { spec: invocation.spec, version: manifest.version });
      return { command: node, args: [script, ...invocation.rest] };
    },

    async prepare(servers, env = process.env) {
      const pending: Promise<void>[] = [];
      for (const server of servers) {
        const planned = plan(server.command, server.args ?? [], env);
        if (!planned || planned.invocation.want.kind !== "tag") continue;
        const { name, want } = planned.invocation;
        if (!freshLatest(name, want.tag)) pending.push(refreshLatest(name, want.tag));
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
