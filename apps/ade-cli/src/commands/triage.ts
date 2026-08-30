import os from "node:os";
import path from "node:path";

import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { diagnosticRedactionContext } from "../services/diagnostics/diagnosticSources";
import type { DiagnosticRedactionContext } from "../services/diagnostics/diagnosticReport";
import type { DoctorCommandResult } from "./doctor";
import { buildCliDiagnosticReportAsync, type ReportIssueResult } from "./reportIssue";
import {
  buildTriageContext,
  buildTriagePrompt,
  createTriageBundleDir,
  writeTriageBundle,
  TRIAGE_PLAYBOOK_FILE_NAME,
} from "./triageContext";
import {
  buildTriageLaunchPlan,
  describeTriageProviders,
  detectTriageProviders,
  spawnTriageAgent,
  triageLaunchNotice,
  TRIAGE_PROVIDERS,
  type DetectedTriageProvider,
  type TriageAgentSpawner,
  type TriageProviderName,
} from "./triageLaunch";
import {
  embeddedTriagePlaybook,
  resolveTriagePlaybook,
  type TriagePlaybook,
  type TriagePlaybookSource,
} from "./triagePlaybook";

/**
 * `ade triage` — hand a broken install to the user's own coding agent.
 *
 * `ade doctor` says which check failed and `ade report-issue` produces something
 * to file. Neither fixes anything, and the person staring at either one is
 * usually the person least able to act on it. This command builds the two files
 * an agent needs — a redacted machine context and a maintained playbook — and
 * then gets out of the way: it launches whichever agent CLI is installed and
 * lets the user talk to it directly, or, with `--agent`, prints the paths for an
 * agent that is already running (an ADE Work chat, say) to pick up.
 *
 * Everything here is deliberately CLI-only and brain-free. The machine this runs
 * on is the machine where ADE will not come up, so nothing may depend on the
 * brain answering, and there is no desktop/TUI/iOS surface to mirror: those
 * clients cannot help when the thing that hosts them is down.
 *
 * The pieces live next door: `triagePlaybook.ts` resolves the playbook,
 * `triageContext.ts` assembles and writes the two files, `triageLaunch.ts`
 * detects and starts the agent. This file only sequences them.
 */

// Re-exported for `cli.ts`, which is the only non-test consumer of this module.
export { parseTriageProviderName } from "./triageLaunch";
export type { TriageProviderName } from "./triageLaunch";
export { TRIAGE_NO_FETCH_ENV } from "./triagePlaybook";
export { TriageCommandError, TriageUsageError } from "./triageErrors";

export type TriageMode = "agent" | "launch" | "no-provider";

export type TriagePayload = {
  ok: boolean;
  mode: TriageMode;
  contextPath: string;
  playbookPath: string;
  playbookSource: TriagePlaybookSource;
  playbookOrigin: string;
  suggestedPrompt: string;
  providers: Array<{ name: TriageProviderName; label: string; path: string }>;
  launched: { provider: TriageProviderName; label: string; promptDelivered: boolean } | null;
  message: string;
};

export type TriageCommandOptions = {
  /** `--agent`: print the handoff, launch nothing. */
  agent: boolean;
  /** `--provider <name>`: override the detection order. */
  provider: TriageProviderName | null;
};

