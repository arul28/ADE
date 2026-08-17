import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  tailLogText,
  type DiagnosticLogTail,
  type DiagnosticVolumeSpace,
} from "../services/diagnostics/diagnosticReport";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { resolveWindowsSupervisorLogPath } from "../serviceManager/installWindows";

/**
 * Headless counterpart to the desktop "Report issue" button. Reads only local
 * files — it never starts or contacts the brain — so it still works on the
 * machine where ADE itself will not come up, and on Windows where there is no
 * desktop error screen to press.
 */

export type ReportIssueOptions = {
  surface?: string;
  projectRoot?: string | null;
  cliVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type ReportIssueResult = {
  report: string;
  issueUrl: string;
  installId: string;
};

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readLogTail(label: string, filePath: string): DiagnosticLogTail {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { label, path: filePath, error: "(not a file)" };
    const readBytes = Math.min(stat.size, 512 * 1024);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(handle, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      return { label, path: filePath, text: tailLogText(buffer.toString("utf8")) };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return { label, path: filePath, error: code === "ENOENT" ? "(not present)" : "(could not be read)" };
  }
}

function readVolume(label: string, dirPath: string): DiagnosticVolumeSpace | null {
  try {
    const stats = fs.statfsSync(dirPath, { bigint: true });
    return {
      label,
      path: dirPath,
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    };
  } catch {
    return null;
  }
}

/** The same PostHog `distinct_id` the desktop reports, read without writing. */
function readInstallId(secretsDir: string): string | null {
  const state = readJsonFile(path.join(secretsDir, "product-analytics.json"));
  if (!state || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  for (const key of ["identifiedUserHash", "anonymousId", "installationId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function buildCliDiagnosticReport(options: ReportIssueOptions = {}): ReportIssueResult {
  const env = options.env ?? process.env;
  const at = options.now?.() ?? new Date();
  const layout = resolveMachineAdeLayout(env);
  const projectRoot = options.projectRoot?.trim() || null;
  const surface = options.surface?.trim() || "cli";

  const logs: DiagnosticLogTail[] = [];
  if (process.platform === "win32") {
    logs.push(readLogTail("Background service supervisor", resolveWindowsSupervisorLogPath({ env })));
  } else {
    logs.push(readLogTail("Background service (stderr)", path.join(layout.runtimeDir, "launchd.err.log")));
  }
  logs.push(readLogTail("Brain", path.join(layout.runtimeDir, "brain.jsonl")));
  if (projectRoot) {
    logs.push(readLogTail("ADE CLI", path.join(projectRoot, ".ade", "transcripts", "logs", "ade-cli.jsonl")));
  }

  const installId = readInstallId(layout.secretsDir) ?? "unknown";

  const report = buildDiagnosticReport({
    generatedAt: at.toISOString(),
    app: {
      version: options.cliVersion ?? null,
      packageChannel: env.ADE_PACKAGE_CHANNEL?.trim() || null,
      isPackaged: null,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      nodeVersion: process.versions.node ?? null,
      timezoneOffsetMinutes: -at.getTimezoneOffset(),
    },
    identity: { installId },
    context: {
      surface,
      headline: null,
      code: null,
      technicalDetail: null,
      projectRoot,
    },
    state: {
      machineLastFailure: readJsonFile(path.join(layout.runtimeDir, "last-failure.json")),
      projectLastFailure: projectRoot
        ? readJsonFile(path.join(projectRoot, ".ade", "runtime", "last-failure.json"))
        : null,
      lastWedge: readJsonFile(path.join(layout.runtimeDir, "last-wedge.json")),
    },
    storage: [
      readVolume("ADE home", layout.adeDir),
      projectRoot ? readVolume("Project", projectRoot) : null,
    ].filter((entry): entry is DiagnosticVolumeSpace => entry != null),
    logs,
    notes: ["doctor: not run (the report is collected without starting the background service)"],
    redaction: {
      homeDir: os.homedir(),
      username: os.userInfo().username,
      hostname: os.hostname(),
      projectRoots: projectRoot ? [projectRoot] : [],
    },
  });

  return {
    report,
    installId,
    issueUrl: buildDiagnosticIssueUrl({
      surface,
      appVersion: options.cliVersion ?? null,
      platform: process.platform,
      arch: process.arch,
      installId,
    }),
  };
}
