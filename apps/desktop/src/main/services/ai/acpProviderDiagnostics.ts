/**
 * What ADE can say about one ACP provider CLI without opening a chat.
 *
 * Settings needs four facts that no status payload carries — where ADE's
 * pinned copy resolved from, which directory the CLI keeps its config in, what
 * version it reports, and what the last auth probe concluded — plus, for the
 * two vendors that ship one, the output of their own `doctor` command. ADE
 * picks the version (the tools-cache pin), so nothing here offers an update.
 *
 * None of this runs on a status refresh: `--version` and `doctor` are process
 * spawns, and spawning four CLIs to draw a grid of tiles is the mistake
 * `acpAuthProbe`'s header warns about. This is called when a provider's detail
 * page opens, and again when someone presses "Run doctor".
 */

import type { AcpChatProvider } from "../../../shared/types/chat";
import type { AcpProviderDiagnostics } from "../../../shared/types/config";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { spawnAsync } from "../shared/utils";
import { grokConfigHome } from "../shared/providerConfigHomes";
import { acpProbeConfigHome, getCachedAcpAuthProbe } from "./acpAuthProbe";
import { resolveAcpExecutable } from "./acpExecutables";
import { pinnedToolForProvider, pinnedToolState } from "./pinnedProviderTools";

const VERSION_TIMEOUT_MS = 6_000;
const DOCTOR_TIMEOUT_MS = 25_000;
const DOCTOR_MAX_OUTPUT_BYTES = 20_000;

/**
 * Which providers ship a `doctor` subcommand.
 *
 * Qwen and Copilot have none. Offering the button anyway would run their
 * argument as a prompt, which is the failure mode the slash-command allowlist
 * exists to prevent — so the capability is declared, not guessed.
 */
const DOCTOR_COMMANDS: Partial<Record<AcpChatProvider, readonly string[]>> = {
  grok: ["doctor"],
  kimi: ["doctor"],
};

export function acpProviderSupportsDoctor(provider: AcpChatProvider): boolean {
  return DOCTOR_COMMANDS[provider] != null;
}

/** Config directory each CLI reads, including Grok's `GROK_HOME` override. */
function configHomeFor(provider: AcpChatProvider, env: NodeJS.ProcessEnv): string {
  return provider === "grok" ? grokConfigHome({ env }) : acpProbeConfigHome(provider, env) ?? "";
}

/**
 * First line of `--version` output.
 *
 * CLIs print anything from `1.0.14` to a banner with an update notice, so the
 * first non-empty line is taken and the rest dropped rather than parsed.
 */
function firstVersionLine(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length) return trimmed.slice(0, 120);
  }
  return null;
}

export type CollectAcpProviderDiagnosticsArgs = {
  provider: AcpChatProvider;
  /** Working directory the probe cache is keyed by. A lane worktree or the project root. */
  cwd: string;
  /** Also run the vendor's `doctor`. Off by default — it is the slow half. */
  runDoctor?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam. Same contract as `spawnAsync`: resolves, never rejects. */
  run?: typeof spawnAsync;
};

/** Why there is no binary to ask: the pinned tool's download state, in the sentence status rows use. */
function missingBinaryReason(provider: AcpChatProvider): string {
  const pinned = pinnedToolForProvider(provider);
  const blocker = pinned ? pinnedToolState(pinned.tool, pinned.label).blocker : null;
  return blocker ?? `ADE's copy of \`${provider}\` is not on this machine.`;
}

