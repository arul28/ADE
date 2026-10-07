/**
 * What ADE can say about one ACP provider CLI without opening a chat.
 *
 * Settings needs four facts that no status payload carries — where the binary
 * resolved from, which directory the CLI keeps its config in, what version it
 * is, and what the last auth probe concluded — plus, for the two vendors that
 * ship one, the output of their own `doctor` command.
 *
 * None of this runs on a status refresh: `--version` and `doctor` are process
 * spawns, and spawning four CLIs to draw a grid of tiles is the mistake
 * `acpAuthProbe`'s header warns about. This is called when a provider's detail
 * page opens, and again when someone presses "Run doctor".
 */

import type { AcpChatProvider, AgentChatEvent } from "../../../shared/types/chat";
import type { AcpProviderDiagnostics, AcpProviderUpdateInfo, AcpProviderUpdateResult } from "../../../shared/types/config";
import { spawnAsync } from "../shared/utils";
import { grokConfigHome } from "../shared/providerConfigHomes";
import { acpProbeConfigHome, getCachedAcpAuthProbe } from "./acpAuthProbe";
import { resolveAcpExecutable } from "./acpExecutables";
import {
  ACP_PROVIDER_VERSION_POLICY,
  decideAcpProviderUpdate,
  resolveAcpInstaller,
  runAcpProviderInstall,
  type AcpInstallerIo,
  type AcpSpawn,
} from "./acpProviderUpdate";

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
  /** Test seam for install-kind detection. */
  installerIo?: AcpInstallerIo;
};

