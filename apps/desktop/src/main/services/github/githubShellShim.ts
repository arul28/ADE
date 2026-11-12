import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { localIpcListenOptions } from "../../../../../ade-cli/src/services/runtime/localIpcListenOptions";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { getPathEnvKey } from "../ai/cliExecutableResolver";
import { installWindowsCliLauncher, resolveWindowsCliLauncherSource } from "../cli/windowsCliLauncher";

/**
 * `gh` and `git` in agent shells, chats and CLI sessions with the ADE
 * account's CURRENT GitHub App token, asked for on every call.
 *
 * A token frozen into `GH_TOKEN` when a shell starts dies at the server's
 * renewal (8 hours at most), and an agent that runs for days then gets "Bad
 * credentials" in the middle of a task. So when ADE supplies the token
 * (githubSessionEnv.ts decides when), it puts a small `gh` first on the
 * session's PATH and a git credential helper in the session's git config
 * environment. Each run asks this process for the token over a private local
 * endpoint, then runs the real `gh` with `GH_TOKEN` in the child's
 * environment only (never in arguments, history or logs).
 *
 * - The endpoint: a Unix socket in `<ADE home>/sock` (a 0700 folder) on
 *   macOS and Linux; a named pipe scoped by ADE home and Windows user (quirk
 *   5) on Windows. One per process (desktop main, brain), named by its pid.
 *   `GET /v1/token?owner=<owner>` answers 200 with the token, or 204 when
 *   ADE has none for that owner (the shim then steps aside).
 * - The shims, written to `<tmp>/ade-cli-shims/github-<hash>` (beside the
 *   `ade` shims), refusing a folder another user owns or can write:
 *   - macOS/Linux: `gh` is a `#!/bin/sh` script. It asks with `curl`
 *     (about 10 ms) and `exec`s the real `gh`, so stdin, stdout, stderr,
 *     signals and the exit code are the real `gh`'s. Without `curl` it runs
 *     the Node form below.
 *   - Windows: `gh.exe` is ADE's native launcher (the one `ade.exe` uses),
 *     which passes its command line on verbatim to `gh-shim.cjs` under the
 *     app's Node; that runs the real `gh.exe` with the arguments as an array.
 *     No batch file, so cmd.exe never re-parses an argument; PowerShell,
 *     cmd.exe and Git Bash all find `gh.exe` through PATH and PATHEXT.
 *   - `git-credential-ade-github` (sh) or `git-credential-ade-github.exe`
 *     (launcher) answers git's `get` for https://github.com with the same
 *     token, so a `git push` typed in the shell works after a renewal.
 * - The shim steps aside (runs the real `gh` with the environment as it is)
 *   when the shell has its own GitHub token, `gh` has its own login, the
 *   endpoint is gone, or ADE has no token for the owner. With no real `gh`
 *   installed it prints the shell's usual "not found" and exits 127 (on
 *   Windows: 9009 as cmd.exe does, 127 under Git Bash). PowerShell's own
 *   not-found error cannot be copied; it gets cmd.exe's text.
 *
 * Off by default: a process turns it on with `configureGithubShellShim`
 * (desktop main and the brain do at start). Until then, and wherever the shim
 * cannot be written, githubSessionEnv.ts falls back to the frozen `GH_TOKEN`.
 */

export const GITHUB_SHIM_MARKER_FILE = ".ade-github-shim";
export const GH_TOKEN_ENDPOINT_ENV = "ADE_GH_TOKEN_ENDPOINT";
export const GH_SHIM_OWNER_ENV = "ADE_GH_SHIM_OWNER";
const GIT_CREDENTIAL_HELPER_NAME = "git-credential-ade-github";
const GIT_HELPER_CONFIG_KEY = "credential.https://github.com.helper";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/**
 * How long the endpoint waits for a token. Normally a cache hit
 * (milliseconds). At a renewal the token client may wait up to 45 s (the
 * server's closing wait plus the renewal at GitHub, `REQUEST_TIMEOUT_MS` in
 * accountAppTokenClient.ts), so this is longer: a `gh` that lands in that
 * window waits instead of running without a token.
 */
const ANSWER_TIMEOUT_MS = 48_000;
/** The shims' own limit (curl, Node): longer than the endpoint's, so its answer always arrives. */
const SHIM_CLIENT_TIMEOUT_SEC = 52;