export async function collectAcpProviderDiagnostics(
  args: CollectAcpProviderDiagnosticsArgs,
): Promise<AcpProviderDiagnostics> {
  const env = args.env ?? process.env;
  const run = args.run ?? spawnAsync;
  const executable = resolveAcpExecutable(args.provider, { env });
  // A miss resolves to an empty path; never spawn it (it would not be ADE's copy).
  const binaryPath = executable.source === "fallback-command" || !executable.path ? null : executable.path;
  const probe = getCachedAcpAuthProbe(args.provider, args.cwd);

  const base: AcpProviderDiagnostics = {
    provider: args.provider,
    binaryPath,
    binarySource: executable.source,
    configHome: configHomeFor(args.provider, env) || null,
    version: null,
    versionError: null,
    lastProbe: probe
      ? { state: probe.state, message: probe.message }
      : null,
    doctor: null,
    checkedAt: new Date().toISOString(),
  };

  if (!binaryPath) {
    return { ...base, versionError: missingBinaryReason(args.provider) };
  }

  // Antigravity's server has no `--version`: any argv starts the server,
  // which unpacks itself into the temp directory. The version is the pin's.
  if (args.provider === "antigravity") {
    const pinned = pinnedToolForProvider(args.provider);
    const status = pinned ? pinnedToolState(pinned.tool, pinned.label).status : null;
    const pinnedVersion = status?.runningVersion ?? status?.version ?? null;
    return {
      ...base,
      version: pinnedVersion ? `agy_acp_server ${pinnedVersion} (ADE's pinned copy)` : null,
      versionError: pinnedVersion ? null : "ADE could not read its Antigravity version.",
    };
  }

  // Qwen's entry is its bundled Node, so its script leads every argv.
  const leadingArgs = executable.args ?? [];
  const spawnEnv = { ...env, ...providerSelfUpdateEnv(args.provider) };
  const version = await run(binaryPath, [...leadingArgs, "--version"], {
    timeout: VERSION_TIMEOUT_MS,
    cwd: args.cwd,
    env: spawnEnv,
  });
  const versionLine = version.status === 0 ? firstVersionLine(version.stdout, version.stderr) : null;
  const result: AcpProviderDiagnostics = {
    ...base,
    version: versionLine,
    versionError: versionLine
      ? null
      : firstVersionLine(version.stderr, version.stdout) ?? "The CLI did not report a version.",
  };

  const doctorArgs = DOCTOR_COMMANDS[args.provider];
  if (!args.runDoctor || !doctorArgs) return result;

  const doctor = await run(binaryPath, [...leadingArgs, ...doctorArgs], {
    timeout: DOCTOR_TIMEOUT_MS,
    maxOutputBytes: DOCTOR_MAX_OUTPUT_BYTES,
    cwd: args.cwd,
    env: spawnEnv,
  });
  const output = `${doctor.stdout}${doctor.stderr}`.trim();
  return {
    ...result,
    doctor: {
      command: `${args.provider} ${doctorArgs.join(" ")}`,
      exitCode: doctor.status,
      output: output.length
        ? output
        : doctor.status === null
          ? "No output — the command timed out or could not start."
          : "No output.",
    },
  };
}

/**
 * The copyable diagnostic report for one provider.
 *
 * Plain text on purpose: it is pasted into a GitHub issue, and every line has
 * to survive that trip. Absent facts say "unknown" rather than disappearing —
 * a missing line reads as "not checked", which is a different claim.
 */
export function formatAcpProviderDiagnosticsReport(
  diagnostics: AcpProviderDiagnostics,
  extra?: { status?: string | null },
): string {
  const lines = [
    `provider: ${diagnostics.provider}`,
    `status: ${extra?.status?.trim() || "unknown"}`,
    `version: ${diagnostics.version ?? `unknown (${diagnostics.versionError ?? "no detail"})`}`,
    `binary: ${diagnostics.binaryPath ?? "not found"} (${diagnostics.binarySource})`,
    `config home: ${diagnostics.configHome ?? "n/a"}`,
    `last auth probe: ${diagnostics.lastProbe
      ? `${diagnostics.lastProbe.state}${diagnostics.lastProbe.message ? ` — ${diagnostics.lastProbe.message}` : ""}`
      : "not run"}`,
    `checked at: ${diagnostics.checkedAt}`,
  ];
  if (diagnostics.doctor) {
    lines.push(
      "",
      `$ ${diagnostics.doctor.command}  (exit ${diagnostics.doctor.exitCode ?? "none"})`,
      diagnostics.doctor.output,
    );
  }
  return lines.join("\n");
}
