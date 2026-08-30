import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  redactDiagnosticText,
  type DiagnosticRedactionContext,
} from "../services/diagnostics/diagnosticReport";
import type { DoctorCommandResult, DoctorRow } from "./doctor";
import { TriageCommandError } from "./triageErrors";
import type { TriagePlaybook, TriagePlaybookSource } from "./triagePlaybook";

/**
 * The two files `ade triage` writes, and the prompt that points at them.
 *
 * Everything here assembles markdown from already-collected material; nothing
 * here probes the machine. The collectors run in the command orchestrator, and
 * every one of them is allowed to fail — a section saying "this could not be
 * collected" is worth more than a command that dies on the broken machine it
 * exists for.
 */

/** Failures first, then warnings, then the rows that are fine. */
export function orderTriageDoctorRows(rows: readonly DoctorRow[]): DoctorRow[] {
  const rank = (row: DoctorRow): number =>
    row.status === "fail" ? 0 : row.status === "warn" ? 1 : 2;
  return [...rows].sort((left, right) => rank(left) - rank(right));
}

const ERROR_LINE_PATTERN =
  /\b(error|fatal|panic|exception|traceback|denied|refused|unauthorized|forbidden|timed? ?out|corrupt|malformed|locked|EACCES|EPERM|ENOENT|EADDRINUSE|EDEADLK|ECONNREFUSED|ENOSPC)\b/i;

/**
 * The lines an agent should read first, pulled out of the already-redacted
 * report so this cannot become a second, unredacted path for the same bytes.
 */
export function extractRecentErrorLines(reportText: string, limit = 40): string[] {
  const matches: string[] = [];
  for (const rawLine of reportText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("|")) continue;
    if (line.length > 500) continue;
    if (!ERROR_LINE_PATTERN.test(line)) continue;
    matches.push(line);
  }
  return matches.slice(-limit);
}

export type TriageContextInput = {
  generatedAt: Date;
  cliVersion: string | null;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  nodeVersion: string | null;
  projectRoot: string | null;
  /** Null when the ADE layout could not be resolved; see `layoutError`. */
  adeHome: string | null;
  socketPath: string | null;
  /** Why the ADE home/socket paths are missing, if they are. */
  layoutError: string | null;
  doctor: DoctorCommandResult | null;
  doctorError: string | null;
  report: string;
  /** Why the diagnostic report is missing, if it is. */
  reportError: string | null;
  redaction: DiagnosticRedactionContext;
  playbook: { source: TriagePlaybookSource; origin: string; path: string };
};

function bullet(label: string, value: unknown): string {
  const text = value == null || value === "" ? "unknown" : String(value);
  return `- ${label}: ${text}`;
}

function describeBrain(doctor: DoctorCommandResult | null): string[] {
  if (!doctor) return ["- brain: not probed (ade doctor did not run — see the error above)"];
  const brain = doctor.brain;
  return [
    bullet("responding", brain.running ? "yes" : "no"),
    bullet("starting", brain.starting === true ? `yes (${brain.startingAgeMs ?? "?"} ms old)` : "no"),
    bullet("version", brain.version),
    bullet("build hash", brain.buildHash),
    bullet("pid", brain.pid),
    bullet("uptime ms", brain.uptimeMs),
    bullet("build mismatch", brain.mismatchReason ?? "none"),
    bullet("error", brain.error ?? "none"),
    bullet("sync port", doctor.syncPort),
  ];
}

/**
 * The whole file is passed through {@link redactDiagnosticText} on the way out,
 * for the same reason the diagnostic report is: a section added later cannot
 * leak by forgetting to call it. The pass is idempotent, so the embedded report
 * — already redacted by its own builder — is unchanged by it. Collection error
 * messages ride the same pass, which is why they are written into the document
 * rather than printed raw.
 */