// ---------------------------------------------------------------------------
// Shim bodies
// ---------------------------------------------------------------------------

/** A value one single-quoted sh word can carry. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The POSIX `gh`. Every name it sets is `ade_`-prefixed and not exported, so
 * the real `gh` sees the caller's environment unchanged unless ADE adds the
 * token. `-q` comes first so a `~/.curlrc` cannot change curl's output.
 */
export function renderGhShimSh(args: { nodeExecPath: string }): string {
  return `#!/bin/sh
# ADE: runs the real gh with the ADE account's current GitHub token.
# Written by ADE (githubShellShim.ts); rewritten on the next session start.
ade_self=$0
case $ade_self in */*) ade_dir=\${ade_self%/*} ;; *) ade_dir=. ;; esac
ade_real=
ade_ifs=$IFS
set -f
IFS=:
for ade_d in $PATH; do
  [ -n "$ade_d" ] || ade_d=.
  [ "$ade_d" -ef "$ade_dir" ] && continue
  [ -f "$ade_d/${GITHUB_SHIM_MARKER_FILE}" ] && continue
  if [ -f "$ade_d/gh" ] && [ -x "$ade_d/gh" ]; then
    ade_real=$ade_d/gh
    break
  fi
done
IFS=$ade_ifs
set +f
ade_step_aside() {
  if [ -z "$ade_real" ]; then
    printf '%s\\n' "gh: command not found" >&2
    exit 127
  fi
  exec "$ade_real" "$@"
}
if [ "\${ADE_GH_TOKEN_SOURCE:-}" = account_app ]; then
  [ -n "\${GITHUB_TOKEN:-}\${GH_ENTERPRISE_TOKEN:-}\${GITHUB_ENTERPRISE_TOKEN:-}" ] && ade_step_aside "$@"
else
  [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}\${GH_ENTERPRISE_TOKEN:-}\${GITHUB_ENTERPRISE_TOKEN:-}" ] && ade_step_aside "$@"
fi
if [ -n "\${GH_CONFIG_DIR:-}" ]; then ade_cfg=$GH_CONFIG_DIR
elif [ -n "\${XDG_CONFIG_HOME:-}" ]; then ade_cfg=$XDG_CONFIG_HOME/gh
else ade_cfg=\${HOME:-}/.config/gh
fi
if [ -f "$ade_cfg/hosts.yml" ]; then
  while IFS= read -r ade_line || [ -n "$ade_line" ]; do
    case $ade_line in
      github.com:*|github.com\\ *:*|'"github.com":'*|"'github.com':"*) ade_step_aside "$@" ;;
    esac
  done < "$ade_cfg/hosts.yml"
fi
[ -n "\${${GH_TOKEN_ENDPOINT_ENV}:-}" ] || ade_step_aside "$@"
[ -n "$ade_real" ] || ade_step_aside "$@"
if ! command -v curl >/dev/null 2>&1; then
  ELECTRON_RUN_AS_NODE=1 exec ${shSingleQuote(args.nodeExecPath)} "$ade_dir/gh-shim.cjs" gh "$@"
fi
ade_owner=\${${GH_SHIM_OWNER_ENV}:-}
case $ade_owner in *[!A-Za-z0-9-]*) ade_owner= ;; esac
ade_tok=$(curl -q -sf --noproxy '*' --max-time ${SHIM_CLIENT_TIMEOUT_SEC} --unix-socket "$${GH_TOKEN_ENDPOINT_ENV}" "http://localhost/v1/token?owner=$ade_owner" </dev/null 2>/dev/null) || ade_tok=
case $ade_tok in ''|*[!A-Za-z0-9_.-]*) ade_step_aside "$@" ;; esac
GH_TOKEN=$ade_tok
ADE_GH_TOKEN_SOURCE=account_app
export GH_TOKEN ADE_GH_TOKEN_SOURCE
ade_tok=
exec "$ade_real" "$@"
`;
}

/**
 * The POSIX git credential helper. Git runs it as `<path> get|store|erase`
 * with the request on stdin; it answers `get` for https://github.com only and
 * prints nothing otherwise, so git goes on to its other helpers or prompt.
 */
