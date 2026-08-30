import { spawn } from "node:child_process";

import {
  resolveExecutableFromKnownLocations,
  type ResolvedExecutable,
} from "../../../desktop/src/main/services/ai/cliExecutableResolver";
import { resolveCliSpawnInvocation } from "../../../desktop/src/main/services/shared/processExecution";
import type { TriageBundle } from "./triageContext";
import { TriageCommandError, TriageUsageError } from "./triageErrors";

/**
 * Which coding agent CLI `ade triage` hands the machine to, and how.
 *
 * Detection order, prompt delivery, the Windows wrapper rule and the spawn
 * itself all live here; the command orchestrator only picks one and runs it.
 */

/**
 * How each CLI accepts the prompt we want it to start with.
 *
 * `positional` is verified against each CLI's own `--help`: claude, codex,
 * cursor-agent and droid all document a trailing `[prompt]` that starts an
 * interactive session seeded with it. OpenCode is the exception — its
 * positional argument is the *project directory* (`opencode [project]`), so
 * passing a prompt there would silently launch it in a nonexistent folder. It
 * is launched bare and the prompt is printed for the user to paste.
 */
type TriagePromptDelivery = "positional" | "paste";

export type TriageProviderName =
  | "claude"
  | "codex"
  | "cursor-agent"
  | "opencode"
  | "droid";

export type TriageProviderSpec = {
  name: TriageProviderName;
  label: string;
  command: string;
  promptDelivery: TriagePromptDelivery;
};

/** Detection order. First installed one wins unless `--provider` overrides it. */
export const TRIAGE_PROVIDERS: readonly TriageProviderSpec[] = [
  { name: "claude", label: "Claude Code", command: "claude", promptDelivery: "positional" },
  { name: "codex", label: "Codex", command: "codex", promptDelivery: "positional" },
  { name: "cursor-agent", label: "Cursor CLI", command: "cursor-agent", promptDelivery: "positional" },
  { name: "opencode", label: "OpenCode", command: "opencode", promptDelivery: "paste" },
  { name: "droid", label: "Droid", command: "droid", promptDelivery: "positional" },
];

export type DetectedTriageProvider = TriageProviderSpec & {
  /** Absolute path to the executable, as spelled on disk. */
  path: string;
};

type TriageExecutableResolver = (
  command: string,
  env: NodeJS.ProcessEnv,
) => ResolvedExecutable | null;

/**
 * The shared resolver, not a bare `fs.existsSync(path.join(dir, name))`.
 *
 * On Windows an extension-less file is not launchable at all: `npm i -g codex`
 * drops `codex` (an sh script), `codex.cmd` and `codex.ps1` side by side, and
 * only the latter two can run. `resolveExecutableFromKnownLocations` resolves
 * the way Windows does — PATHEXT, then the known install directories — and
 * reports the on-disk casing.
 */
export const defaultTriageExecutableResolver: TriageExecutableResolver = (command, env) =>
  resolveExecutableFromKnownLocations(command, env);

export function detectTriageProviders(
  options: {
    env?: NodeJS.ProcessEnv;
    resolve?: TriageExecutableResolver;
    providers?: readonly TriageProviderSpec[];
  } = {},
): DetectedTriageProvider[] {
  const env = options.env ?? process.env;
  const resolve = options.resolve ?? defaultTriageExecutableResolver;
  const detected: DetectedTriageProvider[] = [];
  for (const spec of options.providers ?? TRIAGE_PROVIDERS) {
    let resolved: ResolvedExecutable | null = null;
    try {
      resolved = resolve(spec.command, env);
    } catch {
      // A resolver that throws (an unreadable directory on PATH) must not take
      // the whole command down; that provider is simply not available.
      resolved = null;
    }
    if (resolved?.path) detected.push({ ...spec, path: resolved.path });
  }
  return detected;
}

