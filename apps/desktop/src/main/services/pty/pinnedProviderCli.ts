/**
 * ADE's pinned copy of each provider CLI, the way a terminal runs it.
 *
 * Every terminal ADE opens for a provider (a Work terminal, its resume or
 * fork, a sign-in) runs ADE's own checksum-verified copy from the tools cache,
 * never a CLI the user installed: a user who wants their own opens a plain
 * shell. A copy is an absolute entry plus the arguments it needs before the
 * CLI's own (Qwen, Cursor and Pi are a Node running a script) and the
 * environment that keeps it from updating itself.
 *
 *   const state = pinnedProviderCliState("grok");
 *   if (state.kind === "downloading") await state.done;   // then ask again
 *
 * Everything resolves and downloads in the process it runs in, so callers run
 * it on the machine that owns the lane: the PTY host lives there already.
 */
import { pinnedToolDownload } from "../../../../../ade-cli/src/services/tools/onDemand";
import { getPinnedToolStatus, resolvePinnedTool } from "../../../../../ade-cli/src/services/tools/pinnedTool";
import { CODEX_NO_UPDATE_CHECK_ARGS, PINNED_PROVIDER_TOOLS, pinnedToolSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import type { TerminalToolType } from "../../../shared/types";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { resolveAcpExecutable } from "../ai/acpExecutables";
import { resolveDroidExecutable } from "../ai/droidExecutable";
import { resolvePiInstallation } from "../ai/piInstallation";
import { ensureMuseBinary, museBinaryBlocker, resolveMuseExecutable } from "../ai/museExecutable";
import { pinnedToolBlocker, resolvePinnedCursorAgentCli } from "../ai/pinnedProviderTools";
import { isExecutableFile } from "../ai/cliExecutableResolver";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";

export type PinnedCliProvider =
  | "claude"
  | "codex"
  | "opencode"
  | "copilot"
  | "cursor"
  | "droid"
  | "pi"
  | "qwen"
  | "kimi"
  | "grok"
  | "devin"
  | "muse";

export type PinnedProviderCli = {
  provider: PinnedCliProvider;
  /** Absolute entry: the native binary, or the Node that runs the CLI's script. */
  command: string;
  /** Arguments before the CLI's own: its script, and its self-update switch. */
  leadingArgs: string[];
  /** Variables the CLI runs with: its self-update switches, Cursor's launcher name. */
  env: Record<string, string>;
};

export type PinnedProviderCliState =
  | { kind: "ready"; cli: PinnedProviderCli }
  /** Not on this machine yet; `done` settles (never rejects) when the download ends either way. */
  | { kind: "downloading"; label: string; done: Promise<void> }
  /** Cannot run here: not available for this platform, a failed download, downloads off. */
  | { kind: "blocked"; label: string; message: string };

type ProviderCliSpec = {
  label: string;
  /** Command words that name this CLI in a launch line, the canonical one first. */
  binaries: readonly string[];
  /** Tools-cache names it needs on disk, each with the label its sentence uses. */
  tools: ReadonlyArray<{ tool: string; label: string }>;
  resolve: () => PinnedProviderCli | null;
};

function terminalSpec(provider: PinnedCliProvider) {
  const spec = PINNED_PROVIDER_TOOLS[provider]?.terminal;
  if (!spec) throw new Error(`No terminal tool mapping for ${provider}`);
  return spec;
}

function nativeCli(
  provider: PinnedCliProvider,
  command: string | null | undefined,
  tool: string,
  leadingArgs: readonly string[] = [],
): PinnedProviderCli | null {
  return command ? { provider, command, leadingArgs: [...leadingArgs], env: pinnedToolSelfUpdateEnv(tool) } : null;
}

/** Qwen, Kimi, Grok, Devin and Copilot's terminal CLI: env override, then the pin (Qwen's is its Node plus a script). */
function acpCli(
  provider: Extract<PinnedCliProvider, "qwen" | "kimi" | "grok" | "devin" | "copilot">,
  tool: string,
  selfUpdateArgs: readonly string[] = [],
): PinnedProviderCli | null {
  const resolved = resolveAcpExecutable(provider);
  if (resolved.source === "fallback-command" || !resolved.path) return null;
  return nativeCli(provider, resolved.path, tool, [...(resolved.args ?? []), ...selfUpdateArgs]);
}

/** Pi's CLI is a script; it runs on ADE's pinned Node, never Electron's or the user's. */
function piCli(): PinnedProviderCli | null {
  const script = resolvePiInstallation().cliPath;
  const nodeTool = terminalSpec("pi").tools.find(({ tool }) => tool === "node")?.tool;
  if (!nodeTool) return null;
  const node = resolvePinnedTool(nodeTool);
  if (!script || !node || !isExecutableFile(node.entryPath, process.platform)) return null;
  return { provider: "pi", command: node.entryPath, leadingArgs: [script], env: pinnedToolSelfUpdateEnv(terminalSpec("pi").selfUpdateTool) };
}

function cursorCli(): PinnedProviderCli | null {
  const pinned = resolvePinnedCursorAgentCli();
  return pinned ? { provider: "cursor", command: pinned.command, leadingArgs: pinned.leadingArgs, env: pinned.env } : null;
}

const PROVIDER_CLIS: Readonly<Record<PinnedCliProvider, ProviderCliSpec>> = {
  claude: {
    label: terminalSpec("claude").label,
    binaries: terminalSpec("claude").binaries,
    tools: terminalSpec("claude").tools,
    resolve: () => nativeCli("claude", resolveClaudeCodeExecutable().path, terminalSpec("claude").selfUpdateTool),
  },
  codex: {
    label: terminalSpec("codex").label,
    binaries: terminalSpec("codex").binaries,
    tools: terminalSpec("codex").tools,
    // Codex's update check is a config key, not a variable; `-c` is a global flag.
    resolve: () => nativeCli("codex", resolveCodexExecutable().path, terminalSpec("codex").selfUpdateTool, CODEX_NO_UPDATE_CHECK_ARGS),
  },
  opencode: {
    label: terminalSpec("opencode").label,
    binaries: terminalSpec("opencode").binaries,
    tools: terminalSpec("opencode").tools,
    resolve: () => nativeCli("opencode", resolveOpenCodeBinaryPath(), terminalSpec("opencode").selfUpdateTool),
  },
  copilot: {
    label: terminalSpec("copilot").label,
    binaries: terminalSpec("copilot").binaries,
    tools: terminalSpec("copilot").tools,
    resolve: () => acpCli("copilot", terminalSpec("copilot").selfUpdateTool),
  },
  cursor: {
    label: terminalSpec("cursor").label,
    // `agent` is the legacy name of the same launcher.
    binaries: terminalSpec("cursor").binaries,
    tools: terminalSpec("cursor").tools,
    resolve: cursorCli,
  },
  droid: {
    label: terminalSpec("droid").label,
    binaries: terminalSpec("droid").binaries,
    tools: terminalSpec("droid").tools,
    resolve: () => {
      const resolved = resolveDroidExecutable();
      return resolved.source === "fallback-command" ? null : nativeCli("droid", resolved.path, terminalSpec("droid").selfUpdateTool);
    },
  },
  pi: {
    label: terminalSpec("pi").label,
    binaries: terminalSpec("pi").binaries,
    tools: terminalSpec("pi").tools,
    resolve: piCli,
  },
  qwen: {
    label: terminalSpec("qwen").label,
    binaries: terminalSpec("qwen").binaries,
    tools: terminalSpec("qwen").tools,
    resolve: () => acpCli("qwen", terminalSpec("qwen").selfUpdateTool),
  },
  kimi: {
    label: terminalSpec("kimi").label,
    binaries: terminalSpec("kimi").binaries,
    tools: terminalSpec("kimi").tools,
    resolve: () => acpCli("kimi", terminalSpec("kimi").selfUpdateTool),
  },
  grok: {
    label: terminalSpec("grok").label,
    binaries: terminalSpec("grok").binaries,
    tools: terminalSpec("grok").tools,
    // Grok reads the flag before its subcommand, so it leads.
    resolve: () => acpCli("grok", terminalSpec("grok").selfUpdateTool, [...(terminalSpec("grok").selfUpdateArgs ?? [])]),
  },
  devin: {
    label: terminalSpec("devin").label,
    binaries: terminalSpec("devin").binaries,
    tools: terminalSpec("devin").tools,
    resolve: () => acpCli("devin", terminalSpec("devin").selfUpdateTool),
  },
  muse: {
    label: terminalSpec("muse").label,
    binaries: terminalSpec("muse").binaries,
    tools: terminalSpec("muse").tools,
    resolve: () => nativeCli("muse", resolveMuseExecutable().path, terminalSpec("muse").selfUpdateTool),
  },
};

export const PINNED_CLI_PROVIDERS = Object.keys(PROVIDER_CLIS) as PinnedCliProvider[];

/** The command words that name `provider`'s CLI in a launch line (`cursor-agent`, `agent`, ...). */
export function pinnedCliBinaries(provider: PinnedCliProvider): readonly string[] {
  return PROVIDER_CLIS[provider].binaries;
}

/**
 * The provider whose CLI a terminal of this tool type runs, or null for a
 * shell (whose startup command names it, if anything does) and every other
 * type.
 */
export function pinnedCliProviderForToolType(toolType: TerminalToolType | null | undefined): PinnedCliProvider | null {
  switch (toolType) {
    case "claude":
    case "claude-orchestrated":
    case "claude-chat":
      return "claude";
    case "codex":
    case "codex-orchestrated":
    case "codex-chat":
      return "codex";
    case "opencode":
    case "opencode-orchestrated":
    case "opencode-chat":
      return "opencode";
    case "cursor":
    case "cursor-cli":
      return "cursor";
    case "droid":
    case "droid-chat":
      return "droid";
    case "pi":
    case "pi-chat":
      return "pi";
    case "muse":
    case "muse-chat":
      return "muse";
    case "qwen":
    case "qwen-chat":
      return "qwen";
    case "kimi":
    case "kimi-chat":
      return "kimi";
    case "grok":
    case "grok-chat":
      return "grok";
    case "copilot":
    case "copilot-chat":
      return "copilot";
    case "devin":
    case "devin-chat":
      return "devin";
    default:
      return null;
  }
}

/** Variables every terminal running `provider`'s CLI gets, known before the copy is on disk. */
export function pinnedCliEnv(provider: PinnedCliProvider): Record<string, string> {
  if (provider === "cursor") return { CURSOR_INVOKED_AS: "cursor-agent" };
  const tool = PROVIDER_CLIS[provider].tools[0]!.tool;
  return pinnedToolSelfUpdateEnv(tool);
}

/** ADE's copy of `provider`'s CLI on this machine, or null. No download, no PATH. */
export function resolvePinnedProviderCli(provider: PinnedCliProvider): PinnedProviderCli | null {
  return PROVIDER_CLIS[provider].resolve();
}

/** Start or join the downloads a missing CLI needs; null when nothing would download. */
function startDownloads(provider: PinnedCliProvider): Promise<void> | null {
  if (provider === "muse") {
    // Muse keeps its own fetch (it predates the on-demand tracker).
    const resolution = resolveMuseExecutable();
    if (resolution.path || resolution.source === "unsupported") return null;
    return ensureMuseBinary().then(() => undefined, () => undefined);
  }
  const pending = PROVIDER_CLIS[provider].tools
    .map(({ tool }) => pinnedToolDownload(tool))
    .filter((download): download is NonNullable<typeof download> => download != null);
  return pending.length ? Promise.all(pending).then(() => undefined) : null;
}

/** The one sentence for a CLI that cannot run here. */
function blockerSentence(provider: PinnedCliProvider): string {
  if (provider === "muse") {
    return museBinaryBlocker(resolveMuseExecutable()) ?? "ADE could not start its Muse Code build on this machine.";
  }
  for (const { tool, label } of PROVIDER_CLIS[provider].tools) {
    const sentence = pinnedToolBlocker(label, getPinnedToolStatus(tool));
    if (sentence) return sentence;
  }
  return `ADE could not start its copy of ${PROVIDER_CLIS[provider].label} on this machine.`;
}

/**
 * Why `provider`'s CLI is not on this machine, for a surface that only reports
 * it (`ade triage`, `ade harness env`): downloading, not downloaded yet, a
 * failed download, or not available here. Null when ADE's copy is present.
 * Starts no download.
 */
export function pinnedProviderCliStateSentence(provider: PinnedCliProvider): string | null {
  if (resolvePinnedProviderCli(provider)) return null;
  if (provider === "muse") return blockerSentence(provider);
  for (const { tool, label } of PROVIDER_CLIS[provider].tools) {
    const status = getPinnedToolStatus(tool);
    if (status.state === "ready") continue;
    // Whether this process may download is beside the point here: another
    // ADE process (the app, the brain) downloads it on first use.
    if (status.state === "missing") return `ADE has not downloaded ${label} for this machine yet.`;
    return pinnedToolBlocker(label, status);
  }
  return blockerSentence(provider);
}

/**
 * Where `provider`'s CLI stands for a terminal about to run it: ready, being
 * downloaded now (this call starts or joins the download), or blocked with the
 * sentence to show. Ask again after `done`: a download can fail.
 */
export function pinnedProviderCliState(provider: PinnedCliProvider): PinnedProviderCliState {
  const label = PROVIDER_CLIS[provider].label;
  const cli = resolvePinnedProviderCli(provider);
  if (cli) return { kind: "ready", cli };
  const done = startDownloads(provider);
  if (done) return { kind: "downloading", label, done };
  return { kind: "blocked", label, message: blockerSentence(provider) };
}

/**
 * ADE's copy of `provider`'s CLI, waiting for its download when this machine
 * has none yet (`onDownload` runs only then). Throws the sentence for a copy
 * that cannot run here. Never a CLI from the PATH.
 */
export async function requirePinnedProviderCli(
  provider: PinnedCliProvider,
  onDownload?: (label: string) => void,
): Promise<PinnedProviderCli> {
  let state = pinnedProviderCliState(provider);
  if (state.kind === "downloading") {
    onDownload?.(state.label);
    await state.done;
    state = pinnedProviderCliState(provider);
  }
  if (state.kind === "ready") return state.cli;
  throw new Error(state.kind === "blocked" ? state.message : blockerSentence(provider));
}

/** The line a terminal shows while a CLI downloads. */
export function pinnedCliDownloadingLine(label: string): string {
  return `ADE is downloading ${label} for this machine. It starts here when the download finishes.`;
}