export function renderGitCredentialShimSh(args: { nodeExecPath: string }): string {
  return `#!/bin/sh
# ADE: git credential helper with the ADE account's current GitHub token.
# Written by ADE (githubShellShim.ts); rewritten on the next session start.
case $0 in */*) ade_dir=\${0%/*} ;; *) ade_dir=. ;; esac
ade_protocol=
ade_host=
while IFS= read -r ade_line; do
  [ -n "$ade_line" ] || break
  case $ade_line in
    protocol=*) ade_protocol=\${ade_line#protocol=} ;;
    host=*) ade_host=\${ade_line#host=} ;;
  esac
done
[ "\${1:-}" = get ] || exit 0
[ "$ade_protocol" = https ] && [ "$ade_host" = github.com ] || exit 0
if [ "\${ADE_GH_TOKEN_SOURCE:-}" = account_app ]; then
  [ -n "\${GITHUB_TOKEN:-}" ] && exit 0
else
  [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ] && exit 0
fi
if [ -n "\${GH_CONFIG_DIR:-}" ]; then ade_cfg=$GH_CONFIG_DIR
elif [ -n "\${XDG_CONFIG_HOME:-}" ]; then ade_cfg=$XDG_CONFIG_HOME/gh
else ade_cfg=\${HOME:-}/.config/gh
fi
if [ -f "$ade_cfg/hosts.yml" ]; then
  while IFS= read -r ade_line || [ -n "$ade_line" ]; do
    case $ade_line in
      github.com:*|github.com\\ *:*|'"github.com":'*|"'github.com':"*) exit 0 ;;
    esac
  done < "$ade_cfg/hosts.yml"
fi
[ -n "\${${GH_TOKEN_ENDPOINT_ENV}:-}" ] || exit 0
if ! command -v curl >/dev/null 2>&1; then
  ELECTRON_RUN_AS_NODE=1 exec ${shSingleQuote(args.nodeExecPath)} "$ade_dir/gh-shim.cjs" git-credential-answer
fi
ade_owner=\${${GH_SHIM_OWNER_ENV}:-}
case $ade_owner in *[!A-Za-z0-9-]*) ade_owner= ;; esac
ade_tok=$(curl -q -sf --noproxy '*' --max-time ${SHIM_CLIENT_TIMEOUT_SEC} --unix-socket "$${GH_TOKEN_ENDPOINT_ENV}" "http://localhost/v1/token?owner=$ade_owner" </dev/null 2>/dev/null) || exit 0
case $ade_tok in ''|*[!A-Za-z0-9_.-]*) exit 0 ;; esac
printf 'username=x-access-token\\npassword=%s\\n' "$ade_tok"
`;
}

/**
 * The Node form: the Windows shim (behind the launcher) and the POSIX
 * fallback without curl. Modes:
 * - `gh <args...>`: run the real gh.
 * - `git-credential <get|store|erase>`: git's helper protocol on stdin.
 * - `git-credential-answer`: the POSIX helper already read stdin and checked
 *   the request; just print the answer.
 */
