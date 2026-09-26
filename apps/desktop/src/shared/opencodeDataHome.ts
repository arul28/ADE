import os from "node:os";
import path from "node:path";

/**
 * The one resolver for OpenCode data-home paths, shared by the desktop process
 * (which launches servers and runs the auth flow) and the `ade` CLI (which
 * prunes stores).
 *
 * It MUST be process-independent. The desktop Electron main and the runtime
 * brain are different processes; when the main preferred Electron `userData`
 * while the brain fell back to `~/.ade`, the auth flow wrote `/auth` into one
 * store while chats read another, and OpenCode login reported "connected" for a
 * credential the chat server never saw. Both processes now derive the same root
 * from `ADE_HOME` (or the home fallback), so a login lands where a chat reads.
 */

/** ADE's machine home, matching the brain's own resolution. */
function resolveAdeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADE_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir().trim() || os.tmpdir(), ".ade");
}

/** Root of ADE's OpenCode runtime state (env override wins). */
export function resolveAdeOpenCodeRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADE_OPENCODE_XDG_ROOT?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveAdeHome(env), "opencode-runtime");
}

/** Bump when the owned layout moves, so old and new roots never mix. */
export const ADE_OPENCODE_XDG_LAYOUT_VERSION = 1;

export type OpenCodeIsolationPaths = {
  root: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  runtimeDir: string;
};

export function resolveAdeOpenCodeIsolationPaths(
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeIsolationPaths {
  const root = path.join(
    resolveAdeOpenCodeRuntimeRoot(env),
    `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`,
  );
  return {
    root,
    configHome: path.join(root, "config"),
    dataHome: path.join(root, "data"),
    stateHome: path.join(root, "state"),
    cacheHome: path.join(root, "cache"),
    runtimeDir: path.join(root, "runtime"),
  };
}

/** `XDG_DATA_HOME` of ADE's owned OpenCode store; OpenCode appends `opencode/`. */
export function resolveAdeOpenCodeDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAdeOpenCodeIsolationPaths(env).dataHome;
}

/** The directory that actually holds `opencode.db` / `auth.json`. */
export function resolveAdeOpenCodeStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAdeOpenCodeDataRoot(env), "opencode");
}

/**
 * The USER's OpenCode data root.
 *
 * OpenCode resolves this as `XDG_DATA_HOME || ~/.local/share/opencode` with
 * **no platform branch** — on Windows it is not `%LOCALAPPDATA%`. Reading any
 * other path would seed no auth and make `--store user` target a directory that
 * does not exist.
 */
export function resolveUserOpenCodeDataRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.XDG_DATA_HOME?.trim();
  if (configured) return path.resolve(configured, "opencode");
  const homeDir = env.HOME?.trim() || os.homedir().trim();
  return homeDir ? path.join(homeDir, ".local", "share", "opencode") : null;
}

/** The user's OpenCode `auth.json` location, whether or not it exists. */
export function resolveUserOpenCodeAuthPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveUserOpenCodeDataRoot(env);
  return root ? path.join(root, "auth.json") : null;
}
