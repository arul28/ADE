/**
 * "Copy terminal launcher": one line that starts a harness in your own
 * terminal on a Custom provider.
 *
 * The line never holds a secret. It asks the `ade` CLI for the environment at
 * run time (`ade harness env <presetId>` resolves the preset or the ad-hoc
 * route on the machine that runs it), then starts the harness on the model.
 * Route ids (`route.<...>`) work exactly like saved preset ids.
 *
 * The model comes from that environment too (`ADE_HARNESS_MODEL`), not from
 * the preset: a route translated through ADE's proxy names the model by its
 * upstream (`ade-opencode-go/glm-5.3`) and Droid by `custom:<id>`, spellings
 * only the machine that resolves the launch knows.
 */

import type { HarnessPresetBody, HarnessPresetSource } from "../../../../shared/harnessPresets";
import { rendererRuntimeTarget } from "../../../lib/platform";

/** Harnesses the launcher knows how to start. */
const LAUNCHABLE: ReadonlySet<HarnessPresetBody> = new Set(["claude", "codex", "grok", "qwen", "droid", "opencode"]);

export function harnessHasTerminalLauncher(harness: HarnessPresetBody): boolean {
  return LAUNCHABLE.has(harness);
}

/** POSIX single-quote, so a model id with odd characters stays one word. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._\-/:@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function pwshWord(value: string): string {
  return /^[A-Za-z0-9._\-/:@]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

/** How each shell reads the model `ade harness env` exported. */
const MODEL_FROM_ENV = { posix: `"$ADE_HARNESS_MODEL"`, pwsh: "$env:ADE_HARNESS_MODEL" } as const;

function harnessCommand(
  harness: HarnessPresetBody,
  modelWord: string,
  reasoningEffort: string | undefined,
  quote: (value: string) => string,
): string | null {
  const m = modelWord;
  if (harness === "claude") {
    return `claude --model ${m}${reasoningEffort?.trim() ? ` --effort ${quote(reasoningEffort.trim())}` : ""}`;
  }
  if (harness === "codex") return `codex -m ${m}`;
  if (harness === "grok") return `grok -m ${m}`;
  if (harness === "qwen") return `qwen -m ${m}`;
  if (harness === "droid") return `droid -m ${m}`;
  if (harness === "opencode") return `opencode -m ${m}`;
  return null;
}

/**
 * The launcher line, or null for a harness it cannot start.
 *
 * `platform` defaults to the host's: Windows gets the PowerShell form, every
 * other platform the POSIX `eval` form.
 */
export function buildTerminalLauncher(args: {
  presetId: string;
  harness: HarnessPresetBody;
  model: string;
  /** The preset's source (kept for callers; the model now comes from the env). */
  source?: HarnessPresetSource;
  reasoningEffort?: string;
  platform?: string;
}): string | null {
  if (!harnessHasTerminalLauncher(args.harness) || !args.presetId.trim() || !args.model.trim()) return null;
  const windows = (args.platform ?? rendererRuntimeTarget().platform) === "win32";
  const quote = windows ? pwshWord : shellWord;
  // The resolved model, in the spelling that harness's CLI takes (OpenCode's
  // `<provider>/<model>` included), comes from the exported environment.
  const modelWord = windows ? MODEL_FROM_ENV.pwsh : MODEL_FROM_ENV.posix;
  const command = harnessCommand(args.harness, modelWord, args.reasoningEffort, quote);
  if (!command) return null;
  const id = quote(args.presetId.trim());
  // Both forms start the harness only when `ade harness env` succeeded, so a
  // failed lookup never falls through to the harness's own sign-in (or to a
  // previous launcher's leftovers). POSIX: `eval "$(…)"` returns 0 even when
  // the command inside failed, but an assignment carries its exit status.
  return windows
    ? `$adeEnv = ade harness env ${id} --shell pwsh --text | Out-String; if ($LASTEXITCODE -eq 0) { Invoke-Expression $adeEnv; if ($?) { ${command} } }`
    : `__ade_env="$(ade harness env ${id} --text)" && eval "$__ade_env" && ${command}`;
}
