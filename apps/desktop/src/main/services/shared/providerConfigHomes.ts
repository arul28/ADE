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
 *   Cursor   three states — absent lets ~/.cursor/sandbox.json decide, an
 *                    explicit false skips the file entirely
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

/** `KIMI_CODE_HOME` names the config directory itself; it holds `config.toml`. */
export function kimiCodeConfigHome(args: HomeArg = {}): string {
  const configured = trimmed((args.env ?? process.env).KIMI_CODE_HOME);
  return configured ? path.resolve(configured) : path.join(baseHome(args), ".kimi-code");
}

/**
 * Grok has NO config-home override: it reads `~/.grok` and nothing else. ADE
 * therefore sets nothing and reuses whatever the user already has. Stated here
 * so the absence reads as a decision rather than an omission.
 */
export function grokConfigHome(args: HomeArg = {}): string {
  return path.join(baseHome(args), ".grok");
}