export function renderGhShimNode(): string {
  return `"use strict";
// ADE: runs the real gh (or answers git) with the ADE account's current GitHub
// token. Written by ADE (githubShellShim.ts); rewritten on the next session start.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const isWin = process.platform === "win32";
const MARKER = ${JSON.stringify(GITHUB_SHIM_MARKER_FILE)};
const ENDPOINT_ENV = ${JSON.stringify(GH_TOKEN_ENDPOINT_ENV)};
const OWNER_ENV = ${JSON.stringify(GH_SHIM_OWNER_ENV)};
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TOKEN = /^[A-Za-z0-9_.-]+$/;
const env = process.env;

function envValue(name) {
  if (!isWin) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function realDir(dir) {
  try {
    const real = fs.realpathSync.native(path.resolve(dir));
    return isWin ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

// PATH entries as cmd.exe, Git Bash and gh's own Go runtime read them: on
// Windows an entry may be quoted ("C:\\some dir"), and ";" inside quotes does
// not split.
function pathEntries(value) {
  if (!isWin) return value.split(path.delimiter);
  const entries = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) {
      entries.push(current);
      current = "";
    } else current += ch;
  }
  entries.push(current);
  return entries;
}

function findRealGh() {
  const entries = pathEntries(envValue("PATH") || "");
  const names = isWin
    ? (envValue("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext === ".exe" || ext === ".com").map((ext) => "gh" + ext)
    : ["gh"];
  const self = realDir(__dirname);
  for (const raw of entries) {
    const dir = raw || ".";
    if (realDir(dir) === self) continue;
    if (fs.existsSync(path.join(dir, MARKER))) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

function hasOwnToken() {
  const own = (name) => Boolean((envValue(name) || "").trim());
  const others = own("GITHUB_TOKEN") || own("GH_ENTERPRISE_TOKEN") || own("GITHUB_ENTERPRISE_TOKEN");
  return envValue("ADE_GH_TOKEN_SOURCE") === "account_app" ? others : others || own("GH_TOKEN");
}

function ghConfigDir() {
  const configured = (envValue("GH_CONFIG_DIR") || "").trim();
  if (configured) return configured;
  const xdg = (envValue("XDG_CONFIG_HOME") || "").trim();
  if (xdg) return path.join(xdg, "gh");
  const appData = (envValue("APPDATA") || "").trim();
  if (isWin && appData) return path.join(appData, "GitHub CLI");
  return path.join(require("os").homedir(), ".config", "gh");
}

function hasOwnGhLogin() {
  try {
    const raw = fs.readFileSync(path.join(ghConfigDir(), "hosts.yml"), "utf8");
    return raw.split(/\\r?\\n/).some((line) => /^["']?github\\.com["']?\\s*:/.test(line));
  } catch {
    return false;
  }
}

function askToken() {
  const endpoint = (envValue(ENDPOINT_ENV) || "").trim();
  if (!endpoint) return Promise.resolve(null);
  const ownerValue = (envValue(OWNER_ENV) || "").trim();
  const owner = OWNER.test(ownerValue) ? ownerValue : "";
  return new Promise((resolve) => {
    const request = http.request({ socketPath: endpoint, path: "/v1/token?owner=" + owner, method: "GET", agent: false, timeout: ${SHIM_CLIENT_TIMEOUT_SEC * 1000} }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
      response.on("end", () => resolve(response.statusCode === 200 && TOKEN.test(body) ? body : null));
      response.on("error", () => resolve(null));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
}

function notFound() {
  // Git Bash / MSYS2 (MSYSTEM set) reports a missing command as bash does.
  if (isWin && !envValue("MSYSTEM")) {
    process.stderr.write("'gh' is not recognized as an internal or external command,\\r\\noperable program or batch file.\\r\\n");
    process.exit(9009);
  }
  process.stderr.write("gh: command not found\\n");
  process.exit(127);
}

function runGh(real, args, baseEnv) {
  // ELECTRON_RUN_AS_NODE is set only to run this script under the app's
  // runtime (the Windows launcher, the POSIX fallback). ADE keeps it out of
  // terminals; gh and what gh starts (an editor, a browser) must not get it.
  const childEnv = Object.assign({}, baseEnv);
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete childEnv[key];
  }
  const child = spawn(real, args, { stdio: "inherit", env: childEnv, windowsHide: true });
  // The terminal sends Ctrl+C to the whole group (the console on Windows):
  // the real gh decides, this wrapper only waits. Signals sent to this
  // process alone go on to gh.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  if (!isWin) {
    process.on("SIGQUIT", ignore);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2", "SIGWINCH"]) {
      process.on(signal, () => { try { child.kill(signal); } catch {} });
    }
  }
  child.on("error", () => notFound());
  child.on("exit", (code, signal) => {
    if (signal && !isWin) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

async function ghMode(args) {
  const real = findRealGh();
  if (!real) return notFound();
  if (hasOwnToken() || hasOwnGhLogin()) return runGh(real, args, env);
  const token = await askToken();
  if (!token) return runGh(real, args, env);
  runGh(real, args, Object.assign({}, env, { GH_TOKEN: token, ADE_GH_TOKEN_SOURCE: "account_app" }));
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { if (text.length < 65536) text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

async function answerGit() {
  if (hasOwnToken() || hasOwnGhLogin()) return;
  const token = await askToken();
  if (token) process.stdout.write("username=x-access-token\\npassword=" + token + "\\n");
}

async function gitCredentialMode(action) {
  const request = await readStdin();
  if (action !== "get") return;
  const fields = {};
  for (const line of request.split(/\\r?\\n/)) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  if (fields.protocol !== "https" || fields.host !== "github.com") return;
  await answerGit();
}

const mode = process.argv[2];
if (mode === "gh") ghMode(process.argv.slice(3));
else if (mode === "git-credential") gitCredentialMode(process.argv[3]);
else if (mode === "git-credential-answer") answerGit();
else process.exit(2);
`;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export type GithubShellShimInstall = {
  dir: string;
  /** The value for git's `credential.https://github.com.helper`. */
  credentialHelper: string;
};

function writeIfChanged(filePath: string, body: string, mode?: number): void {
  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    current = null;
  }
  if (current !== body) {
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: mode ?? 0o644 });
    fs.renameSync(temporary, filePath);
  }
  if (mode !== undefined && process.platform !== "win32") fs.chmodSync(filePath, mode);
}

