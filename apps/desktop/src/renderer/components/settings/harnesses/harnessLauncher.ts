/**
 * "Copy terminal launcher": one line that starts a harness in your own
 * terminal on a Custom provider.
 *
 * The line never holds a secret. It asks the `ade` CLI for the environment at
 * run time (`ade harness env <presetId>` resolves the preset or the ad-hoc
 * route on the machine that runs it), then starts the harness on the model.
 * Route ids (`route.<...>`) work exactly like saved preset ids.
 */

import type { HarnessPresetBody } from "../../../../shared/harnessPresets";
import { rendererRuntimeTarget } from "../../../lib/platform";

/** Harnesses the launcher knows how to start. */
const LAUNCHABLE: ReadonlySet<HarnessPresetBody> = new Set(["claude", "codex", "grok", "qwen", "droid"]);

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

function harnessCommand(
  harness: HarnessPresetBody,
  model: string,
  reasoningEffort: string | undefined,
  quote: (value: string) => string,
): string | null {
  const m = quote(model.trim());
  if (harness === "claude") {
    return `claude --model ${m}${reasoningEffort?.trim() ? ` --effort ${quote(reasoningEffort.trim())}` : ""}`;
  }
  if (harness === "codex") return `codex -m ${m}`;
  if (harness === "grok") return `grok -m ${m}`;
  if (harness === "qwen") return `qwen -m ${m}`;
  if (harness === "droid") return `droid -m ${quote(`custom:${model.trim()}`)}`;
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
  reasoningEffort?: string;
  platform?: string;
}): string | null {
  if (!harnessHasTerminalLauncher(args.harness) || !args.presetId.trim() || !args.model.trim()) return null;
  const windows = (args.platform ?? rendererRuntimeTarget().platform) === "win32";
  const quote = windows ? pwshWord : shellWord;
  const command = harnessCommand(args.harness, args.model, args.reasoningEffort, quote);
  if (!command) return null;
  const id = quote(args.presetId.trim());
  return windows
    ? `ade harness env ${id} --shell pwsh --text | Out-String | Invoke-Expression; ${command}`
    : `eval "$(ade harness env ${id} --text)" && ${command}`;
}
