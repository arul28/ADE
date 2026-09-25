import { homedir } from "node:os";
import path from "node:path";

/**
 * Provider config: where it lives, and who owns each key.
 *
 * THE RULE. ADE hands its settings to every provider SDK at the highest
 * precedence tier available — above the user's own config files, and in some
 * cases above their per-project config too. So ADE must name a key only when it
 * genuinely owns it: there is ADE UI for it and ADE's value is the truth.
 * Otherwise the key stays absent and the provider's own precedence resolves it.
 *
 * Absence is the only way to say nothing. A substituted default is a real value
 * that wins, which is how ADE spent five providers silently overriding
 * configuration the user had set. Verified per provider by live probe:
 *
 *   Claude   omit -> the user's settings.json applies; "Default" is a real style
 *   Codex    omit -> config.toml service_tier applies; null forces "default"
 *   Droid    omit -> ~/.factory/settings.json applies, per key; null wedges the
 *                    RPC for 30s, so omit, never null
 *   Cursor   ADE always sends an explicit false, so ~/.cursor/sandbox.json is
 *                    never consulted; ADE hook denials are the permission guard
 *   OpenCode OPENCODE_CONFIG_CONTENT deep-merges last, so any key ADE names wins
 *
 * Each adapter states only its own non-derivable fact and points here.
 *
 * Where each provider CLI keeps its user-level config:
 *
 * Every one of these has an env override that the provider's own binary honours,
 * and the overrides do NOT share a shape — `CODEX_HOME` and `CLAUDE_CONFIG_DIR`
 * name the config directory itself, while `FACTORY_HOME_OVERRIDE` replaces the
 * HOME that `.factory` is then appended to. Hardcoding `~/.codex` or `~/.factory`
 * makes ADE read a different directory than the process it spawns, so ADE and the
 * CLI disagree about the user's configuration inside a single session.
 *
 * `homeDir` is for callers that already resolved a home of their own; everything
 * else stays on `homedir()` so this matches how ADE resolved these paths
 * before, and so tests that stub `os.homedir()` keep working.
 */

type HomeArg = { env?: NodeJS.ProcessEnv; homeDir?: string };

function baseHome(args: HomeArg): string {
  return path.resolve(args.homeDir?.trim().length ? args.homeDir : homedir());
}

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next?.length ? next : null;
}

/** `CLAUDE_CONFIG_DIR` names the config directory itself. */
export function claudeConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).CLAUDE_CONFIG_DIR);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".claude");
}

/** `CODEX_HOME` names the config directory itself, not the parent. */
export function codexConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).CODEX_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".codex");
}

/**
 * `FACTORY_HOME_OVERRIDE` replaces the HOME directory; Droid appends `.factory`
 * to it (`join($R(), ".factory")` in the v0.70.0 binary, where `$R()` is
 * `process.env.FACTORY_HOME_OVERRIDE || homedir()`).
 */
export function factoryConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).FACTORY_HOME_OVERRIDE);
  return path.join(configured ? path.resolve(configured) : baseHome(args), ".factory");
}

/** `QWEN_HOME` names the config directory itself (CODEX_HOME shape). */
export function qwenConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).QWEN_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".qwen");
}

/** `COPILOT_HOME` names the config directory itself; `--config-dir` is its flag twin. */
export function copilotConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).COPILOT_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".copilot");
}

/**
 * `KIMI_CODE_HOME` names the config directory itself; it holds `config.toml`,
 * `credentials/`, and the `region` marker. `kimiCodeLogin.ts` finds the login.
 */
export function kimiCodeConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).KIMI_CODE_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".kimi-code");
}

/** `GROK_HOME` names the config directory itself; it defaults to `~/.grok`. */
export function grokConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).GROK_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".grok");
}

/** Grok's per-session `updates.jsonl` files, under its config home. */
export function grokSessionsDir(args: HomeArg = {}): string {
  return path.join(grokConfigHome(args), "sessions");
}

/**
 * Where OpenCode keeps its data (`auth.json`, `opencode.db`), in lookup order.
 * OpenCode itself uses `XDG_DATA_HOME` when it is set, else
 * `~/.local/share/opencode`; the macOS and Windows app-data folders follow as
 * fallbacks that older builds used. The quota poller and the per-turn account
 * reader both read this one list, so they never read different files.
 */
export function openCodeDataDirs(args: HomeArg & { platform?: NodeJS.Platform } = {}): string[] {
  const env = args.env ?? process.env;
  const home = baseHome(args);
  const platform = args.platform ?? process.platform;
  const dirs: string[] = [];
  const xdgData = trimmed(env.XDG_DATA_HOME);
  if (xdgData) dirs.push(path.join(path.resolve(xdgData), "opencode"));
  dirs.push(path.join(home, ".local", "share", "opencode"));
  if (platform === "darwin") dirs.push(path.join(home, "Library", "Application Support", "opencode"));
  if (platform === "win32") dirs.push(path.join(trimmed(env.APPDATA) ?? path.join(home, "AppData", "Roaming"), "opencode"));
  return dirs;
}

/**
 * Devin's stored login: `credentials.toml` under the XDG data dir. `devin
 * auth status` reports it as `$XDG_DATA_HOME/devin/credentials.toml`
 * (`~/.local/share/devin` by default); Windows honours `%LOCALAPPDATA%`.
 * XDG selects THE data directory — it is not a search path — so when the
 * override is set only that location counts; returning the default alongside
 * it would let a stale, logged-out credential mark the provider active.
 * The auth detector and the per-turn account reader share this list so they
 * never disagree about where the login lives.
 */
export function devinCredentialFiles(args: HomeArg & { platform?: NodeJS.Platform } = {}): string[] {
  const env = args.env ?? process.env;
  const home = baseHome(args);
  const platform = args.platform ?? process.platform;
  const xdgData = trimmed(env.XDG_DATA_HOME);
  if (platform === "win32") {
    return [path.join(trimmed(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"), "devin", "credentials.toml")];
  }
  const dataHome = xdgData ? path.resolve(xdgData) : path.join(home, ".local", "share");
  return [path.join(dataHome, "devin", "credentials.toml")];
}

/**
 * Qwen's per-request usage files. `QWEN_RUNTIME_DIR` moves Qwen's runtime
 * state (usage included) away from the config home, and the Qwen binary
 * honours it, so ADE must too.
 */
export function qwenUsageDir(args: HomeArg = {}): string {
  const runtimeDir = trimmed((args.env ?? process.env).QWEN_RUNTIME_DIR);
  return path.join(runtimeDir ? path.resolve(runtimeDir) : qwenConfigHome(args), "usage");
}

/** Copilot CLI's per-request usage database, next to its `session-state/`. */
export function copilotSessionStorePath(args: HomeArg = {}): string {
  return path.join(copilotConfigHome(args), "session-store.db");
}