/** A folder this user owns and nobody else can write (POSIX). Windows: exists. */
function ensurePrivateDir(dir: string, platform: NodeJS.Platform): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") return true;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
  return (stat.mode & 0o022) === 0;
}

/**
 * Write the shims for this runtime (`execPath` runs the Node form). Null, with
 * no partial result, when the folder is unsafe or a file cannot be written.
 */
export function installGithubShellShim(args: {
  shimsRoot: string;
  execPath: string;
  platform?: NodeJS.Platform;
  /** Windows: the native launcher to copy as `gh.exe`; resolved from the app when omitted. */
  launcherSource?: string | null;
  resourcesPath?: string | null;
}): { install: GithubShellShimInstall | null; reason: string | null } {
  const platform = args.platform ?? process.platform;
  const hash = createHash("sha256").update(args.execPath).digest("hex").slice(0, 16);
  const dir = path.join(args.shimsRoot, `github-${hash}`);
  try {
    if (!ensurePrivateDir(dir, platform)) return { install: null, reason: `${dir} is not a private folder of this user` };
    writeIfChanged(path.join(dir, "gh-shim.cjs"), renderGhShimNode());
    if (platform !== "win32") {
      if (/[\r\n\0]/.test(args.execPath)) return { install: null, reason: "the runtime path holds a line break" };
      writeIfChanged(path.join(dir, "gh"), renderGhShimSh({ nodeExecPath: args.execPath }), 0o755);
      const helper = path.join(dir, GIT_CREDENTIAL_HELPER_NAME);
      writeIfChanged(helper, renderGitCredentialShimSh({ nodeExecPath: args.execPath }), 0o755);
      writeIfChanged(path.join(dir, GITHUB_SHIM_MARKER_FILE), "ADE GitHub shim folder\n");
      return { install: { dir, credentialHelper: `!${shSingleQuote(helper)}` }, reason: null };
    }
    const launcherSource = args.launcherSource !== undefined
      ? args.launcherSource
      : resolveWindowsCliLauncherSource({ resourcesPath: args.resourcesPath ?? process.resourcesPath ?? null });
    const script = path.join(dir, "gh-shim.cjs");
    const spec = (mode: string) => ({
      exe: args.execPath,
      args: [script, mode],
      env: [["ELECTRON_RUN_AS_NODE", "1"]] as Array<[string, string]>,
    });
    const gh = installWindowsCliLauncher({ launcherSource, dir, spec: spec("gh"), name: "gh" });
    if (!gh.exePath) return { install: null, reason: gh.reason };
    const helper = installWindowsCliLauncher({ launcherSource, dir, spec: spec("git-credential"), name: GIT_CREDENTIAL_HELPER_NAME });
    if (!helper.exePath) return { install: null, reason: helper.reason };
    // Git runs a helper through its own sh: forward slashes, single-quoted.
    writeIfChanged(path.join(dir, GITHUB_SHIM_MARKER_FILE), "ADE GitHub shim folder\r\n");
    return { install: { dir, credentialHelper: `!${shSingleQuote(helper.exePath.replace(/\\/g, "/"))}` }, reason: null };
  } catch (error) {
    return { install: null, reason: `writing ${dir} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/** Answers the shims: the token for `owner`, or null to make them step aside. */
export type GithubShellTokenAnswer = (owner: string | null) => Promise<string | null>;

/** This process's endpoint: a Unix socket in the ADE sock folder, or a named pipe. */
export function githubShellTokenEndpointPath(args: {
  sockDir: string;
  adeDir: string;
  pid: number;
  platform?: NodeJS.Platform;
  userIdentity?: string;
}): string {
  const platform = args.platform ?? process.platform;
  if (platform !== "win32") return path.join(args.sockDir, `gh-token-${args.pid}.sock`);
  // Scoped like the brain's pipes (quirk 5): ADE home, user, and this process.
  const hash = createHash("sha256")
    .update(`${args.adeDir.toLowerCase()}\0${args.userIdentity ?? os.homedir().toLowerCase()}\0${args.pid}`)
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\ade-gh-token-${hash}`;
}

function sweepDeadEndpoints(sockDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(sockDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^gh-token-(\d+)\.sock$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(path.join(sockDir, name), { force: true });
    }
  }
}

export function createGithubShellTokenServer(args: {
  endpoint: string;
  answer: () => GithubShellTokenAnswer | null;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  platform?: NodeJS.Platform;
}) {
  const platform = args.platform ?? process.platform;
  let server: http.Server | null = null;
  let listening = false;
  let failed = false;

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const finish = (status: number, body = ""): void => {
      response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    };
    if (request.method !== "GET") return finish(405);
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return finish(400);
    }
    if (url.pathname !== "/v1/token") return finish(404);
    const rawOwner = url.searchParams.get("owner")?.trim() ?? "";
    const owner = OWNER_PATTERN.test(rawOwner) ? rawOwner : null;
    const answer = args.answer();
    if (!answer) return finish(204);
    let token: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      token = await Promise.race([
        answer(owner),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
        }),
      ]);
    } catch {
      token = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!token || !/^[A-Za-z0-9_.-]+$/.test(token)) return finish(204);
    finish(200, token);
  };

  /** Starts listening (once). The path is usable a moment later; a shim that asks first steps aside. */
  const start = (): string | null => {
    if (failed) return null;
    if (server) return args.endpoint;
    try {
      if (platform !== "win32") {
        const dir = path.dirname(args.endpoint);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        sweepDeadEndpoints(dir);
        fs.rmSync(args.endpoint, { force: true });
      }
      server = http.createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(500);
            response.end();
          }
        });
      });
      server.on("error", (error) => {
        failed = true;
        listening = false;
        args.logger?.warn("github.shell_token_endpoint_failed", { code: (error as NodeJS.ErrnoException).code ?? null });
      });
      server.listen(localIpcListenOptions(args.endpoint), () => {
        listening = true;
        if (platform !== "win32") {
          try {
            fs.chmodSync(args.endpoint, 0o600);
          } catch {
            // The 0700 folder already keeps other users out.
          }
        }
      });
      server.unref();
      if (platform !== "win32") {
        process.once("exit", () => {
          try {
            fs.rmSync(args.endpoint, { force: true });
          } catch {
            // Gone already.
          }
        });
      }
      return args.endpoint;
    } catch (error) {
      failed = true;
      args.logger?.warn("github.shell_token_endpoint_failed", { code: (error as NodeJS.ErrnoException).code ?? null });
      return null;
    }
  };

  const close = async (): Promise<void> => {
    const current = server;
    server = null;
    listening = false;
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    if (platform !== "win32") fs.rmSync(args.endpoint, { force: true });
  };

  return { start, close, isListening: () => listening, endpoint: args.endpoint };
}