export type TriageCommandDependencies = {
  /** Runs the doctor checks. A rejection is recorded, not fatal. */
  runDoctor: () => Promise<DoctorCommandResult>;
  cliVersion: string | null;
  projectRoot: string | null;
  buildReport?: () => Promise<ReportIssueResult>;
  resolvePlaybook?: () => Promise<TriagePlaybook>;
  detectProviders?: () => DetectedTriageProvider[];
  spawnAgent?: TriageAgentSpawner;
  /**
   * Where the pre-launch notice goes. stderr by default: the agent takes over
   * stdout the moment it starts, and this is the only chance to say where the
   * files are.
   */
  writeNotice?: (text: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
  platform?: NodeJS.Platform;
};

export function formatTriageText(payload: TriagePayload): string {
  const lines = [
    payload.message,
    "",
    `context:  ${payload.contextPath}`,
    `playbook: ${payload.playbookPath}  (${payload.playbookSource}: ${payload.playbookOrigin})`,
    `agents:   ${payload.providers.length === 0
      ? "none found on PATH"
      : payload.providers.map((provider) => provider.name).join(", ")}`,
  ];
  if (payload.mode !== "launch") {
    lines.push("", "Prompt:", "", payload.suggestedPrompt, "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Every collector this command runs is allowed to fail.
 *
 * The doctor probe talks to a brain that may be hung, the report reads files on
 * a disk that may be full, and the layout resolver reads an `ADE_HOME` that may
 * be unset or unreadable — on this machine, by definition, something is broken.
 * A rejection becomes a section in `context.md` saying so, because the handoff
 * is the product: an agent with a partial context can still work, an agent that
 * never got a context cannot.
 */
async function settle<T>(work: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await work, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function settleSync<T>(work: () => T): { value: T | null; error: string | null } {
  try {
    return { value: work(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runTriageCommand(
  options: TriageCommandOptions,
  dependencies: TriageCommandDependencies,
): Promise<{ payload: TriagePayload; exitCode: number }> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const now = dependencies.now ?? (() => new Date());
  const generatedAt = now();

  const buildReport = dependencies.buildReport
    ?? (() => buildCliDiagnosticReportAsync({
      surface: "cli-triage",
      projectRoot: dependencies.projectRoot,
      cliVersion: dependencies.cliVersion,
      env,
      now,
    }));
  const resolvePlaybook = dependencies.resolvePlaybook ?? (() => resolveTriagePlaybook({ env }));
  const detectProviders = dependencies.detectProviders ?? (() => detectTriageProviders({ env }));

  // The doctor probe talks to the brain and the report reads local files; the
  // playbook fetch is network. None of them need each other, and the brain is
  // exactly what may be hanging, so they run together rather than in series.
  const [doctorResult, reportResult, playbookResult] = await Promise.all([
    settle(dependencies.runDoctor()),
    settle(buildReport()),
    settle(resolvePlaybook()),
  ]);
  // `resolveTriagePlaybook` already swallows fetch failures, but it also reads
  // the disk — the same disk that may be the reason triage is running — and an
  // unhandled rejection here would take the whole bundle down. The embedded
  // copy is the floor, and the context records that it is what the agent got.
  const playbook = playbookResult.value ?? embeddedTriagePlaybook();

  const layout = settleSync(() => resolveMachineAdeLayout(env, platform));
  // The report carries the redaction rules it was built with. Without it, they
  // are derived here instead — a failed collection must not turn the context
  // file into the one unredacted copy of this machine's paths and names.
  const redaction: DiagnosticRedactionContext = reportResult.value?.redaction
    ?? diagnosticRedactionContext(dependencies.projectRoot);

  const dir = createTriageBundleDir(generatedAt, dependencies.tmpRoot);
  const playbookPath = path.join(dir, TRIAGE_PLAYBOOK_FILE_NAME);
  const context = buildTriageContext({
    generatedAt,
    cliVersion: dependencies.cliVersion,
    platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.versions.node ?? null,
    projectRoot: dependencies.projectRoot,
    adeHome: layout.value?.adeDir ?? null,
    socketPath: layout.value?.socketPath ?? null,
    layoutError: layout.error,
    doctor: doctorResult.value,
    doctorError: doctorResult.error,
    report: reportResult.value?.report ?? "",
    reportError: reportResult.error,
    redaction,
    playbook: { source: playbook.source, origin: playbook.origin, path: playbookPath },
  });
  const bundle = writeTriageBundle({ dir, context, playbook });
  const suggestedPrompt = buildTriagePrompt({
    contextPath: bundle.contextPath,
    playbookPath: bundle.playbookPath,
  });

  const detected = detectProviders();
  const providers = detected.map((provider) => ({
    name: provider.name,
    label: provider.label,
    path: provider.path,
  }));

  const base: Omit<TriagePayload, "mode" | "message" | "launched"> = {
    ok: true,
    contextPath: bundle.contextPath,
    playbookPath: bundle.playbookPath,
    playbookSource: bundle.playbookSource,
    playbookOrigin: bundle.playbookOrigin,
    suggestedPrompt,
    providers,
  };

  if (options.agent) {
    return {
      payload: {
        ...base,
        mode: "agent",
        launched: null,
        message:
          "Triage context ready. Read the playbook, then the context, then follow the prompt below.",
      },
      exitCode: 0,
    };
  }

  const chosen = options.provider
    ? detected.find((provider) => provider.name === options.provider) ?? null
    : detected[0] ?? null;

  if (!chosen) {
    // Requirement of this command, not an accident: a machine with no agent CLI
    // still gets the handoff, and exits 0. The files are the deliverable; the
    // launch is a convenience.
    const message = options.provider
      ? `${options.provider} is not installed on this machine. Everything an agent needs is written out — paste the prompt below into whatever agent you do have.`
      : `No agent CLI found (looked for ${TRIAGE_PROVIDERS.map((p) => p.name).join(", ")}). Everything an agent needs is written out — paste the prompt below into whatever agent you do have.`;
    return {
      payload: { ...base, mode: "no-provider", launched: null, message },
      exitCode: 0,
    };
  }

  const plan = buildTriageLaunchPlan(chosen, suggestedPrompt, env, platform);
  const writeNotice = dependencies.writeNotice
    ?? ((text: string) => {
      process.stderr.write(text);
    });
  writeNotice(triageLaunchNotice(bundle, plan, suggestedPrompt));
  const spawnAgent = dependencies.spawnAgent ?? spawnTriageAgent;
  const exitCode = await spawnAgent(plan);
  return {
    payload: {
      ...base,
      mode: "launch",
      launched: { provider: chosen.name, label: chosen.label, promptDelivered: plan.promptDelivered },
      message: `Handed triage to ${chosen.label} (${describeTriageProviders(detected)} available).`,
    },
    exitCode,
  };
}