export async function collectAcpProviderDiagnostics(
  args: CollectAcpProviderDiagnosticsArgs,
): Promise<AcpProviderDiagnostics> {
  const env = args.env ?? process.env;
  const run = args.run ?? spawnAsync;
  const executable = resolveAcpExecutable(args.provider, { env });
  // "fallback-command" means nothing was found and the bare name is a guess, so
  // reporting it as a path would be a claim ADE cannot make.
  const binaryPath = executable.source === "fallback-command" ? null : executable.path;
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
    return { ...base, versionError: `\`${args.provider}\` was not found on this machine.` };
  }

  const version = await run(executable.path, ["--version"], {
    timeout: VERSION_TIMEOUT_MS,
    cwd: args.cwd,
  });
  const versionLine = version.status === 0 ? firstVersionLine(version.stdout, version.stderr) : null;
  const result: AcpProviderDiagnostics = {
    ...base,
    version: versionLine,
    versionError: versionLine
      ? null
      : firstVersionLine(version.stderr, version.stdout) ?? "The CLI did not report a version.",
  };
  result.update = versionLine
    ? decideAcpProviderUpdate({
      provider: args.provider,
      versionLine,
      installer: resolveAcpInstaller(args.provider, binaryPath, args.installerIo),
    })
    : null;

  const doctorArgs = DOCTOR_COMMANDS[args.provider];
  if (!args.runDoctor || !doctorArgs) return result;

  const doctor = await run(executable.path, [...doctorArgs], {
    timeout: DOCTOR_TIMEOUT_MS,
    maxOutputBytes: DOCTOR_MAX_OUTPUT_BYTES,
    cwd: args.cwd,
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
 * The version standing of the CLI a chat is about to use, read once per binary.
 *
 * A chat start pays one `--version` spawn the first time a binary is seen; every
 * later chat reuses the answer until an update through ADE clears it. Never
 * rejects: an unreadable version is `null`, which raises no warning.
 */
const launchStandingCache = new Map<string, Promise<AcpProviderUpdateInfo | null>>();

export function readAcpProviderLaunchStanding(args: {
  provider: AcpChatProvider;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  run?: typeof spawnAsync;
}): Promise<AcpProviderUpdateInfo | null> {
  const env = args.env ?? process.env;
  const executable = resolveAcpExecutable(args.provider, { env });
  if (executable.source === "fallback-command") return Promise.resolve(null);
  const key = `${args.provider}\0${executable.path}`;
  const cached = launchStandingCache.get(key);
  if (cached) return cached;
  const run = args.run ?? spawnAsync;
  const pending = run(executable.path, ["--version"], { timeout: VERSION_TIMEOUT_MS, cwd: args.cwd })
    .then((version) => {
      const versionLine = version.status === 0 ? firstVersionLine(version.stdout, version.stderr) : null;
      if (!versionLine) return null;
      return decideAcpProviderUpdate({
        provider: args.provider,
        versionLine,
        installer: resolveAcpInstaller(args.provider, executable.path),
      });
    })
    .catch(() => null);
  launchStandingCache.set(key, pending);
  return pending;
}

/** The chat warning for a CLI older than ADE supports, or null when none is due. */
export function acpProviderOutdatedNotice(
  provider: AcpChatProvider,
  info: AcpProviderUpdateInfo | null,
): AgentChatEvent | null {
  if (!info || info.standing !== "below" || !info.installedVersion) return null;
  const label = ACP_PROVIDER_VERSION_POLICY[provider].label;
  return {
    type: "system_notice",
    noticeKind: "warning",
    severity: "warning",
    status: "acp_provider_outdated",
    message: `${label} ${info.installedVersion} is older than ADE supports. Update to ${info.targetVersion}.`,
    detail: {
      providerUpdate: {
        provider,
        installedVersion: info.installedVersion,
        targetVersion: info.targetVersion,
        canUpdate: info.canUpdate,
        note: info.note,
      },
    },
  };
}

/**
 * Install the newest tested version of one provider CLI.
 *
 * It re-resolves the binary and refuses when the installer is unknown, so the
 * renderer's button can never run a guess. Grok runs with its config home in
 * `GROK_HOME`, so a custom home updates itself rather than the default `~/.grok`.
 */
export async function runAcpProviderUpdate(args: {
  provider: AcpChatProvider;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam, same contract as `AcpSpawn`. */
  run?: AcpSpawn;
  installerIo?: AcpInstallerIo;
}): Promise<AcpProviderUpdateResult> {
  const policy = ACP_PROVIDER_VERSION_POLICY[args.provider];
  if (!policy) {
    return { ok: false, message: `Updates are not supported for ${args.provider}.`, version: null };
  }
  const env = { ...(args.env ?? process.env) };
  const executable = resolveAcpExecutable(args.provider, { env });
  if (executable.source === "fallback-command") {
    return { ok: false, message: `${policy.label} was not found on this machine.`, version: null };
  }
  const installer = resolveAcpInstaller(args.provider, executable.path, args.installerIo);
  if (!installer) {
    return {
      ok: false,
      message: `ADE could not tell how this ${policy.label} was installed. Update it with the installer you used.`,
      version: null,
    };
  }
  if (args.provider === "grok") {
    const home = configHomeFor("grok", env);
    if (home) env.GROK_HOME = home;
  }
  const result = await runAcpProviderInstall({
    provider: args.provider,
    installer,
    env,
    cwd: args.cwd,
    ...(args.run ? { run: args.run } : {}),
    ...(args.installerIo ? { io: args.installerIo } : {}),
  });
  if (result.ok) launchStandingCache.delete(`${args.provider}\0${executable.path}`);
  return result;
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
  if (diagnostics.update) {
    const versionIndex = lines.findIndex((line) => line.startsWith("version:"));
    const { testedRange, standing, updateAvailable, installer } = diagnostics.update;
    const updateLine = `tested: ${testedRange.min} to ${testedRange.max} (${standing},`
      + ` update available: ${updateAvailable ? "yes" : "no"},`
      + ` installer: ${installer ?? "unknown"})`;
    lines.splice(versionIndex + 1, 0, updateLine);
  }
  if (diagnostics.doctor) {
    lines.push(
      "",
      `$ ${diagnostics.doctor.command}  (exit ${diagnostics.doctor.exitCode ?? "none"})`,
      diagnostics.doctor.output,
    );
  }
  return lines.join("\n");
}