// ---------------------------------------------------------------------------
// Process-wide configuration
// ---------------------------------------------------------------------------

type ShimState = {
  install: GithubShellShimInstall;
  server: ReturnType<typeof createGithubShellTokenServer>;
};

let shimState: ShimState | null = null;
let registeredAnswer: GithubShellTokenAnswer | null = null;
let disabledReason: string | null = "not configured";

/**
 * Each GitHub service registers how to answer (the account App token, if the
 * owner's installation is reachable). The token belongs to the account, not to
 * a project, so any registered answer gives the same result.
 */
export function setGithubShellTokenAnswer(answer: GithubShellTokenAnswer | null): void {
  registeredAnswer = answer;
}

/**
 * Turns the per-call shim on for this process: writes the shims and starts the
 * token endpoint (listening only, no timer). Returns why it is off, or null.
 */
export function configureGithubShellShim(args: {
  execPath?: string;
  shimsRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  launcherSource?: string | null;
  resourcesPath?: string | null;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}): string | null {
  if (shimState) return null;
  const platform = args.platform ?? process.platform;
  const env = args.env ?? process.env;
  const layout = resolveMachineAdeLayout(env, platform);
  const installed = installGithubShellShim({
    shimsRoot: args.shimsRoot ?? path.join(os.tmpdir(), "ade-cli-shims"),
    execPath: args.execPath ?? process.execPath,
    platform,
    launcherSource: args.launcherSource,
    resourcesPath: args.resourcesPath,
  });
  if (!installed.install) {
    disabledReason = installed.reason ?? "the shim could not be written";
    args.logger?.warn("github.shell_shim_unavailable", { reason: disabledReason });
    return disabledReason;
  }
  const endpoint = githubShellTokenEndpointPath({ sockDir: layout.sockDir, adeDir: layout.adeDir, pid: process.pid, platform });
  if (platform !== "win32" && Buffer.byteLength(endpoint) > 100) {
    disabledReason = "the socket path is too long";
    return disabledReason;
  }
  const server = createGithubShellTokenServer({ endpoint, answer: () => registeredAnswer, logger: args.logger, platform });
  if (!server.start()) {
    disabledReason = "the token endpoint could not start";
    return disabledReason;
  }
  shimState = { install: installed.install, server };
  disabledReason = null;
  return null;
}