export function buildTriageContext(input: TriageContextInput): string {
  const doctorRows = input.doctor ? orderTriageDoctorRows(input.doctor.rows) : [];
  const failing = doctorRows.filter((row) => row.status === "fail");
  const lines: string[] = [
    "# ADE triage context",
    "",
    `Generated ${input.generatedAt.toISOString()} by \`ade triage\`.`,
    "",
    "This file is redacted: home directories, user and host names, emails, IP",
    "addresses and token-shaped strings have been replaced with placeholders.",
    "Keep it that way — do not paste unredacted logs into it, and do not print",
    "the contents of anything under the secrets directory.",
    "",
    `Playbook: ${input.playbook.path} (${input.playbook.source}, from ${input.playbook.origin})`,
    "",
    "## Install",
    "",
    bullet("ADE CLI version", input.cliVersion),
    bullet("desktop app version", input.doctor?.app.installedVersion ?? null),
    bullet("latest known desktop version", input.doctor?.app.latestKnownVersion ?? null),
    bullet("platform", `${input.platform} ${input.arch}`),
    bullet("OS release", input.osRelease),
    bullet("node", input.nodeVersion),
    bullet("ADE home", input.adeHome),
    bullet("brain endpoint", input.socketPath),
    bullet("project", input.projectRoot ?? "none open"),
    "",
  ];

  if (input.layoutError) {
    lines.push(
      `The ADE home and brain endpoint could not be resolved: ${input.layoutError}`,
      "",
      "That is itself a finding — an unreadable or unset ADE home explains most of",
      "what follows. Ask the user where their ADE home is before assuming a path.",
      "",
    );
  }

  lines.push("## Health checks (ade doctor)", "");

  if (input.doctorError) {
    lines.push(
      `\`ade doctor\` could not complete: ${input.doctorError}`,
      "",
      "Treat that as the first failure to explain — the checks below are missing,",
      "not passing.",
      "",
    );
  }
  if (doctorRows.length > 0) {
    lines.push(
      failing.length === 0
        ? "Overall: no failing rows."
        : `Overall: ${failing.length} failing row(s), listed first.`,
      "",
      "| check | status | detail |",
      "| --- | --- | --- |",
      ...doctorRows.map((row) =>
        `| ${row.label} | ${row.status} | ${row.detail.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`),
      "",
    );
  } else if (!input.doctorError) {
    lines.push("No health checks were returned.", "");
  }

  lines.push("## Brain", "", ...describeBrain(input.doctor), "");

  const errorLines = extractRecentErrorLines(input.report);
  lines.push("## Recent errors", "");
  if (errorLines.length === 0) {
    lines.push("No error-shaped lines were found in the collected logs.", "");
  } else {
    lines.push(
      "Pulled from the redacted diagnostic report below, most recent last.",
      "",
      "```",
      ...errorLines,
      "```",
      "",
    );
  }

  lines.push("## Full diagnostic report", "");
  if (input.reportError) {
    lines.push(
      `The diagnostic report could not be collected: ${input.reportError}`,
      "",
      "Nothing below it was gathered — no log tails, no service definition, no disk",
      "space. `ade report-issue --text` reproduces the same collection by hand and",
      "will fail the same way; that failure is a finding, not a detour.",
      "",
    );
  } else {
    lines.push(
      "The same redacted report `ade report-issue` prints: versions, service",
      "definition, log tails, disk space, and storage environment.",
      "",
      input.report.trimEnd(),
      "",
    );
  }

  return redactDiagnosticText(lines.join("\n"), input.redaction);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildTriagePrompt(args: { contextPath: string; playbookPath: string }): string {
  return [
    "My ADE install is broken and I need you to fix it on this machine.",
    "",
    `1. Read the playbook first: ${args.playbookPath}`,
    `2. Then read the machine context: ${args.contextPath}`,
    "",
    "Follow the playbook's safety rules exactly. In short: diagnose with the",
    "read-only commands first; never delete anything under ~/.ade, $ADE_HOME, or a",
    "project's .ade/ directory; never kill processes by name or pattern; prefer the",
    "`ade` command over the raw OS command; and tell me what you are about to run and",
    "what it changes before you run anything that mutates state.",
    "",
    "Start by telling me which doctor rows are failing and what you think the cause",
    "is, then propose the fix and wait for me to say go.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export const TRIAGE_CONTEXT_FILE_NAME = "context.md";
export const TRIAGE_PLAYBOOK_FILE_NAME = "PLAYBOOK.md";

/**
 * A fresh directory per run, named for the moment it was made.
 *
 * `mkdtemp` rather than a bare `mkdir` of the timestamp: the temp directory is
 * world-writable on POSIX, and a predictable name there is something another
 * user can create first as a symlink. The random suffix also means two runs in
 * the same second cannot collide.
 */
export function createTriageBundleDir(at: Date, tmpRoot: string = os.tmpdir()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  try {
    return fs.mkdtempSync(path.join(tmpRoot, `ade-triage-${stamp}-`));
  } catch (error) {
    // A full or read-only temp directory is a plausible state on exactly the
    // machine this command is for, and the raw errno with no path attached
    // would send the user hunting for the wrong disk.
    const detail = error instanceof Error ? error.message : String(error);
    throw new TriageCommandError(
      `Could not create a triage directory under ${tmpRoot}: ${detail}`,
    );
  }
}

export type TriageBundle = {
  dir: string;
  contextPath: string;
  playbookPath: string;
  playbookSource: TriagePlaybookSource;
  playbookOrigin: string;
};

export function writeTriageBundle(args: {
  dir: string;
  context: string;
  playbook: TriagePlaybook;
}): TriageBundle {
  const contextPath = path.join(args.dir, TRIAGE_CONTEXT_FILE_NAME);
  const playbookPath = path.join(args.dir, TRIAGE_PLAYBOOK_FILE_NAME);
  try {
    fs.writeFileSync(contextPath, args.context, "utf8");
    fs.writeFileSync(playbookPath, args.playbook.text, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TriageCommandError(`Could not write the triage files to ${args.dir}: ${detail}`);
  }
  return {
    dir: args.dir,
    contextPath,
    playbookPath,
    playbookSource: args.playbook.source,
    playbookOrigin: args.playbook.origin,
  };
}