export function parseTriageProviderName(value: string): TriageProviderName {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, TriageProviderName> = {
    claude: "claude",
    "claude-code": "claude",
    codex: "codex",
    cursor: "cursor-agent",
    "cursor-agent": "cursor-agent",
    "cursor-cli": "cursor-agent",
    opencode: "opencode",
    droid: "droid",
    factory: "droid",
  };
  const match = aliases[normalized];
  if (!match) {
    throw new TriageUsageError(
      `Unknown provider '${value}'. Known providers: ${TRIAGE_PROVIDERS.map((p) => p.name).join(", ")}.`,
    );
  }
  return match;
}

export function describeTriageProviders(providers: readonly DetectedTriageProvider[]): string {
  if (providers.length === 0) return "none";
  return providers.map((provider) => provider.name).join(", ");
}

export type TriageLaunchPlan = {
  provider: TriageProviderName;
  label: string;
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  /** False for OpenCode, whose positional argument is a directory, not a prompt. */
  promptDelivered: boolean;
};

export function buildTriageLaunchPlan(
  provider: DetectedTriageProvider,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TriageLaunchPlan {
  const wanted = provider.promptDelivery === "positional";
  const invocation = resolveCliSpawnInvocation(
    provider.path,
    wanted ? [prompt] : [],
    env,
    platform,
  );
  // A wrapped invocation means Windows could not spawn this executable directly
  // — a `.cmd`/`.bat` shim goes through `cmd.exe /d /s /c`, a `.ps1` through
  // PowerShell — and both rewrite the command line before the CLI sees argv:
  // `%USERPROFILE%` expands unescapably and embedded newlines flatten to
  // spaces. The triage prompt is multi-line and contains paths, so it would
  // arrive corrupted. Keep it off the command line and have the user paste it,
  // the same choice ADE's PTY launch builders make for the same reason.
  const wrapped = invocation.command !== provider.path;
  if (wanted && wrapped) {
    const bare = resolveCliSpawnInvocation(provider.path, [], env, platform);
    return {
      provider: provider.name,
      label: provider.label,
      command: bare.command,
      args: bare.args,
      windowsVerbatimArguments: bare.windowsVerbatimArguments === true,
      promptDelivered: false,
    };
  }
  return {
    provider: provider.name,
    label: provider.label,
    command: invocation.command,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    promptDelivered: wanted,
  };
}

export type TriageAgentSpawner = (plan: TriageLaunchPlan) => Promise<number>;

/**
 * stdio is inherited, so the user is talking to their agent directly — this
 * process is only the launcher. It exits with whatever the agent exited with.
 */
export const spawnTriageAgent: TriageAgentSpawner = (plan) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      stdio: "inherit",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // A `.cmd` shim is launched through `cmd.exe`, which pops its own console
      // window on Windows. stdio is inherited, so the agent is already talking
      // in this terminal; a second empty window is pure noise.
      windowsHide: true,
    });
    // The files are already written, so a failed spawn is a launch problem and
    // nothing more — say which command failed and let the user paste the prompt
    // somewhere else, rather than printing a stack over the paths.
    child.once("error", (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      reject(new TriageCommandError(
        `Could not start ${plan.label} (${plan.command}): ${detail}. `
        + "The triage files are already written — paste the prompt into any agent.",
      ));
    });
    child.once("close", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else resolve(signal ? 1 : 0);
    });
  });

/**
 * What the user sees on stderr just before the agent takes over the terminal.
 *
 * Printed for every provider, because the launch replaces this process's stdio
 * and there is no other moment to say where the files are. For OpenCode it
 * carries the prompt itself: its positional argument is a project directory, so
 * the prompt cannot be passed on the command line and has to be pasted.
 */
export function triageLaunchNotice(
  bundle: TriageBundle,
  plan: TriageLaunchPlan,
  prompt: string,
): string {
  const lines = [
    `Starting ${plan.label} for triage.`,
    `  context:  ${bundle.contextPath}`,
    `  playbook: ${bundle.playbookPath} (${bundle.playbookSource})`,
  ];
  if (!plan.promptDelivered) {
    lines.push(
      "",
      `${plan.label} starts empty here — this install cannot take the prompt on its`,
      "command line without mangling it. Paste this in:",
      "",
      prompt,
    );
  }
  return `${lines.join("\n")}\n`;
}