/** Turns it off again (tests, harnesses, shutdown). */
export async function resetGithubShellShim(): Promise<void> {
  const current = shimState;
  shimState = null;
  disabledReason = "not configured";
  if (current) await current.server.close();
}

export function githubShellShimStatus(): { enabled: boolean; reason: string | null; dir: string | null; endpoint: string | null } {
  return {
    enabled: Boolean(shimState),
    reason: disabledReason,
    dir: shimState?.install.dir ?? null,
    endpoint: shimState?.server.endpoint ?? null,
  };
}

function splitPath(value: string | undefined, platform: NodeJS.Platform): string[] {
  return (value ?? "").split(platform === "win32" ? ";" : ":");
}

/**
 * The variables that put the shim in front of `env`, or null when the shim is
 * off (the caller then falls back to the frozen token). Removes an earlier
 * ADE shim folder from PATH and reuses an earlier helper slot, so a session
 * started from a session does not stack them.
 */
export function githubShellShimEnv(env: NodeJS.ProcessEnv, owner: string, platform: NodeJS.Platform = process.platform): Record<string, string> | null {
  const state = shimState;
  // Not listening (yet, or the endpoint failed): a shim would find no answer, so
  // the caller uses the frozen token instead.
  if (!state || !state.server.isListening() || !OWNER_PATTERN.test(owner)) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathKey = getPathEnvKey(env);
  const current = env[pathKey] ?? "";
  const keptEntries = (current ? splitPath(current, platform) : []).filter((entry) => {
    if (!entry) return true;
    if (entry === state.install.dir) return false;
    try {
      return !fs.existsSync(path.join(entry, GITHUB_SHIM_MARKER_FILE));
    } catch {
      return true;
    }
  });
  const result: Record<string, string> = {
    [pathKey]: [state.install.dir, ...keptEntries].join(delimiter),
    [GH_TOKEN_ENDPOINT_ENV]: state.server.endpoint,
    [GH_SHIM_OWNER_ENV]: owner,
  };
  // git's config environment: reuse the slot an earlier ADE shim took, else append.
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const existing = Number.isFinite(count) && count > 0 ? count : 0;
  let slot = existing;
  for (let index = 0; index < existing; index += 1) {
    if (env[`GIT_CONFIG_KEY_${index}`] === GIT_HELPER_CONFIG_KEY && (env[`GIT_CONFIG_VALUE_${index}`] ?? "").includes(GIT_CREDENTIAL_HELPER_NAME)) {
      slot = index;
      break;
    }
  }
  result[`GIT_CONFIG_KEY_${slot}`] = GIT_HELPER_CONFIG_KEY;
  result[`GIT_CONFIG_VALUE_${slot}`] = state.install.credentialHelper;
  result.GIT_CONFIG_COUNT = String(Math.max(existing, slot + 1));
  return result;
}
