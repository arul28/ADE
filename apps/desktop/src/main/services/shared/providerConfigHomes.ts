import os from "node:os";
import path from "node:path";

/**
 * Where each provider CLI keeps its user-level config.
 *
 * Every one of these has an env override that the provider's own binary honours,
 * and the overrides do NOT share a shape — `CODEX_HOME` and `CLAUDE_CONFIG_DIR`
 * name the config directory itself, while `FACTORY_HOME_OVERRIDE` replaces the
 * HOME that `.factory` is then appended to. Hardcoding `~/.codex` or `~/.factory`
 * makes ADE read a different directory than the process it spawns, so ADE and the
 * CLI disagree about the user's configuration inside a single session.
 */

function home(env: NodeJS.ProcessEnv): string {
  const configured = env.HOME?.trim() || env.USERPROFILE?.trim();
  return configured?.length ? path.resolve(configured) : path.resolve(os.homedir());
}

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next?.length ? next : null;
}

/** `CLAUDE_CONFIG_DIR` names the config directory itself. */
export function claudeConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimmed(env.CLAUDE_CONFIG_DIR);
  return configured ? path.resolve(configured) : path.join(home(env), ".claude");
}

/** `CODEX_HOME` names the config directory itself, not the parent. */
export function codexConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimmed(env.CODEX_HOME);
  return configured ? path.resolve(configured) : path.join(home(env), ".codex");
}

/**
 * `FACTORY_HOME_OVERRIDE` replaces the HOME directory; Droid appends `.factory`
 * to it (`join($R(), ".factory")` in the v0.70.0 binary, where `$R()` is
 * `process.env.FACTORY_HOME_OVERRIDE || homedir()`).
 */
export function factoryConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimmed(env.FACTORY_HOME_OVERRIDE);
  return path.join(configured ? path.resolve(configured) : home(env), ".factory");
}
